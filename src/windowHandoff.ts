// 标签拖出成新窗口的交接握手（V3.3 设计文档 §4.2 / §4.3）。
//
// 这个模块两侧都在：**旧窗口**用 tearOutTab() 发起交接，**新窗口**在模块加载时
// （App.tsx 顶层 side-effect 导入）挂上接管入口。两侧的代码放在同一个文件里是有意
// 为之——握手的事件名与载荷字段是一份契约，拆成两个文件必然出现"一边改了另一边
// 忘了"的漂移，而这里的漂移代价是用户一个正在运行的会话。
//
// ## 唯一的硬不变式
//
// **新窗口确认接管之后，旧窗口才移除自己的标签**（设计文档 §4.2 第 6 步）。顺序反了
// 会在新窗口创建失败时凭空吃掉用户一个正在跑的 claude 会话。任一步失败或超时：旧
// 窗口保留标签不动、关掉已经建出来的新窗口、给一条可见的轻提示。**绝不允许出现
// 「两个窗口都没有这个标签」的状态**。
//
// ## 六步（对应设计文档 §4.2）
//
//   1. 旧窗口序列化该标签每个窗格终端的滚屏（termSerialize.ts 的 serializeTerm）
//   2. 旧窗口调 create_term_window(x, y)（Task 1 的 Rust 命令），拿到新窗口 label
//   3. 新窗口启动、前端就绪后 emit 就绪事件，带自己的 label
//   4. 旧窗口收到就绪事件，emitTo(label, …) 定向发送接管载荷
//   5. 新窗口建标签与窗格、把滚屏排进待回放缓冲、绑定原 ptyId，然后 emitTo 回 ack
//   6. 旧窗口收到 ack 后移除该标签，**但不 kill PTY**
//
// ## 交接期间输出不会丢
//
// pty-output 是 app.emit 全应用广播（src-tauri/src/pty.rs:28），不是定向某个窗口。
// 新窗口的 ptyBuffer 从它自己的监听注册那一刻（ptyEventsReady）起就在攒这个 PTY 的
// 输出，attachPty 时连同交接过来的滚屏一起回放（见 ptyBuffer.ts 的 seedScrollback /
// attachPty）。交接期间两个窗口都收得到，这里不需要、也不该再造一份缓冲。
import { invoke } from '@tauri-apps/api/core'
import { emit, emitTo, listen } from '@tauri-apps/api/event'
import { ptyEventsReady, seedScrollback } from './ptyBuffer'
import { useHint } from './store/hint'
import { useSessions } from './store/sessions'
import { type AdoptedPane, type Tab, useTabs } from './store/tabs'
import { serializeTerm } from './termSerialize'

// ── 握手协议 ────────────────────────────────────────────────────────────────
// 事件名沿用仓库既有的 kebab-case 风格（'pty-output' / 'app-close-requested' /
// 'menu-open-settings'）。三个都以 term-window- 开头，一眼能看出属于同一次握手。

/** 新窗口 → 全体广播：「我起来了，可以接管了」。载荷 {@link HandoffReady}。
 *  用广播（emit）而不是 emitTo：新窗口并不知道是谁把它建出来的——它是被 Rust 侧
 *  create_term_window 建的，启动参数里没有发起方 label。发起方自己按 label 认领
 *  （见 tearOutTab 里的匹配），别的窗口收到不认识的 label 一律忽略。 */
export const HANDOFF_READY_EVENT = 'term-window-ready'

/** 旧窗口 → 新窗口（emitTo 定向）：接管载荷本身。载荷 {@link HandoffPayload}。 */
export const HANDOFF_EVENT = 'term-window-handoff'

/** 新窗口 → 旧窗口（emitTo 定向，目标取载荷里的 fromLabel）：接管确认。
 *  载荷 {@link HandoffAck}。 */
export const HANDOFF_ACK_EVENT = 'term-window-handoff-ack'

export type HandoffReady = { label: string }
export type HandoffAck = { label: string }

