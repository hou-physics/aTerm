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
//   1. 旧窗口调 create_term_window(x, y)（Task 1 的 Rust 命令），拿到新窗口 label
//   2. 新窗口启动（其 ptyBuffer 从此开始缓存这个 PTY 的实时输出）→ emit 就绪事件
//   3. 旧窗口收到就绪事件，**此刻才序列化**该标签每个窗格的滚屏，随即 emitTo 定向
//      发送接管载荷
//   4. 新窗口收到载荷：**先丢弃该 ptyId 的既有缓冲**、再写入快照、再建标签（挂载后
//      TerminalView 自己 attachPty），然后 emitTo 回 ack
//   5. 旧窗口收到 ack 后移除该标签，**但不 kill PTY**
//
// ## emitTo 不是私有信道（R2/C1，本文件最容易被想当然的一点）
//
// `emitTo(label, …)` 看起来像"只有那个 label 的窗口收得到"，**但对不带 options 的
// `listen` 完全失效**。逐层核实过：
//   1. `@tauri-apps/api/event.js` 的 `listen(event, handler)` 不传 options 时，target
//      落成 `{ kind: 'Any' }`；
//   2. `tauri-2.11.5/src/event/plugin.rs:14-21` 把这个 target 原样存进 `listen_js`；
//   3. `event/listener.rs:269-292` 的 `emit_js_filter` **遍历全部 webview**，每个 handler
//      走 `match_any_or_filter`；
//   4. `listener.rs:306-311`：`*target == EventTarget::Any || filter(…)`——target 为 Any
//      的监听器**无条件命中**，label 过滤对它形同虚设。
//
// 后果曾是本任务最严重的缺陷：已开着 term-1 时再从主窗口拖出第二个标签，`emitTo('term-2')`
// 的载荷 term-1 也会收到、也会接管、还会回 ack —— 同一个标签同时出现在两个窗口，两边各自
// attachPty 同一个 ptyId；用户去关掉多余那个，`closeTab` 会 kill 掉正在跑的 claude 会话。
//
// 因此这里做**两层**防护，缺一不可：
//   - 注册侧：`listen(HANDOFF_EVENT, …, { target: label })`，让这个监听器不再是 Any
//     （已核实不会误伤 ready 广播：`emit` 的 filter 为 None，AnyLabel 目标的监听器照收）；
//   - 处理侧：`handleHandoff` 开头比对 `payload.toLabel` 是不是本窗口，不是就直接返回，
//     **不建标签、也不回 ack**。
//   - ack 同理带上"新窗口自己的 label"，发起方按它认领（`tearOutTab` 的 ack 监听）。
//
// ## 交接期间的输出：既不丢、也不重复（R1 修正）
//
// pty-output 是 app.emit 全应用广播（src-tauri/src/pty.rs:28），不是定向某个窗口，新
// 窗口的 ptyBuffer 从它自己的监听注册那一刻（ptyEventsReady）起就在攒这个 PTY 的输出。
//
// 初版按规格把序列化排在建窗**之前**，于是 [序列化, 新窗口监听就绪] 这一整段建窗时间
// （数百毫秒起）的输出既不在快照里、也不在新窗口的缓冲里——交接后彻底看不见。R1 把
// 序列化挪到收到就绪事件之后，空档缩到一次 IPC 往返（毫秒级）；代价是这一小段输出
// 同时存在于快照和新窗口缓冲里，因此接管端必须先 discardBuffered 再写快照（见
// ptyBuffer.ts 那两个函数的注释）。为什么宁可丢一点也不要重复：Claude Code 跑在
// alt-screen，重复的转义序列会把画面搞乱，比丢一小段更糟。
import { invoke } from '@tauri-apps/api/core'
import { emit, emitTo, listen } from '@tauri-apps/api/event'
import { beginHandoff, endHandoff } from './handoffLock'
import { destroyTermWindow, lastPtySize, ptyResize } from './ipc'
import { discardBuffered, ignorePtyOutput, ptyEventsReady, seedScrollback } from './ptyBuffer'
import { useHint } from './store/hint'
import { useSessions } from './store/sessions'
import { type AdoptedPane, type Tab, useTabs } from './store/tabs'
import { serializeTerm } from './termSerialize'
import { currentWindowLabel, isTornOutWindow } from './windowLabel'

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
/** ack 里的 label 是**接管方自己的** label（R2/C1 之三），不是把载荷里的 toLabel 原样
 *  回带——后者只是"发起方以为它是谁"，回带过去等于让发起方自说自话地确认自己。发起方
 *  的 ack 监听按这个 label 认领，串扰或错投的 ack 一律不认。 */