/** 交接载荷里的单个窗格。
 *
 *  规格 §4.2 第 4 步要求载荷至少含 ptyId / sessionId / 标题 / cwd / 序列化滚屏 /
 *  终端尺寸——这七项都在这里。**为什么是一个数组而不是七个平铺字段**：本仓库的一个
 *  标签最多可以持有 3 个窗格（MAX_PANES，⌘D 分屏），而拖出手势的对象是**标签**。若
 *  载荷只装得下一个终端，多窗格标签被拖出时旧窗口会整个移除标签、另外两个 PTY 就
 *  变成没有任何窗口能看到、也关不掉的孤儿进程——正是本任务最要避免的那类用户可见
 *  损失。因此按窗格成数组，单窗格标签就是长度为 1 的数组。
 *
 *  ptyId 可缺省：⌘D 新建后还没选定会话的空槽窗格本来就没有 PTY（见 store/tabs.ts
 *  的 Pane 类型），原样搬过去仍然是空槽，不该被悄悄丢掉。 */
export type HandoffPane = {
  ptyId?: string
  sessionId?: string
  title: string
  cwd: string | null
  scrollback: string
  cols: number
  rows: number
  threadKey?: string
  dirName?: string
  rootKey?: string
}

export type HandoffPayload = {
  /** 发起方（旧窗口）的 label，新窗口据此把 ack 定向发回去。 */
  fromLabel: string
  /** 接管方（新窗口）的 label，即 create_term_window 的返回值。ack 里原样回带，
   *  发起方用它认领"这是我等的那次 ack"。 */
  toLabel: string
  /** 交接前的焦点窗格在 panes 里的下标。 */
  activePaneIndex: number
  panes: HandoffPane[]
}

// ── 超时 ────────────────────────────────────────────────────────────────────
// 两档都取"绝不会在慢机器上误触发"这一侧：超时误触发的代价是把一次本来会成功的交接
// 判成失败、把新窗口关掉（用户看到标签留在原地、一条提示，得重来一次）；而等得久一点
// 的代价只是失败场景下提示晚几秒——标签全程留在旧窗口里、会话照常跑，拖拽手势本身
// 早在 pointerup 就结束了，界面不会卡住。所以两个数字都往宽了取。

/** 第 3 步（新窗口启动 → 前端就绪）的超时。10s：这一段包含原生窗口创建、WKWebView
 *  冷启动、整个前端 bundle 解析执行、React 挂载、以及 ptyEventsReady 那两次 listen
 *  的 IPC 往返——冷启动那一段在开发构建和低配机器上是秒级的。 */
export const READY_TIMEOUT_MS = 10_000

/** 第 5 步（发出载荷 → 收到接管确认）的超时。5s：新窗口此时已经就绪，剩下的只有
 *  一次 store 写入和一次 emitTo，正常是毫秒级；给到 5s 是留给"事件桥恰好排在一堆
 *  pty-output 后面"这类抖动，仍然比它实际需要的量级大得多。 */
export const ACK_TIMEOUT_MS = 5_000

/** 交接载荷里终端尺寸的取值。
 *
 *  **这两个是占位常量，不是实测的终端几何**。真实的 term.cols/term.rows 只存在于
 *  受保护文件 src/components/TerminalView.tsx 内部的局部变量里，本任务不得改动它，
 *  而现有的两个注册表（terminalPaste.ts 的 registerPaste、termSerialize.ts 的
 *  registerSerializer）都只暴露了各自那一个闭包，没有任何一处把尺寸透出来。
 *
 *  为什么这样仍然是安全的：新窗口的 TerminalView 挂载时会自己 fit() 一次并
 *  ptyResize(ptyId, term.cols, term.rows)（该文件既有逻辑），尺寸在一帧内就被校正成
 *  新窗口的真实几何。所以这两个字段目前只是载荷里的元数据，接管端**不会**拿它们去
 *  调 ptyResize——那反而会把 PTY 先按错误尺寸拧一次。取 80×24 是为了和
 *  store/tabs.ts 里 ptySpawn 的初始尺寸对齐，不引入第三个"凭空的"数字。
 *  （若以后要让它变成真值：在 TerminalView 里 registerSerializer 旁边多注册一个
 *  `() => ({ cols: term.cols, rows: term.rows })` 即可，是一行的事——但那是对受保护
 *  文件的改动，需要单独批准。） */
const HANDOFF_COLS = 80
const HANDOFF_ROWS = 24

// ── 窗口身份 ────────────────────────────────────────────────────────────────

/** 当前窗口的 label，模块加载时就开始解析、全模块共用这一份结果。
 *
 *  用 `await import(...)` 而不是顶层静态 import：`@tauri-apps/api/window` 与
 *  `@tauri-apps/api/webviewWindow` 这两个模块在本仓库里此前只出现在动态 import 里
 *  （store/layout.ts 的 runPanelResize、App.tsx 的 onDragDropEvent），从主 chunk 静态
 *  引它们会让 rollup 报 "dynamically imported by X but also statically imported by Y,
 *  dynamic import will not move module into another chunk"——基线的 `npm run build`
 *  是零警告的，不该由这个模块开这个头。
 *
 *  getCurrentWindow() 读的是 window.__TAURI_INTERNALS__.metadata，在 jsdom/浏览器
 *  预览里那个对象根本不存在、会同步抛 TypeError——这个模块是 App.tsx 的顶层
 *  side-effect 导入，抛出去会连累整个应用起不来，所以兜底成 'main'（"当作主窗口"是
 *  最保守的答案：主窗口不会去抢接管，见 isTornOutWindow）。 */
const currentLabel: Promise<string> = (async () => {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow().label
  } catch {
    return 'main'
  }
})()

export function currentWindowLabel(): Promise<string> {
  return currentLabel
}

/** 这个窗口是不是"被标签拖出创建的"。
 *
 *  **判定方式：label 前缀**（另一条可选路径是由 Rust 在创建时告知，例如往新窗口注入
 *  一个初始化状态或加个查询参数）。选前缀的理由：
 *    1. label 已经是既有契约，不是为这个判断新造的信息——create_term_window 的返回值
 *       就是 `term-<n>`（src-tauri/src/lib.rs 的 new_term_window_label），
 *       capabilities/default.json 的 windows 也已经写成 ["main", "term-*"]，同一个
 *       前缀在三处共同承载"这是拖出来的终端窗口"这一含义，再引入第二套标记只会多一
 *       处可以互相矛盾的真相来源；
 *    2. 它是**同步且零往返**的：新窗口必须先挂好接管监听、再 emit 就绪事件，中间多
 *       一次 invoke 往返就多一段"旧窗口已经在等、新窗口还没准备好"的窗口期；
 *    3. Rust 侧告知需要新增命令或窗口初始化脚本，本任务的改动面会扩到 lib.rs——那是
 *       Task 5/6 的地盘，跨任务改同一个文件是这次计划预检明确要避开的冲突。
 *
 *  用白名单式判断（必须是 `term-` 前缀）而不是 `label !== 'main'`：以后若出现别的
 *  用途的窗口（面板、预览…），"不是主窗口"会让它们也一起去抢接管载荷。 */
export function isTornOutWindow(label: string): boolean {
  return label.startsWith('term-')
}

// ── 旧窗口侧：发起交接 ───────────────────────────────────────────────────────

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

class HandoffTimeout extends Error {}

/** 等 promise，超过 ms 未落地就抛 HandoffTimeout。定时器无论哪条路径都清掉——留着
 *  会让 vitest 的假定时器（以及真实环境里的空闲计时）多挂一个没人要的回调。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HandoffTimeout()), ms)
  })
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

/** 第 1 步：把标签的每个窗格连同它此刻的滚屏一起打包。
 *
 *  serializeTerm 返回 null 只发生在"该 ptyId 没有注册过序列化入口"（终端还没挂载
 *  完，或窗格本就没有 PTY），按空滚屏处理——历史看不到比整次交接失败要好。
 *
 *  cwd 从 useSessions 的项目表按 dirName 反查：Pane 自己不存 cwd（见 store/tabs.ts
 *  的 Pane 类型），而 ProjectInfo 里 dirName→cwd 是一一对应的。查不到给 null，这个
 *  字段对接管端是纯元数据——PTY 早就在它自己的 cwd 里跑着了，不靠它重建。 */
function buildHandoffPanes(tab: Tab): HandoffPane[] {
  const projects = useSessions.getState().projects
  return tab.panes.map((pane) => ({
    ptyId: pane.ptyId,
    sessionId: pane.sessionId,
    title: pane.title,
    cwd: projects.find((p) => p.dirName === pane.dirName)?.cwd ?? null,
    scrollback: pane.ptyId ? (serializeTerm(pane.ptyId) ?? '') : '',
    cols: HANDOFF_COLS,
    rows: HANDOFF_ROWS,
    threadKey: pane.threadKey,
    dirName: pane.dirName,
    rootKey: pane.rootKey,
  }))
}