export type HandoffAck = { label: string }

/** 交接载荷里的单个窗格。
 *
 *  规格 §4.2 第 4 步要求载荷至少含 ptyId / sessionId / 标题 / cwd / 序列化滚屏 /
 *  终端尺寸。**终端尺寸（cols/rows）R1 已删除**：接管端根本不读它——新窗口的
 *  TerminalView 挂载时会自己 fit() 一次并 ptyResize(ptyId, term.cols, term.rows)，尺寸
 *  在一帧内就校正成新窗口的真实几何（拿载荷里的旧尺寸去 ptyResize 反而会把 PTY 先按
 *  错误尺寸拧一次）。而真值只存在于受保护文件 TerminalView.tsx 内部的局部变量里，为一
 *  份没人读的数据去动受保护文件不划算。**尺寸由接管端自行 fit 校正，故不随载荷传递。**
 *
 *  **为什么是一个数组而不是平铺字段**：本仓库的一个
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

/** 第 2 步（新窗口启动 → 前端就绪）的超时。10s：这一段包含原生窗口创建、WKWebView
 *  冷启动、整个前端 bundle 解析执行、React 挂载、以及 ptyEventsReady 那两次 listen
 *  的 IPC 往返——冷启动那一段在开发构建和低配机器上是秒级的。 */
export const READY_TIMEOUT_MS = 10_000

/** 第 4 步（发出载荷 → 收到接管确认）的超时。5s：新窗口此时已经就绪，剩下的只有
 *  一次 store 写入和一次 emitTo，正常是毫秒级；给到 5s 是留给"事件桥恰好排在一堆
 *  pty-output 后面"这类抖动，仍然比它实际需要的量级大得多。 */
export const ACK_TIMEOUT_MS = 5_000

// ── 窗口身份 ────────────────────────────────────────────────────────────────
// currentWindowLabel / isTornOutWindow 已移到 src/windowLabel.ts：Task 5 起
// closeRequest.ts 与 windowClose.ts 也要用它们，而从这个模块导入会连带触发下面
// windowHandoffReady 的顶层副作用（注册接管监听、广播就绪事件）。见那个文件顶部。

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

/** 第 3 步的前半段：把标签的每个窗格连同它**此刻**的滚屏一起打包。
 *
 *  调用时机是硬要求：必须在收到新窗口的就绪事件之后（R1，见文件顶部「交接期间的
 *  输出」一节）。提前到建窗之前会丢掉整个建窗时间里的输出。
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
    threadKey: pane.threadKey,
    dirName: pane.dirName,
    rootKey: pane.rootKey,
  }))
}

/** 回滚：把已经建出来的新窗口关掉，**且绝不让它顺手杀掉任何 PTY**。
 *
 *  用 Rust 的 destroy_term_window（强制销毁，绕过 CloseRequested）而不是 JS 侧
 *  `WebviewWindow` 的那个 close 方法——这是 V3.3 Ruling 7 的落点，改动理由完整写在这里
 *  （顺带：本仓库生产代码里因此不再有任何 core:window 的关窗调用，capabilities 里那条
 *  `core:window:allow-close` 已随之撤掉，src/__tests__/tauriAcl.test.ts 那道闸门会在
 *  有人重新引入时报出来）：
 *
 *  Task 5 之前，非主窗口的 CloseRequested 在 Rust 侧直接早退、不杀任何 PTY，所以
 *  普通的关窗路径是安全的（代价是拖出来的窗口关掉后它的会话变成后台孤儿）。Task 5 把那条
 *  路径改成了"关窗只杀它自己持有的 PTY"，于是普通关窗变成一条**真正的会话损失来源**：
 *  回滚要关掉的这个新窗口**可能其实已经接管成功**，只是 ack 丢了或超时了——它的 store
 *  里此刻正拿着那些 ptyId，close 走一遍它自己的关窗流程就会把用户正在跑的 claude 全部
 *  kill 掉。
 *
 *  回滚方**无法知道**自己在哪个分支（ack 就是那条丢掉的信息），所以只能选一个两边都
 *  安全的动作：销毁窗口、一个 PTY 都不动。
 *    - 新窗口其实接管成功了 → 会话继续跑，标签留在旧窗口（回滚不动标签），用户看到的
 *      是"拖出没成功"，会话完好；
 *    - 新窗口没接管成功 → 它本来就没有 PTY 可 kill，销毁与普通关窗等价。
 *
 *  失败只 console.warn 不上抛——调用它的地方本身就在处理另一个失败，回滚失败不该
 *  覆盖掉原始错误，更不该影响"标签留在旧窗口"这条已经生效的保证。 */