/** 回滚：把已经建出来的新窗口关掉。
 *
 *  用 close() 而不是那个更暴力的强制销毁 API：新窗口此刻还没有接管任何 PTY（接管
 *  成功的话我们压根不会走到这里），close 走的是正常的 CloseRequested 路径，语义上
 *  就是"这个窗口白开了"；顺带也少要一条 ACL 权限（capabilities/default.json 里为此
 *  新增的是 core:window:allow-close，见 src/__tests__/tauriAcl.test.ts 这道闸门）。
 *  失败只 console.warn 不上抛——调用它的地方本身就在处理另一个失败，回滚失败不该
 *  覆盖掉原始错误，更不该影响"标签留在旧窗口"这条已经生效的保证。 */
async function closeSpawnedWindow(label: string): Promise<void> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const win = await WebviewWindow.getByLabel(label)
    await win?.close()
  } catch (err) {
    console.warn('回滚：关闭新窗口失败', label, err)
  }
}

/** 把一个标签拖出成新窗口（设计文档 §4.2 的六步）。TabBar.tsx 在 pointerup 命中
 *  拖出判定时调用。
 *
 *  @param screenPoint 新窗口左上角应出现的位置，**屏幕坐标、逻辑（CSS）像素**。
 *   create_term_window 的坐标契约要求逻辑像素、调用方不做 devicePixelRatio 换算
 *   （src-tauri/src/lib.rs 的 create_term_window 顶部有三处源码核实的考据），因此
 *   调用方直接传 PointerEvent 的 screenX/screenY 即可。
 *
 *  @returns 交接是否成功。失败时标签原封不动留在本窗口，且已给出轻提示。 */
export async function tearOutTab(tabId: string, screenPoint: { x: number; y: number }): Promise<boolean> {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId)
  if (!tab || tab.kind !== 'term') return false

  // 第 1 步：先序列化。必须赶在建窗之前——规格 §4.2 把它排在第 1 步，等新窗口就绪
  // 之后再取会把"建窗这段时间里的输出"同时装进滚屏和新窗口的实时缓冲，变成重复。
  const panes = buildHandoffPanes(tab)
  const fromLabel = await currentWindowLabel()
  const activePaneIndex = Math.max(0, tab.panes.findIndex((p) => p.id === tab.activePaneId))

  // 认领用的可变量：两个监听器都闭包捕获它。监听在建窗**之前**注册（下面），此时
  // label 还是 null——只有建窗返回之后才知道等的是谁，因此就绪事件先记进 seenReady，
  // 等 label 落定再回查一次。这条"先记后查"不是防御性冗余：listen() 自己要走一次
  // IPC 往返，如果改成建窗之后再注册，新窗口完全可能在注册完成之前就把就绪事件发
  // 出来，那次交接会一路等到超时、然后把一个其实已经好好起来的窗口关掉。
  let label: string | null = null
  const seenReady = new Set<string>()
  const ready = deferred<void>()
  const ack = deferred<void>()

  const unlistenReady = await listen<HandoffReady>(HANDOFF_READY_EVENT, (e) => {
    const l = e.payload?.label
    if (!l) return
    seenReady.add(l)
    if (label !== null && l === label) ready.resolve()
  })
  const unlistenAck = await listen<HandoffAck>(HANDOFF_ACK_EVENT, (e) => {
    if (label !== null && e.payload?.label === label) ack.resolve()
  })

  try {
    // 第 2 步：建窗。失败（Rust 侧返回 Err）时什么窗口都没建出来，没有残留可关。
    label = await invoke<string>('create_term_window', { x: screenPoint.x, y: screenPoint.y })
    if (seenReady.has(label)) ready.resolve()

    // 第 3 步：等新窗口就绪（带超时）。
    await withTimeout(ready.promise, READY_TIMEOUT_MS)

    // 第 4 步：定向把载荷发给它。
    const payload: HandoffPayload = { fromLabel, toLabel: label, activePaneIndex, panes }
    await emitTo(label, HANDOFF_EVENT, payload)

    // 第 5 步（在新窗口那边跑）→ 第 6 步：等接管确认（带超时）。**只有等到这里才
    // 允许动本窗口的标签**。
    await withTimeout(ack.promise, ACK_TIMEOUT_MS)
    useTabs.getState().removeTabKeepingPty(tabId)
    return true
  } catch (err) {
    // 任一步失败或超时：标签一个字节都不动，把已经建出来的新窗口关掉，给一条可见
    // 提示（复用 store/hint.ts 那条既有的内联轻提示，与 ⌘D 拒绝新建窗格、两个拖拽
    // 入口的拒绝提示同一处渲染，不另造一套提示机制）。
    console.warn('标签拖出交接失败，标签保留在原窗口', tabId, err)
    if (label !== null) await closeSpawnedWindow(label)
    useHint.getState().show(label === null ? '新窗口创建失败，标签已留在原窗口' : '新窗口没能接管这个标签，已留在原窗口')
    return false
  } finally {
    unlistenReady()
    unlistenAck()
  }
}

// ── 新窗口侧：接管 ──────────────────────────────────────────────────────────

/** 第 5 步：收到接管载荷后建标签与窗格、写入滚屏、回 ack。
 *
 *  两处顺序不能调换：
 *    1. **先 seedScrollback，再建标签**。标签一进 store，TerminalLayer 立刻挂
 *       <TerminalView>，后者在自己的 effect 里 attachPty 把待回放缓冲一次性取走
 *       （ptyBuffer.ts）。滚屏晚一步排队就再也没人回放它了，用户会看到一个空终端。
 *    2. **先建好标签，再回 ack**。ack 的语义是"我确实接管了"，旧窗口收到它就会移除
 *       自己那份标签——在真正建好之前回 ack，等于在一个还什么都没有的窗口上给出
 *       保证。
 *
 *  adoptTerminalTab 返回 null（载荷里一个窗格都没有）时**不回 ack**：让旧窗口走
 *  超时回滚，标签留在原处。这比"回了 ack、旧窗口删掉标签、新窗口其实什么都没有"
 *  要好——后者正是绝不允许出现的"两个窗口都没有这个标签"。 */
export async function handleHandoff(payload: HandoffPayload): Promise<void> {
  for (const pane of payload.panes) {
    if (pane.ptyId) seedScrollback(pane.ptyId, pane.scrollback)
  }
  const adopted: AdoptedPane[] = payload.panes.map((p) => ({
    ptyId: p.ptyId,
    title: p.title,
    threadKey: p.threadKey,
    dirName: p.dirName,
    rootKey: p.rootKey,
    sessionId: p.sessionId,
  }))
  const tabId = useTabs.getState().adoptTerminalTab({ panes: adopted, activePaneIndex: payload.activePaneIndex })
  if (!tabId) return
  await emitTo(payload.fromLabel, HANDOFF_ACK_EVENT, { label: payload.toLabel } satisfies HandoffAck)
}

/** 新窗口启动时的接管入口（App.tsx 顶层 side-effect 导入触发）。
 *
 *  只有被拖出创建的窗口（label 形如 term-<n>）才参与：主窗口不该去抢任何载荷，也不
 *  该发就绪事件——它自己就是发起方，会收到自己发的广播。
 *
 *  三步的顺序都是必须的：
 *    1. `await ptyEventsReady`：pty-output 的监听必须先注册好，这一刻起本窗口才开始
 *       攒这个 PTY 的实时输出。放在 emit 就绪之后的话，旧窗口可能在监听就绪前就发来
 *       载荷并移除标签，中间那段输出两个窗口都没有——那才是真正的空档。
 *    2. `await listen(HANDOFF_EVENT)`：接管监听必须早于就绪事件发出，否则旧窗口收到
 *       就绪后立刻 emitTo 的载荷会打在还没挂监听的窗口上，一路等到 ack 超时。
 *    3. `emit(READY)`：到这里才真的"就绪"。
 *
 *  与 closeRequest.ts / ptyBuffer.ts / menuEvents.ts 同一注册模式：模块顶层立即发起，
 *  导出 Promise 只是给调用方（测试）一个可等的就绪点。整条链上任何一步失败都只
 *  console.error 留痕，不上抛——这是应用启动路径，抛出去会白屏。 */
export const windowHandoffReady: Promise<void> = (async () => {
  const label = await currentWindowLabel()
  if (!isTornOutWindow(label)) return
  await ptyEventsReady
  await listen<HandoffPayload>(HANDOFF_EVENT, (e) => {
    void handleHandoff(e.payload).catch((err) => { console.error('接管交接载荷失败', err) })
  })
  await emit(HANDOFF_READY_EVENT, { label } satisfies HandoffReady)
})().catch((err) => { console.error('窗口交接监听注册失败', err) })