async function closeSpawnedWindow(label: string): Promise<void> {
  try {
    await destroyTermWindow(label)
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
  // 上锁失败 = 这个标签已经在交接中：直接放弃，**且不进入下面的 try**——那里的 finally
  // 会 endHandoff，而那把锁是正在进行的那一次的，放掉就等于把 M6 的防护整个抵消。
  if (!beginHandoff(tabId)) return false

  // 认领用的可变量：两个监听器都闭包捕获它。监听在建窗**之前**注册（下面），此时
  // label 还是 null——只有建窗返回之后才知道等的是谁，因此就绪事件先记进 seenReady，
  // 等 label 落定再回查一次。这条"先记后查"不是防御性冗余：listen() 自己要走一次
  // IPC 往返，如果改成建窗之后再注册，新窗口完全可能在注册完成之前就把就绪事件发
  // 出来，那次交接会一路等到超时、然后把一个其实已经好好起来的窗口关掉。
  let label: string | null = null
  // 载荷是否真的发出去过：决定回滚时要不要把 PTY 尺寸拧回来（见下面 catch 分支）。
  let emitted = false
  let handedOffPaneIds: string[] = []
  let handedOffPtyIds: string[] = []
  const seenReady = new Set<string>()
  const ready = deferred<void>()
  const ack = deferred<void>()
  // 两个临时监听的注销函数。声明在 try **之外**、赋值在 try **之内**，finally 里可选
  // 调用——注册本身（listen 是一次 IPC 往返）也可能失败，那时它们仍是 undefined。
  let unlistenReady: (() => void) | undefined
  let unlistenAck: (() => void) | undefined

  // 从上锁那一刻起的**全部**代码都在这个 try 里，一行都不许漏在外面（Ruling 12 的硬
  // 要求）：锁没释放意味着这个标签永久关不掉、也永久拖不出，比它挡的问题更糟。改之前
  // 这里有一段裸露在 try 之前的 await（currentWindowLabel + 两次 listen），listen()
  // 走的是真实 IPC，它 reject 时锁就永远留在 Set 里了。
  try {
    const fromLabel = await currentWindowLabel()

    unlistenReady = await listen<HandoffReady>(HANDOFF_READY_EVENT, (e) => {
      const l = e.payload?.label
      if (!l) return
      seenReady.add(l)
      if (label !== null && l === label) ready.resolve()
    })
    // ack 认领（R2/C1 之三）：载荷里的 label 是**接管方自己报出来的** label，与我们刚
    // create_term_window 拿到的那个对上才算数——串扰过来的、或别的窗口发的 ack 一律不认。
    unlistenAck = await listen<HandoffAck>(HANDOFF_ACK_EVENT, (e) => {
      if (label !== null && e.payload?.label === label) ack.resolve()
    })

    // 第 1 步：建窗。失败（Rust 侧返回 Err）时什么窗口都没建出来，没有残留可关。
    label = await invoke<string>('create_term_window', { x: screenPoint.x, y: screenPoint.y })
    if (seenReady.has(label)) ready.resolve()

    // 第 2 步：等新窗口就绪（带超时）。
    await withTimeout(ready.promise, READY_TIMEOUT_MS)

    // 第 3 步：**此刻**才序列化（R1，见文件顶部「交接期间的输出」一节），随即定向
    // 把载荷发给新窗口。
    //
    // 标签要重新从 store 取一次，不能沿用函数开头那份快照：上面刚 await 过若干次
    // （建窗 + 等就绪，可能是数百毫秒），这期间用户完全可能 ⌘D 加了个窗格、关掉了
    // 一个窗格、甚至把整个标签关了。用陈旧快照会把一个已经不存在的窗格搬过去，或者
    // 漏掉新加的那个（它的 PTY 就成了孤儿）。取不到就当这次交接失败，走下面的回滚。
    const fresh = useTabs.getState().tabs.find((t) => t.id === tabId)
    if (!fresh || fresh.kind !== 'term') throw new Error(`标签 ${tabId} 在交接过程中已消失`)
    // 交接出去的**具体是哪些窗格**要记下来（R2/I2）：等 ack 期间用户还能给这个标签
    // ⌘D 加窗格，收尾时只能移除这里记下的这些，不能按 tab id 整块删。
    handedOffPaneIds = fresh.panes.map((p) => p.id)
    handedOffPtyIds = fresh.panes.map((p) => p.ptyId).filter((id): id is string => Boolean(id))
    const payload: HandoffPayload = {
      fromLabel,
      toLabel: label,
      activePaneIndex: Math.max(0, fresh.panes.findIndex((p) => p.id === fresh.activePaneId)),
      panes: buildHandoffPanes(fresh),
    }
    await emitTo(label, HANDOFF_EVENT, payload)
    emitted = true

    // 第 4 步（在新窗口那边跑）→ 第 5 步：等接管确认（带超时）。**只有等到这里才
    // 允许动本窗口的标签**。
    await withTimeout(ack.promise, ACK_TIMEOUT_MS)
    useTabs.getState().removeTabKeepingPty(tabId, handedOffPaneIds)
    // 交接完成，本窗口从此不再关心这些 PTY 的输出（R2/I3）。pty-output 是全应用广播，
    // 不登记的话它们会一直往本窗口的 buffers 里堆——而本窗口再也不会 attachPty 这些
    // id，没有任何路径会清空它，拖走一个持续刷屏的会话就是一条无界增长的内存曲线。
    for (const ptyId of handedOffPtyIds) ignorePtyOutput(ptyId)
    return true
  } catch (err) {
    // 任一步失败或超时：标签一个字节都不动，把已经建出来的新窗口关掉，给一条可见
    // 提示（复用 store/hint.ts 那条既有的内联轻提示，与 ⌘D 拒绝新建窗格、两个拖拽
    // 入口的拒绝提示同一处渲染，不另造一套提示机制）。
    console.warn('标签拖出交接失败，标签保留在原窗口', tabId, err)
    if (label !== null) await closeSpawnedWindow(label)
    // 载荷已经发出去过 ⇒ 新窗口可能已经接管过一轮：它的 TerminalView 挂载时 fit() 并把
    // PTY 拧成了**它自己**的几何。新窗口关掉之后，旧窗口的 xterm 尺寸没变、
    // ResizeObserver 不触发、active 也没变，PTY 就永远停在错误的列宽上，用户会在"交接
    // 失败、标签留在原窗口"之后看到一个排版错乱的终端，很容易误判成会话坏了（R2/I4）。
    // 用本窗口自己最近一次请求过的尺寸拧回来——每个窗口是独立 JS 上下文，lastPtySize
    // 只记本窗口发出过的 pty_resize，不会被新窗口那次污染（见 ipc.ts）。
    if (emitted) {
      for (const ptyId of handedOffPtyIds) {
        const size = lastPtySize(ptyId)
        if (size) void ptyResize(ptyId, size.cols, size.rows)
      }
    }
    useHint.getState().show(label === null ? '新窗口创建失败，标签已留在原窗口' : '新窗口没能接管这个标签，已留在原窗口')
    return false
  } finally {
    endHandoff(tabId)
    unlistenReady?.()
    unlistenAck?.()
  }
}

// ── 新窗口侧：接管 ──────────────────────────────────────────────────────────

/** 第 4 步：收到接管载荷后清缓冲、写入滚屏、建标签与窗格、回 ack。
 *
 *  三处顺序都不能调换：
 *    1. **先 discardBuffered，再 seedScrollback**（R1）。旧窗口是在收到本窗口的就绪
 *       事件之后才序列化的，所以 [本窗口监听就绪, 旧窗口序列化] 这一小段的实时输出
 *       同时存在于本窗口的缓冲和快照里；不先清掉就会重复回放，alt-screen 下画面会花。
 *    2. **先写好缓冲，再建标签**。标签一进 store，TerminalLayer 立刻挂 <TerminalView>，
 *       后者在自己的 effect 里 attachPty 把待回放缓冲一次性取走（ptyBuffer.ts）。滚屏
 *       晚一步排队就再也没人回放它了，用户会看到一个空终端。前两步因此都放在
 *       adoptTerminalTab **之前**的同一个同步块里，中间不留可插入的时机。
 *    3. **先建好标签，再回 ack**。ack 的语义是"我确实接管了"，旧窗口收到它就会移除
 *       自己那份标签——在真正建好之前回 ack，等于在一个还什么都没有的窗口上给出
 *       保证。
 *
 *  adoptTerminalTab 返回 null（载荷里一个窗格都没有）时**不回 ack**：让旧窗口走
 *  超时回滚，标签留在原处。这比"回了 ack、旧窗口删掉标签、新窗口其实什么都没有"
 *  要好——后者正是绝不允许出现的"两个窗口都没有这个标签"。 */
export async function handleHandoff(payload: HandoffPayload): Promise<void> {
  // R2/C1 之一：这份载荷是不是发给**我**的。emitTo 的 label 过滤对 target 为 Any 的
  // 监听器完全失效（考据见文件顶部），所以定向投递这件事在处理侧必须再验一次——不是
  // 防御性冗余，是同一条防线的第二层：漏掉它，已经开着的另一个 term-* 窗口会把别人的
  // 标签也接管一份，同一个 ptyId 在两个窗口各 attachPty 一次，用户关掉多余那个时
  // closeTab 会 kill 掉正在跑的会话。不是发给我的：不建标签、也**不回 ack**（回了就
  // 等于替真正的接管方给了保证，发起方会据此删掉自己的标签）。
  if (payload.toLabel !== (await currentWindowLabel())) return
  for (const pane of payload.panes) {
    if (!pane.ptyId) continue
    discardBuffered(pane.ptyId)
    seedScrollback(pane.ptyId, pane.scrollback)
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
  // ack 报的是**本窗口自己的** label（R2/C1 之三），不是把 payload.toLabel 原样回带——
  // 后者只是"发起方以为接管方是谁"，回带过去等于让发起方自说自话地确认自己。走到这里
  // 时上面那道校验已经保证两者相等，用 currentWindowLabel() 是让"谁在确认"这件事由
  // 确认者自己说出来，而不是从对方的话里抄一遍。
  await emitTo(payload.fromLabel, HANDOFF_ACK_EVENT, { label: await currentWindowLabel() } satisfies HandoffAck)
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
  // target 必须限定成本窗口（R2/C1 之二）：不传 options 的 listen 会落成
  // `{ kind: 'Any' }`，而 Any 目标的监听器对 emitTo 的 label 过滤**无条件命中**（考据
  // 见文件顶部）——那样每个 term-* 窗口都会收到发给别人的接管载荷。传字符串时
  // @tauri-apps/api 会包成 `{ kind: 'AnyLabel', label }`；已核实这不会误伤上面那条
  // ready 广播：`emit` 走的是 filter 为 None 的路径，AnyLabel 目标的监听器照收。
  await listen<HandoffPayload>(HANDOFF_EVENT, (e) => {
    void handleHandoff(e.payload).catch((err) => { console.error('接管交接载荷失败', err) })
  }, { target: label })
  await emit(HANDOFF_READY_EVENT, { label } satisfies HandoffReady)
})().catch((err) => { console.error('窗口交接监听注册失败', err) })
