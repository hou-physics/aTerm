// 标签拖出成新窗口的交接握手（V3.3 设计文档 §4.2/§4.3，Task 4）。
//
// 这个文件要守住的唯一一条硬不变式：**绝不允许出现「两个窗口都没有这个标签」的状态**。
// 因此每一条失败/超时用例都直接断言 `useTabs.getState()` 这份真实 store 状态里标签
// 仍然在（而不是只断言"某个 mock 没被调用过"——那是恒真断言，本仓库出过事故，见
// CLAUDE.md「测试纪律」）。
//
// Tauri 的事件桥在 jsdom 里不存在，这里用一个受控的假事件总线替身
// `@tauri-apps/api/event`：listen 记下 handler，emit/emitTo 只记录调用（新窗口那侧的
// 行为由 handleHandoff 单独测，不靠这条总线自动串起来）——测试自己决定"新窗口什么时候
// 回就绪事件/什么时候回 ack"，这正是超时分支唯一可控的模拟方式。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { payload: unknown }) => void

const { listeners, listenMock, emitMock, emitToMock, ptyListenGate } = vi.hoisted(() => {
  const listeners = new Map<string, Set<Handler>>()
  // 每个 handler 注册时声明的 target label（listen 的 options.target）；undefined 表示
  // 没传 options —— 真实语义下那是 `{ kind: 'Any' }`。
  const targets = new WeakMap<Handler, string | undefined>()
  // 闸门：置上 pending 之后，listen('pty-output') 这一次调用**不会 resolve**，于是
  // ptyBuffer 的 ptyEventsReady 一直挂着。用来验证"新窗口必须等自己的 pty-output
  // 监听真的就绪之后才宣告 ready"——那正是设计文档 §4.2 结尾"交接期间输出不会丢"
  // 那条保证的前提。默认为 null，不影响其它用例。
  const ptyListenGate: { pending: Promise<void> | null } = { pending: null }
  const listenMock = vi.fn(async (event: string, handler: Handler, options?: { target?: string }) => {
    const set = listeners.get(event) ?? new Set<Handler>()
    set.add(handler)
    targets.set(handler, options?.target)
    listeners.set(event, set)
    if (event === 'pty-output' && ptyListenGate.pending) await ptyListenGate.pending
    return () => { set.delete(handler) }
  })
  // R2/C1 之四：这两个替身必须**真的投递**，而且要按 Tauri 2 的真实语义投递。
  //
  // 上一版把 emitTo 建模成"完美定向"（只 vi.fn() 记录、不投递），这正是那条 Critical
  // 在单测里隐形的根因：真实的 emit_to 对 target 为 `Any` 的监听器**无条件命中**
  // （tauri-2.11.5 event/listener.rs:306-311，考据见 windowHandoff.ts 顶部），也就是说
  // "只有目标窗口收得到"这个假设根本不成立。替身照此建模：
  //   - emit（广播）→ 投递给该事件的全部监听器；
  //   - emitTo(label) → 投递给 target 未声明（= Any）的监听器 + target 恰为该 label 的
  //     监听器。
  // 于是"注册时有没有限定 target"这件事在测试里真的有区分力，串扰会被看见。
  const deliver = (event: string, payload: unknown, toLabel?: string) => {
    for (const handler of [...(listeners.get(event) ?? [])]) {
      const target = targets.get(handler)
      if (toLabel !== undefined && target !== undefined && target !== toLabel) continue
      handler({ payload })
    }
  }
  const emitMock = vi.fn(async (event: string, payload?: unknown) => { deliver(event, payload) })
  const emitToMock = vi.fn(async (label: string, event: string, payload?: unknown) => {
    deliver(event, payload, label)
  })
  return { listeners, listenMock, emitMock, emitToMock, ptyListenGate }
})

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
const { serializeTermMock } = vi.hoisted(() => ({ serializeTermMock: vi.fn((_ptyId: string) => '') }))
// 当前窗口的 label。默认 'main'。
//
// **V3.4 起 'main' 不再意味着"什么都不做"**（修复轮 R2 / M5 把这段注释改准——写错的话
// 后人会照着它推理串扰面）：主窗口现在**也会**注册接管监听（`listen(HANDOFF_EVENT,
// …, { target: 'main' })`），因为标签可以拖回主窗口；它只是不发就绪广播（READY 的语义是
// "我这个刚被建出来的窗口起来了"，主窗口不是被谁建出来的）。所以模块顶层
// windowHandoffReady 在这个默认值下**会**留下一条监听记录——beforeEach 的
// `listeners.clear()` 把它清掉，各条用例因此互不串扰。
//
// 下面「新窗口启动」那组用例会临时改成 term-<n> 再 resetModules 重新导入，模拟真的被
// 拖出来的那个窗口；「主窗口作为接管方」那组则反过来，验的正是 'main' 现在收得到载荷。
const { currentWindowMock } = vi.hoisted(() => ({ currentWindowMock: vi.fn(() => ({ label: 'main' })) }))

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock, emit: emitMock, emitTo: emitToMock }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: currentWindowMock }))
vi.mock('../termSerialize', () => ({ serializeTerm: serializeTermMock }))
vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-new'),
  ptyIsAlive: vi.fn(async () => true),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  // R2/I4：回滚时用它把 PTY 尺寸拧回旧窗口的几何（见 ipc.ts 的 lastPtySizes 注释）。
  ptyResize: vi.fn(async () => {}),
  lastPtySize: vi.fn((_id: string) => undefined as { cols: number; rows: number } | undefined),
  // Task 5 / Ruling 7：回滚改用这条 Rust 命令关掉新窗口（强制销毁、绕过
  // CloseRequested），不再走 JS 侧 WebviewWindow 的关窗方法——那条路径会让新窗口
  // 把它可能刚接管过来的 PTY 全部 kill 掉。
  destroyTermWindow: vi.fn(async () => {}),
}))

import * as ipc from '../ipc'
import {
  HANDOFF_ACK_EVENT,
  HANDOFF_EVENT,
  HANDOFF_READY_EVENT,
  READY_TIMEOUT_MS,
  ACK_TIMEOUT_MS,
  handleHandoff,
  handoffTabToWindow,
  tearOutTab,
  type HandoffPayload,
} from '../windowHandoff'
import { isTornOutWindow } from '../windowLabel'
import { attachPty } from '../ptyBuffer'
import { useHint } from '../store/hint'
import { useSessions } from '../store/sessions'
import { HANDOFF_IN_FLIGHT_HINT, useTabs } from '../store/tabs'
import { abortSelfDestruct } from '../handoffLock'

const HOME = { id: 'home', kind: 'home' as const, title: '主页', panes: [] }
const TAB_A = {
  id: 'tab-a',
  kind: 'term' as const,
  title: 'A',
  panes: [{ id: 'pane-a', ptyId: 'pty-a', title: 'A', threadKey: 'demo:root-a', dirName: '-tmp-demo', rootKey: 'root-a', sessionId: 'sess-a' }],
  activePaneId: 'pane-a',
}
const TAB_B = {
  id: 'tab-b',
  kind: 'term' as const,
  title: 'B',
  panes: [{ id: 'pane-b', ptyId: 'pty-b', title: 'B' }],
  activePaneId: 'pane-b',
}

/** 模拟"新窗口发来了就绪事件"。*/
function fireReady(label: string) {
  for (const h of listeners.get(HANDOFF_READY_EVENT) ?? []) h({ payload: { label } })
}
/** 模拟"这个 PTY 广播了一段实时输出"（走 ptyBuffer 自己注册的 pty-output 监听）。
 *  载荷是 base64（b64ToBytes），只能用 ASCII 字面量——btoa 不接受非 Latin-1。 */
function firePtyOutput(id: string, text: string) {
  for (const h of listeners.get('pty-output') ?? []) h({ payload: { id, data: btoa(text) } })
}
/** 模拟"接管方回了接管确认"。
 *
 *  两个字段都要传（V3.4 修复轮 R2 / C1）：`label` 是接管方自己的 label，`tabId` 是它从
 *  载荷里原样回带的**源窗口那份标签的 id**。发起方两个都对上才认这条 ack——只比 label
 *  的话，同一个源窗口向同一个目标连着甩两个标签时，目标回的第一条 ack 会把两条等待
 *  同时 resolve。 */
function fireAck(label: string, tabId: string) {
  for (const h of listeners.get(HANDOFF_ACK_EVENT) ?? []) h({ payload: { label, tabId } })
}

let warnSpy: ReturnType<typeof vi.spyOn> | undefined

beforeEach(() => {
  // ptyBuffer 的 pty-output / pty-exit 监听是模块导入时注册的、只注册这一次——整张表
  // 清掉之后就再也回不来了，而下面「先丢弃既有缓冲」那条用例要靠它往缓冲里灌数据。
  // 只清握手相关的事件。
  const ptyOutput = listeners.get('pty-output')
  const ptyExit = listeners.get('pty-exit')
  listeners.clear()
  if (ptyOutput) listeners.set('pty-output', ptyOutput)
  if (ptyExit) listeners.set('pty-exit', ptyExit)
  vi.clearAllMocks()
  vi.useFakeTimers()
  // 失败/超时分支会 console.warn 留痕（生产环境要的就是这条线索，见 windowHandoff.ts
  // 里对静默吞异常的说明）；这里静音只是为了不让预期之内的失败用例刷满 stderr。
  // 只摘这一个 spy，不用 vi.restoreAllMocks()——那会把上面几个 vi.hoisted 出来的
  // 带实现的替身（listenMock/emitMock/…）一起重置成空实现。
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  serializeTermMock.mockReturnValue('')
  invokeMock.mockResolvedValue('term-1')
  // clearAllMocks 只清调用记录、不清实现，某条用例里设过的 mockRejectedValue 会漏到
  // 后面去——每轮显式复位成成功。
  vi.mocked(ipc.destroyTermWindow).mockResolvedValue(undefined)
  useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-b' })
  useSessions.setState({ projects: [] })
  useHint.setState({ message: null, action: null })
  currentWindowMock.mockReturnValue({ label: 'main' })
  ptyListenGate.pending = null
  // 「本窗口已经决定自毁」那面旗是模块级的、且**刻意只在失败分支复位**（成功自毁的窗口
  // 马上就没了，见 handoffLock.ts）。跨用例不复位的话，一条成功自毁的用例会把它永久留成
  // true，后面所有接管用例都在被污染的前提下跑——更要命的是变异会因此测不出来（把置位挪
  // 到 destroy 之后，探针仍然绿，因为它读到的是上一条用例留下的 true）。用的就是生产代码
  // 里那个复位函数。
  abortSelfDestruct()
})

afterEach(() => {
  vi.useRealTimers()
  warnSpy?.mockRestore()
})

describe('tearOutTab — 完整成功路径（设计文档 §4.2 的六步）', () => {
  it('六步走完：调用建窗命令、定向发接管载荷、收到 ack 后移除标签，且全程没有 kill 任何 PTY', async () => {
    const done = tearOutTab('tab-b', { x: 300, y: 200 })
    await vi.advanceTimersByTimeAsync(0)

    // 第 2 步：调了 Task 1 的建窗命令，坐标原样透传（逻辑像素，调用方不做 dpr 换算）。
    expect(invokeMock).toHaveBeenCalledWith('create_term_window', { x: 300, y: 200 })
    // 第 4 步之前：还没收到就绪事件，绝不能提前发载荷。
    expect(emitToMock).not.toHaveBeenCalled()

    fireReady('term-1')
    await vi.advanceTimersByTimeAsync(0)

    // 第 4 步：定向发给新窗口的 label，事件名与载荷字段见 windowHandoff.ts。
    expect(emitToMock).toHaveBeenCalledTimes(1)
    const [label, event, payload] = emitToMock.mock.calls[0] as [string, string, HandoffPayload]
    expect(label).toBe('term-1')
    expect(event).toBe(HANDOFF_EVENT)
    expect(payload.toLabel).toBe('term-1')
    expect(payload.panes[0].ptyId).toBe('pty-b')

    // 第 6 步之前：ack 没到，标签必须还在。
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])

    fireAck('term-1', 'tab-b')
    expect(await done).toBe(true)

    // 第 6 步：标签移除，PTY 不 kill（会话仍在新窗口里跑）。
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a'])
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    // 也没有把刚建好的新窗口关掉（那是失败路径才做的事）。
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
    // 两个临时监听都摘干净了——每拖出一次就漏一对监听器的话，长跑之后每个事件都要
    // 走一遍一堆早已过期的闭包。断言的是假事件总线里真实剩下的 handler 数量，不是
    // "unlisten 这个 mock 被调过"。
    expect(listeners.get(HANDOFF_READY_EVENT)?.size ?? 0).toBe(0)
    expect(listeners.get(HANDOFF_ACK_EVENT)?.size ?? 0).toBe(0)
  })

  it('载荷带上该标签每个窗格的滚屏与身份字段，且序列化发生在收到就绪事件之后（R1）', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    useSessions.setState({ projects: [{ dirName: '-tmp-demo', cwd: '/tmp/demo', lastActivityMs: 0, threads: [] }] })
    serializeTermMock.mockReturnValue('[31mRED[0m')

    const done = tearOutTab('tab-a', { x: 10, y: 20 })
    await vi.advanceTimersByTimeAsync(0)
    // R1：序列化必须发生在**收到就绪事件之后**。提前到建窗之前的话，整个建窗时间
    // （数百毫秒起）的输出既不在快照里、也不在新窗口的缓冲里，交接后彻底看不见。
    expect(serializeTermMock).not.toHaveBeenCalled()

    fireReady('term-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(serializeTermMock).toHaveBeenCalledWith('pty-a')
    fireAck('term-1', 'tab-a')
    await done

    const payload = emitToMock.mock.calls[0][2] as HandoffPayload
    expect(payload.activePaneIndex).toBe(0)
    expect(payload.panes).toEqual([
      {
        ptyId: 'pty-a',
        sessionId: 'sess-a',
        title: 'A',
        cwd: '/tmp/demo',
        scrollback: '[31mRED[0m',
        threadKey: 'demo:root-a',
        dirName: '-tmp-demo',
        rootKey: 'root-a',
      },
    ])
  })

  // 发送端的多窗格覆盖（接管端的在下面 handleHandoff 那一组）：拖出手势的对象是
  // **标签**，而一个标签最多可持有 3 个窗格。载荷若只装第一个，旧窗口移除标签后另外
  // 两个 PTY 就成了谁都看不到、也关不掉的孤儿进程。
  it('多窗格标签：载荷带上全部窗格与各自的滚屏，并记住原来的焦点窗格下标', async () => {
    const multi = {
      id: 'tab-m',
      kind: 'term' as const,
      title: '3 个对话',
      panes: [
        { id: 'p1', ptyId: 'pty-1', title: '一' },
        { id: 'p2', ptyId: 'pty-2', title: '二' },
        { id: 'p3', ptyId: 'pty-3', title: '三' },
      ],
      activePaneId: 'p3',
    }
    useTabs.setState({ tabs: [HOME, TAB_A, multi], activeId: 'tab-m' })
    serializeTermMock.mockImplementation((ptyId: string) => `滚屏-${ptyId}`)

    const done = tearOutTab('tab-m', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)
    fireReady('term-1')
    await vi.advanceTimersByTimeAsync(0)
    fireAck('term-1', 'tab-m')
    expect(await done).toBe(true)

    const payload = emitToMock.mock.calls[0][2] as HandoffPayload
    expect(payload.panes.map((p) => p.ptyId)).toEqual(['pty-1', 'pty-2', 'pty-3'])
    expect(payload.panes.map((p) => p.scrollback)).toEqual(['滚屏-pty-1', '滚屏-pty-2', '滚屏-pty-3'])
    expect(payload.activePaneIndex).toBe(2)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a'])
    expect(ipc.ptyKill).not.toHaveBeenCalled()
  })

  // 发起方不一定是主窗口：一个已经被拖出来的 term-<n> 窗口里还可以再拖出一个标签。
  // 载荷里的 fromLabel 就是新窗口回 ack 的目的地，写死 'main' 的话这条链上第二次拖出
  // 的 ack 会发给主窗口、真正在等的那个窗口一直等到超时——然后把一个其实已经接管
  // 成功的新窗口关掉，用户眼看着窗口闪一下就没了。
  // 这里必须 resetModules 重新导入：当前窗口 label 是模块加载时解析一次并缓存的。
  it('发起方本身就是被拖出来的窗口时，载荷的 fromLabel 是它自己的 label', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-3' })
    vi.resetModules()
    const mod = await import('../windowHandoff')
    const tabsMod = await import('../store/tabs')
    await mod.windowHandoffReady
    // 重新导入连带换掉了 store 实例，状态要设在这一份新的上面。
    tabsMod.useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-b' })
    invokeMock.mockResolvedValue('term-9')

    const done = mod.tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)
    fireReady('term-9')
    await vi.advanceTimersByTimeAsync(0)
    fireAck('term-9', 'tab-b')
    expect(await done).toBe(true)

    const payload = emitToMock.mock.calls[0][2] as HandoffPayload
    expect(payload.fromLabel).toBe('term-3')
    expect(payload.toLabel).toBe('term-9')
    expect(tabsMod.useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a'])
  })

  // R1 把序列化挪到就绪之后，中间多了一段"建窗 + 等就绪"的可 await 时间（数百毫秒），
  // 用户完全可能在这期间 ⌘D 加个窗格。沿用函数开头那份标签快照会漏掉新窗格，它的 PTY
  // 就成了孤儿（旧窗口的标签随后被整个移除）。
  it('等待就绪期间标签又多了一个窗格：载荷按发送那一刻的最新窗格集合打包，不用陈旧快照', async () => {
    const done = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)

    // 焦点也跟着挪到新窗格上——只加窗格不挪焦点的话 activePaneIndex 两边都算成 0，
    // "用没用陈旧快照"这件事在这个字段上就没有区分力了。
    useTabs.setState((st) => ({
      tabs: st.tabs.map((t) =>
        t.id === 'tab-b'
          ? { ...t, panes: [...t.panes, { id: 'pane-b2', ptyId: 'pty-b2', title: 'B2' }], activePaneId: 'pane-b2' }
          : t,
      ),
    }))

    fireReady('term-1')
    await vi.advanceTimersByTimeAsync(0)
    fireAck('term-1', 'tab-b')
    expect(await done).toBe(true)

    const payload = emitToMock.mock.calls[0][2] as HandoffPayload
    expect(payload.panes.map((p) => p.ptyId)).toEqual(['pty-b', 'pty-b2'])
    expect(payload.activePaneIndex).toBe(1)
  })

  // R2/I2：重新取标签发生在**发送载荷之前**，但移除标签发生在**等到 ack 之后**——中间
  // 还隔着 emitTo 和最长 5s 的等待，用户完全可能在这段时间里 ⌘D 加个已经起好会话的窗格。
  // 按 tab id 整块删会把这个**没有交接出去**的窗格一起删掉，它的 PTY 于是两个窗口都没有。
  it('等 ack 期间又加了个窗格：只移除这次真的交接出去的那些，新窗格连同标签一起留下', async () => {
    const done = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)
    fireReady('term-1')
    await vi.advanceTimersByTimeAsync(0) // 载荷已发出，此刻交接出去的只有 pane-b

    useTabs.setState((st) => ({
      tabs: st.tabs.map((t) =>
        t.id === 'tab-b' ? { ...t, panes: [...t.panes, { id: 'pane-late', ptyId: 'pty-late', title: '后来的' }] } : t,
      ),
    }))

    fireAck('term-1', 'tab-b')
    expect(await done).toBe(true)

    const tab = useTabs.getState().tabs.find((t) => t.id === 'tab-b')
    expect(tab).toBeTruthy()
    expect(tab!.panes.map((p) => p.ptyId)).toEqual(['pty-late'])
    expect(tab!.activePaneId).toBe('pane-late') // 焦点原本在被交接走的那个窗格上
    expect(ipc.ptyKill).not.toHaveBeenCalled()
  })

  // R2/I3：pty-output 是全应用广播，交接之后旧窗口仍会收到这个 PTY 的输出，而它的
  // TerminalView 已经卸载（sinks 里没有它），每一条都会被塞进 buffers——旧窗口再也不会
  // attachPty 这个 id，没有任何路径清它。拖走一个持续刷屏的会话 = 一条无界内存曲线。
  it('交接成功后旧窗口不再攒该 PTY 的输出（否则内存随该会话输出量无限增长）', async () => {
    useTabs.setState({
      tabs: [HOME, TAB_A, { ...TAB_B, panes: [{ id: 'pane-i3', ptyId: 'pty-i3', title: 'B' }], activePaneId: 'pane-i3' }],
      activeId: 'tab-b',
    })
    const done = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)
    fireReady('term-1')
    await vi.advanceTimersByTimeAsync(0)
    fireAck('term-1', 'tab-b')
    expect(await done).toBe(true)

    // 交接之后这个 PTY 继续刷屏。
    firePtyOutput('pty-i3', 'after-handoff-1')
    firePtyOutput('pty-i3', 'after-handoff-2')

    // 真实状态断言：这些输出既没被缓存、也不会在任何人 attach 时冒出来。
    const written: string[] = []
    attachPty('pty-i3', (b) => { written.push(new TextDecoder().decode(b)) }, () => {})
    expect(written).toEqual([])
  })

  it('等待就绪期间标签被关掉了：不发载荷、关掉建出来的新窗口、给出提示', async () => {
    const done = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)

    useTabs.setState((st) => ({ tabs: st.tabs.filter((t) => t.id !== 'tab-b'), activeId: 'home' }))

    fireReady('term-1')
    expect(await done).toBe(false)
    expect(emitToMock).not.toHaveBeenCalled()
    expect(ipc.destroyTermWindow).toHaveBeenCalledTimes(1)
    expect(useHint.getState().message).toBe('新窗口没能接管这个标签，已留在原窗口')
  })
})

describe('tearOutTab — 失败与超时一律回滚（设计文档 §4.3）', () => {
  it('新窗口就绪超时：标签仍在旧窗口，且已请求关闭那个建出来的窗口', async () => {
    const done = tearOutTab('tab-b', { x: 300, y: 200 })
    await vi.advanceTimersByTimeAsync(0)
    expect(invokeMock).toHaveBeenCalledWith('create_term_window', { x: 300, y: 200 })

    // 就绪事件永远不来。先推进到超时**之前**一刻：此时绝不能已经判失败——否则这条
    // 用例只是在验"总有一天会超时"，而不是"在 READY_TIMEOUT_MS 这个时长上超时"（用例
    // 用同一个常量推进时间，不钉住下边界的话，实现改用任何别的时长都照样绿）。
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS - 1)
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
    expect(useHint.getState().message).toBeNull()

    await vi.advanceTimersByTimeAsync(2)
    expect(await done).toBe(false)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')!.panes[0].ptyId).toBe('pty-b')
    expect(ipc.destroyTermWindow).toHaveBeenCalledWith('term-1')
    expect(ipc.destroyTermWindow).toHaveBeenCalledTimes(1)
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    expect(useHint.getState().message).toBe('新窗口没能接管这个标签，已留在原窗口')
  })

  it('接管确认（ack）超时：标签仍在旧窗口，且已请求关闭那个建出来的窗口', async () => {
    const done = tearOutTab('tab-b', { x: 300, y: 200 })
    await vi.advanceTimersByTimeAsync(0)
    fireReady('term-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(emitToMock).toHaveBeenCalledTimes(1) // 载荷确实发出去了，只是没人回

    // 同上：先钉住"ACK_TIMEOUT_MS 之前一刻还没判失败"。这条下边界正是"ack 误用了
    // READY_TIMEOUT_MS（10s）"这类换错常量的缺陷唯一能被抓住的地方。
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS - 1)
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
    expect(useHint.getState().message).toBeNull()

    await vi.advanceTimersByTimeAsync(2)
    expect(await done).toBe(false)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')!.panes[0].ptyId).toBe('pty-b')
    expect(ipc.destroyTermWindow).toHaveBeenCalledTimes(1)
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    expect(useHint.getState().message).toBe('新窗口没能接管这个标签，已留在原窗口')
  })

  it('create_term_window 返回 Err：标签仍在旧窗口，且没有任何残留窗口需要关（压根没建出来）', async () => {
    invokeMock.mockRejectedValue('创建新窗口失败：boom')

    expect(await tearOutTab('tab-b', { x: 300, y: 200 })).toBe(false)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')!.panes[0].ptyId).toBe('pty-b')
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
    expect(emitToMock).not.toHaveBeenCalled()
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    expect(useHint.getState().message).toBe('新窗口创建失败，标签已留在原窗口')
    expect(listeners.get(HANDOFF_READY_EVENT)?.size ?? 0).toBe(0)
    expect(listeners.get(HANDOFF_ACK_EVENT)?.size ?? 0).toBe(0)
  })

  it('关掉残留窗口本身再失败也不会连累回滚：标签依然留在旧窗口', async () => {
    vi.mocked(ipc.destroyTermWindow).mockRejectedValue(new Error('窗口已经不在了'))

    const done = tearOutTab('tab-b', { x: 1, y: 1 })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 1)

    expect(await done).toBe(false)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
  })

  // R2/I4：回滚发生在"新窗口已经接管过一轮"之后——它挂载 TerminalView 时 fit() 并把 PTY
  // 拧成了自己的几何。新窗口关掉后旧窗口的 xterm 尺寸没变、ResizeObserver 不触发，PTY
  // 就永远停在错误列宽上，用户在"交接失败、标签留在原窗口"之后看到排版错乱的终端。
  it('ack 超时回滚：把 PTY 尺寸拧回旧窗口自己的几何', async () => {
    vi.mocked(ipc.lastPtySize).mockReturnValue({ cols: 203, rows: 51 })

    const done = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)
    fireReady('term-1')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1)
    expect(await done).toBe(false)

    expect(ipc.ptyResize).toHaveBeenCalledWith('pty-b', 203, 51)
  })

  it('载荷发送本身就失败了（emitTo reject）：新窗口不可能接管过，不去动 PTY 尺寸', async () => {
    vi.mocked(ipc.lastPtySize).mockReturnValue({ cols: 203, rows: 51 })
    emitToMock.mockRejectedValueOnce(new Error('目标窗口已经不在了'))

    const done = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)
    fireReady('term-1')
    expect(await done).toBe(false)

    expect(ipc.ptyResize).not.toHaveBeenCalled()
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
    expect(ipc.destroyTermWindow).toHaveBeenCalledTimes(1)
  })

  it('就绪超时回滚：载荷压根没发出去、新窗口不可能接管过，不去动 PTY 尺寸', async () => {
    vi.mocked(ipc.lastPtySize).mockReturnValue({ cols: 203, rows: 51 })

    const done = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 1)
    expect(await done).toBe(false)

    expect(ipc.ptyResize).not.toHaveBeenCalled()
  })

  // R2/M6：握手是异步的（最坏十几秒），期间标签仍留在标签栏里、照样能再拖一次。没有锁
  // 的话会并发建出第二个窗口、发第二份载荷，两次交接争同一个标签。
  it('同一个标签的交接进行中时，再次拖出直接拒绝，不会并发建出第二个窗口', async () => {
    const first = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)

    expect(await tearOutTab('tab-b', { x: 0, y: 0 })).toBe(false)
    expect(invokeMock).toHaveBeenCalledTimes(1) // 只建了一个窗口

    fireReady('term-1')
    await vi.advanceTimersByTimeAsync(0)
    fireAck('term-1', 'tab-b')
    expect(await first).toBe(true)

    // 锁在 finally 里释放：这一轮结束后同一个 id 能再次发起（虽然标签已经不在了）。
    expect(await tearOutTab('tab-b', { x: 0, y: 0 })).toBe(false) // 标签已移除，走的是"标签不存在"这条
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  // ── Task 5 / Ruling 12：交接锁必须在**每一条**路径上释放 ──────────────────────
  //
  // 锁没释放的后果比它挡的问题更糟：closeTab 从此对这个标签永久早退，用户按 ⌘W、点 ×
  // 都毫无反应，标签再也关不掉。下面两条都不满足于"某个 mock 没被调用"——它们直接用
  // 真实的 closeTab 去关那个标签，断言 store 里标签真的没了、PTY 真的被 kill 了。

  it('回滚之后锁必须已释放：该标签仍然关得掉（真的调 closeTab，断言标签从 store 消失、PTY 被 kill）', async () => {
    const done = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)
    fireReady('term-1')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1)
    expect(await done).toBe(false)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])

    await useTabs.getState().closeTab('tab-b', async () => true)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a'])
    expect(ipc.ptyKill).toHaveBeenCalledWith('pty-b')
  })

  // 这条挡的是一个真实存在过的泄漏路径：listen() 走的是真实 IPC，会 reject。改之前
  // 上锁与两次 listen 都在 try **之外**，listen 失败时锁就永远留在 Set 里。
  it('连监听都没注册成功（listen reject）也要释放锁：标签仍然关得掉', async () => {
    listenMock.mockRejectedValueOnce(new Error('事件桥挂了'))

    expect(await tearOutTab('tab-b', { x: 0, y: 0 })).toBe(false)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])

    await useTabs.getState().closeTab('tab-b', async () => true)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a'])
    expect(ipc.ptyKill).toHaveBeenCalledWith('pty-b')
  })

  // Ruling 12 / 原 M7：握手期间标签仍留在标签栏里、可见可点。用户此刻按 ⌘W，closeTab
  // 会照常 ptyKill——而新窗口很可能**已经接管成功**（ack 还在路上），杀掉的就是正在跑的
  // claude 会话。断言"该活着的确实还活着"：标签仍在 store 里、pty-b 一次都没被 kill。
  it('交接进行中按 ⌘W 关标签：拒绝并给出可见提示，标签与 PTY 都原封不动', async () => {
    const done = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)
    fireReady('term-1')
    await vi.advanceTimersByTimeAsync(0) // 载荷已发出，新窗口此刻可能已经接管

    await useTabs.getState().closeTab('tab-b', async () => true)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')!.panes[0].ptyId).toBe('pty-b')
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    // 早退不许静默：用户得知道 ⌘W 为什么没反应，否则只会反复猛按。
    expect(useHint.getState().message).toBe(HANDOFF_IN_FLIGHT_HINT)

    fireAck('term-1', 'tab-b')
    expect(await done).toBe(true)
  })

  it('目标标签不存在 / 不是终端标签时直接拒绝，不建窗', async () => {
    expect(await tearOutTab('tab-does-not-exist', { x: 0, y: 0 })).toBe(false)
    expect(await tearOutTab('home', { x: 0, y: 0 })).toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
  })

  it('别的窗口的就绪事件不算数：label 不匹配时继续等，直到超时仍然保留标签', async () => {
    const done = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)

    fireReady('term-999') // 不是我们刚建的那一个
    await vi.advanceTimersByTimeAsync(0)
    expect(emitToMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 1)
    expect(await done).toBe(false)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
  })
})

// V3.4 §5.3：把标签交接给一个**已经存在的**窗口。与 tearOutTab 共用同一条尾巴
// （handoffToLabel：序列化 → emitTo → 等 ack → 移除），差别只有三处：不建窗、不等就绪；
// 失败时**绝不关目标窗口**；成功之后可能把自己这个空壳窗口关掉。
describe('handoffTabToWindow — 交接给已存在的窗口（V3.4 设计文档 §5.3）', () => {
  it('定向发载荷、等到 ack 才移除标签，全程一次都没去建新窗口', async () => {
    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)

    // 正面对照：载荷确实发出去了（否则下面那条"没建窗"就是恒真——分流压根没跑也一样绿）。
    expect(emitToMock).toHaveBeenCalledTimes(1)
    const [label, event, payload] = emitToMock.mock.calls[0] as [string, string, HandoffPayload]
    expect(label).toBe('term-5')
    expect(event).toBe(HANDOFF_EVENT)
    expect(payload.toLabel).toBe('term-5')
    expect(payload.panes[0].ptyId).toBe('pty-b')
    // 目标窗口本来就在，这条路一次都不该碰 create_term_window。
    expect(invokeMock).not.toHaveBeenCalled()

    // ack 没到，标签必须还在。
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])

    fireAck('term-5', 'tab-b')
    expect(await done).toBe(true)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a'])
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    // 临时的 ack 监听摘干净了（断的是假事件总线里真实剩下的 handler 数量）。
    expect(listeners.get(HANDOFF_ACK_EVENT)?.size ?? 0).toBe(0)
  })

  // V3.3 Ruling 5 在这条新路上同样成立：序列化与"重新取标签"都发生在**发送那一刻**，
  // 不是函数开头。中间隔着 currentWindowLabel + listen 两次真实 IPC 往返，用户完全可能
  // 在这期间 ⌘D 加个窗格——沿用陈旧快照会漏掉它，它的 PTY 随即成为孤儿。
  it('载荷按发送那一刻的最新窗格集合打包，不用函数开头那份快照', async () => {
    const done = handoffTabToWindow('tab-b', 'term-5')
    // 还没让出过任何一次微任务：此刻改 store，实现若在函数开头就取好快照就会漏掉它。
    useTabs.setState((st) => ({
      tabs: st.tabs.map((t) =>
        t.id === 'tab-b'
          ? { ...t, panes: [...t.panes, { id: 'pane-b2', ptyId: 'pty-b2', title: 'B2' }], activePaneId: 'pane-b2' }
          : t,
      ),
    }))
    await vi.advanceTimersByTimeAsync(0)

    const payload = emitToMock.mock.calls[0][2] as HandoffPayload
    expect(payload.panes.map((p) => p.ptyId)).toEqual(['pty-b', 'pty-b2'])
    expect(payload.activePaneIndex).toBe(1)

    fireAck('term-5', 'tab-b')
    expect(await done).toBe(true)
  })

  it('序列化发生在发送那一刻（不是函数开头）', async () => {
    serializeTermMock.mockReturnValue('[31mRED[0m')
    const done = handoffTabToWindow('tab-b', 'term-5')
    expect(serializeTermMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(0)
    expect(serializeTermMock).toHaveBeenCalledWith('pty-b')
    expect((emitToMock.mock.calls[0][2] as HandoffPayload).panes[0].scrollback).toBe('[31mRED[0m')

    fireAck('term-5', 'tab-b')
    expect(await done).toBe(true)
  })

  // §5.3：超时的处理与 tearOutTab **只差这一处**——目标窗口本来就在，不是本次建的，
  // 关掉它就是把用户另一个正在用的窗口连同里面所有会话一起端掉。
  it('ack 超时：标签仍在本窗口，且绝不去关目标窗口（它不是本次建的）', async () => {
    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    expect(emitToMock).toHaveBeenCalledTimes(1) // 正面对照：载荷确实发出去了，只是没人回

    // 先钉住"ACK_TIMEOUT_MS 之前一刻还没判失败"：不钉下边界的话，实现改用任何别的时长
    // 都照样绿。
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS - 1)
    expect(useHint.getState().message).toBeNull()

    await vi.advanceTimersByTimeAsync(2)
    expect(await done).toBe(false)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')!.panes[0].ptyId).toBe('pty-b')
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    expect(useHint.getState().message).toBe('目标窗口没能接管这个标签，已留在原窗口')
  })

  // R2/I4 在这条路上同样成立：目标窗口可能已经接管过一轮并把 PTY 拧成了它自己的几何。
  it('ack 超时回滚：把 PTY 尺寸拧回本窗口自己的几何', async () => {
    vi.mocked(ipc.lastPtySize).mockReturnValue({ cols: 203, rows: 51 })

    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1)
    expect(await done).toBe(false)

    expect(ipc.ptyResize).toHaveBeenCalledWith('pty-b', 203, 51)
  })

  it('载荷发送本身就失败了（emitTo reject）：目标窗口不可能接管过，不去动 PTY 尺寸，也不关它', async () => {
    vi.mocked(ipc.lastPtySize).mockReturnValue({ cols: 203, rows: 51 })
    emitToMock.mockRejectedValueOnce(new Error('目标窗口已经不在了'))

    expect(await handoffTabToWindow('tab-b', 'term-5')).toBe(false)

    expect(ipc.ptyResize).not.toHaveBeenCalled()
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
    // 正面对照：这次失败确实是走完发送这一步之后才发生的（提示已经出来了），不是在更早
    // 的地方就早退了。
    expect(useHint.getState().message).toBe('目标窗口没能接管这个标签，已留在原窗口')
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
  })

  it('ack 的 label 对不上时不算数：不能被别的窗口的 ack 顶掉，继续等到超时', async () => {
    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)

    fireAck('term-999', 'tab-b')
    await vi.advanceTimersByTimeAsync(0)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])

    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1)
    expect(await done).toBe(false)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
  })

  // ── C1（V3.4 终审）：ack 认领必须能区分**同一目标窗口**的两次交接 ────────────────
  //
  // V3.3 的 tearOutTab 认领的是 create_term_window 刚返回的**新窗口** label——每次交接都
  // 不一样，天然唯一，所以只比 label 就够了。复用同一条尾巴的 handoffTabToWindow 认领的
  // 却是**一个已经存在的窗口**的 label，它不随交接变化：同一个源窗口向同一个目标连着甩
  // 两个标签（目标一忙，ack 排在一堆 pty-output 后面，用户完全来得及甩第二个），两条 ack
  // 监听器认领的是同一个字符串，目标回的**第一条** ack 会把两条等待一起 resolve。
  //
  // 后果是本模块唯一一条硬不变式被抽掉：第二个标签在目标**尚未确认**时就被
  // removeTabKeepingPty 移除。目标若在这个空档里没能接管（正在关闭、或正在自毁的空壳），
  // 标签两边都没有、PTY 成孤儿；紧随其后的 closeSelfIfEmptyShell 还会让源窗口误判成空壳
  // 自毁。因此载荷与 ack 都带上 tabId，认领改成 label + tabId 两者都对上。
  it('同一目标窗口的两次并发交接：目标只回一次 ack 时，第二个标签必须仍在源窗口', async () => {
    // 一前一后甩出去（正是终审描述的场景：目标一忙、ack 排在一堆 pty-output 后面，用户
    // 完全来得及甩第二个）。两次之间推一轮，让第一条链走到"已发载荷、正在等 ack"。
    const first = handoffTabToWindow('tab-a', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    const second = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)

    expect(emitToMock).toHaveBeenCalledTimes(2)
    expect(emitToMock.mock.calls.map((c) => (c[2] as HandoffPayload).panes[0].ptyId)).toEqual(['pty-a', 'pty-b'])
    expect(listeners.get(HANDOFF_ACK_EVENT)?.size ?? 0).toBe(2)

    // 目标只确认了第一次交接。
    fireAck('term-5', 'tab-a')
    expect(await first).toBe(true)
    await vi.advanceTimersByTimeAsync(0)

    // tab-a 交出去了；**tab-b 必须原封不动留着**——目标还没说它接管了 tab-b。
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-b'])
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')!.panes[0].ptyId).toBe('pty-b')
    expect(ipc.ptyKill).not.toHaveBeenCalled()

    // 第二次照常等到自己的 ack（或超时）：这里让它超时，标签仍在。
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1)
    expect(await second).toBe(false)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-b'])
  })

  it('tabId 对得上、label 对不上的 ack 同样不算数（两个字段都要比，不是二选一）', async () => {
    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)

    fireAck('term-999', 'tab-b') // tabId 对，label 是别的窗口报的
    await vi.advanceTimersByTimeAsync(0)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])

    // 正面对照：两个字段都对上时确实认。
    fireAck('term-5', 'tab-b')
    expect(await done).toBe(true)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a'])
  })

  it('载荷里带上本次交接的 tabId，接管方按它回带（发起方据此认领）', async () => {
    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    expect((emitToMock.mock.calls[0][2] as HandoffPayload).tabId).toBe('tab-b')
    fireAck('term-5', 'tab-b')
    expect(await done).toBe(true)
  })

  // 与 tearOutTab 那条 ack 监听同构的两头防护（终审 M1）。发起方 label 刻意取一个
  // **不是 'main'** 的值（Ruling 14）：用 'main' 的话把实现写死成 `{ target: 'main' }`
  // 这条断言照样绿。
  it('ack 监听限定 target 为发起方自己的 label，且这道限定不会把真正该收的 ack 挡在门外', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-3' })

    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)

    const ackCall = listenMock.mock.calls.find((c) => c[0] === HANDOFF_ACK_EVENT)
    expect(ackCall).toBeTruthy()
    expect(ackCall![2]).toEqual({ target: 'term-3' })
    // 载荷里的 fromLabel 也是它——接管方据此把 ack 定向发回来。
    expect((emitToMock.mock.calls[0][2] as HandoffPayload).fromLabel).toBe('term-3')

    // 另一半：走替身的真实投递语义（不用 fireAck 那个绕过 target 过滤的辅助函数）。
    await emitToMock('term-3', HANDOFF_ACK_EVENT, { label: 'term-5', tabId: 'tab-b' })
    await vi.advanceTimersByTimeAsync(0)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a'])
    expect(await done).toBe(true)
  })

  // 拒绝要发生在**进入握手之前**：走进去再由共享尾巴抛出，结果虽然也是"没交接"，但会
  // 顺带给用户弹一条"目标窗口没能接管这个标签"——一次本来就不该开始的手势弹一条像是
  // 出了故障的提示，比什么都不做糟。
  it('目标标签不存在 / 不是终端标签时直接拒绝：不发载荷，也不弹那条失败提示', async () => {
    expect(await handoffTabToWindow('tab-does-not-exist', 'term-5')).toBe(false)
    expect(await handoffTabToWindow('home', 'term-5')).toBe(false)
    expect(emitToMock).not.toHaveBeenCalled()
    expect(useHint.getState().message).toBeNull()
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])

    // 正面对照：同一份替身下，一个合法的标签确实能把载荷发出去——上面那两条"没发"不是
    // 因为这条路在本用例的环境里压根不通。
    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    expect(emitToMock).toHaveBeenCalledTimes(1)
    fireAck('term-5', 'tab-b')
    expect(await done).toBe(true)
  })

  // ── 交接锁：新增的每一条路径都要释放（Ruling 12） ─────────────────────────────
  // 锁没释放 = 那个标签**永久关不掉**，比它挡的问题更糟。下面几条都不满足于"某个 mock
  // 没被调用"——它们直接用真实的 closeTab 去关那个标签，断言 store 里标签真的没了、
  // PTY 真的被 kill 了。

  it('成功之后锁已释放：同一个标签能再次发起（不是被锁永久挡住）', async () => {
    const done = handoffTabToWindow('tab-a', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    fireAck('term-5', 'tab-a')
    expect(await done).toBe(true)

    // 标签已经交出去了，这一次走的是"标签不存在"那条；关键是它**没有**被锁早退——把
    // tab-a 换成仍然在的 tab-b 再发一次，载荷照样发得出去。
    emitToMock.mockClear()
    const again = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    expect(emitToMock).toHaveBeenCalledTimes(1)
    fireAck('term-5', 'tab-b')
    expect(await again).toBe(true)
  })

  it('超时回滚之后锁已释放：该标签仍然关得掉（真的调 closeTab，断言标签从 store 消失、PTY 被 kill）', async () => {
    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1)
    expect(await done).toBe(false)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])

    await useTabs.getState().closeTab('tab-b', async () => true)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a'])
    expect(ipc.ptyKill).toHaveBeenCalledWith('pty-b')
  })

  it('连 ack 监听都没注册成功（listen reject）也要释放锁：标签仍然关得掉', async () => {
    listenMock.mockRejectedValueOnce(new Error('事件桥挂了'))

    expect(await handoffTabToWindow('tab-b', 'term-5')).toBe(false)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])

    await useTabs.getState().closeTab('tab-b', async () => true)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a'])
    expect(ipc.ptyKill).toHaveBeenCalledWith('pty-b')
  })

  it('同一个标签的交接进行中时再交接一次：直接拒绝，且不会误放掉正在进行的那一把锁', async () => {
    const first = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    expect(emitToMock).toHaveBeenCalledTimes(1)

    expect(await handoffTabToWindow('tab-b', 'term-6')).toBe(false)
    expect(emitToMock).toHaveBeenCalledTimes(1) // 没有并发发出第二份载荷

    // 被拒绝的那一次没有把第一次的锁放掉：此刻 ⌘W 仍然关不掉这个标签（正在交接中）。
    await useTabs.getState().closeTab('tab-b', async () => true)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    expect(useHint.getState().message).toBe(HANDOFF_IN_FLIGHT_HINT)

    fireAck('term-5', 'tab-b')
    expect(await first).toBe(true)
  })

  // 「取消」那一路（命中别的窗口但不在标签栏落区）压根不会走到这个模块——它在 TabBar 的
  // 分流里就返回了。锁在那条路上没被占用过这件事在 TabBar.test.tsx 里钉（取消之后标签
  // 仍然关得掉）：那里才是那条路真正跑过的地方。
})

// V3.4 §5.4 / Ruling 3：交接出最后一个终端标签之后，这个 term-* 窗口就是个空壳，关掉它。
// **顺序写死**：ack → removeTabKeepingPty → 确认已无终端标签 → destroy。提前 destroy
// 会让交接中的标签两边都没有。
describe('空壳窗口自动关闭（V3.4 设计文档 §5.4）', () => {
  it('term-* 窗口交出最后一个终端标签：ack 之后才关自己，ack 之前一步都不动', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-3' })
    useTabs.setState({ tabs: [HOME, TAB_B], activeId: 'tab-b' })

    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    // 载荷已发出、ack 还没到。**此刻绝不能 destroy**：本窗口连同它那份还没被移除的标签
    // 一起消失，而目标窗口可能压根没接管成功——两个窗口都没有这个标签。
    expect(emitToMock).toHaveBeenCalledTimes(1) // 正面对照：确实已经走到"等 ack"这一步了
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-b'])

    fireAck('term-5', 'tab-b')
    expect(await done).toBe(true)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home'])
    expect(ipc.destroyTermWindow).toHaveBeenCalledWith('term-3')
    expect(ipc.destroyTermWindow).toHaveBeenCalledTimes(1)
    // 空壳窗口不持有任何 PTY，关它一个会话都不会死。
    expect(ipc.ptyKill).not.toHaveBeenCalled()
  })

  it('本窗口还剩别的终端标签：不关自己（只有真的空壳才关）', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-3' })
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-b' })

    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    fireAck('term-5', 'tab-b')
    expect(await done).toBe(true)

    // 正面对照：交接本身确实成功了（标签真的没了），只是窗口里还剩 tab-a。
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a'])
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
  })

  // 等 ack 期间用户给这个标签 ⌘D 加了个新窗格：removeTabKeepingPty 只摘走交接出去的那些、
  // 标签本身留着，这个窗口还装着活着的 PTY，关掉它就是把用户正在跑的会话连窗口一起端了。
  it('等 ack 期间又加了个窗格（标签因此留了下来）：不关自己', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-3' })
    useTabs.setState({ tabs: [HOME, TAB_B], activeId: 'tab-b' })

    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    useTabs.setState((st) => ({
      tabs: st.tabs.map((t) =>
        t.id === 'tab-b' ? { ...t, panes: [...t.panes, { id: 'pane-late', ptyId: 'pty-late', title: '后来的' }] } : t,
      ),
    }))
    fireAck('term-5', 'tab-b')
    expect(await done).toBe(true)

    // 正面对照：交接确实成功了（原来那个窗格被摘走了），只是标签因为新窗格留了下来。
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')!.panes.map((p) => p.ptyId)).toEqual(['pty-late'])
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
  })

  // §3 明确列为"不做"：主窗口永远不因标签为空而关闭——它还是侧边栏/总览/设置的入口，
  // 留个主页不算空壳。
  it('主窗口交出最后一个终端标签：绝不自动关闭', async () => {
    currentWindowMock.mockReturnValue({ label: 'main' })
    useTabs.setState({ tabs: [HOME, TAB_B], activeId: 'tab-b' })

    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    fireAck('term-5', 'tab-b')
    expect(await done).toBe(true)

    // 正面对照：交接确实成功、窗口里确实一个终端标签都不剩了——条件全部满足，只有
    // "我是主窗口"这一条把它拦住了。
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home'])
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
  })

  it('交接失败时不关自己（标签还在本窗口，根本不是空壳）', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-3' })
    useTabs.setState({ tabs: [HOME, TAB_B], activeId: 'tab-b' })

    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1)
    expect(await done).toBe(false)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-b'])
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
  })

  // ── M1（V3.4 终审）：自毁的 IPC 往返中间落进来的交接载荷 ────────────────────────
  //
  // destroy_term_window 是一次 IPC：命令发出到 Rust 真的销毁窗口之间隔着至少一次让出。
  // 别的窗口（A→B 与 B→A 同时发生就是自然触发器）的交接载荷若恰好落在这个空档里，
  // handleHandoff 会照常 adopt 出一个终端标签、还会回 ack——发起方据此删掉自己那份，
  // 而这个窗口紧接着就被销毁了。destroy **绕过 CloseRequested、不杀任何 PTY**，于是那个
  // 会话变成谁都看不到、也关不掉的孤儿，标签两边都没有。
  it('已经决定自毁之后落进来的交接载荷：拒收——不 adopt、不回 ack（否则它会随窗口一起消失）', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-3' })
    useTabs.setState({ tabs: [HOME, TAB_B], activeId: 'tab-b' })
    // destroy 的 IPC 停在半路：模拟"命令已经发出、Rust 还没真的销毁窗口"这个真实空档。
    let releaseDestroy!: () => void
    vi.mocked(ipc.destroyTermWindow).mockImplementation(
      () => new Promise<void>((r) => { releaseDestroy = () => r() }),
    )

    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    fireAck('term-5', 'tab-b')
    await vi.advanceTimersByTimeAsync(0)
    // 正面对照：本窗口确实已经走到"正在自毁"这一步了。
    expect(ipc.destroyTermWindow).toHaveBeenCalledWith('term-3')

    const emitsBefore = emitToMock.mock.calls.length
    await handleHandoff({
      fromLabel: 'term-7',
      tabId: 'src-tab-late',
      toLabel: 'term-3',
      activePaneIndex: 0,
      panes: [{ ptyId: 'pty-late', title: '迟到的', cwd: null, scrollback: '' }],
    })

    // 断真实 store 状态：没有 adopt 出任何标签。
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home'])
    // 也一条 ack 都没回（用增量比对而不是 not.toHaveBeenCalled——上面本来就有调用记录）。
    expect(emitToMock.mock.calls.length).toBe(emitsBefore)

    releaseDestroy()
    expect(await done).toBe(true)
  })

  // 旗子不能是单向的：destroy 失败意味着窗口还活着，它此后必须还能正常接管，否则一次
  // 失败的自毁会把这个窗口变成一个永远收不了交接的黑洞。
  it('自毁失败之后本窗口恢复接管能力（拒收标记必须放下）', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-3' })
    useTabs.setState({ tabs: [HOME, TAB_B], activeId: 'tab-b' })
    vi.mocked(ipc.destroyTermWindow).mockRejectedValue(new Error('窗口已经不在了'))

    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    fireAck('term-5', 'tab-b')
    expect(await done).toBe(true)
    expect(ipc.destroyTermWindow).toHaveBeenCalledWith('term-3')

    await handleHandoff({
      fromLabel: 'term-7',
      tabId: 'src-tab-after',
      toLabel: 'term-3',
      activePaneIndex: 0,
      panes: [{ ptyId: 'pty-after', title: '自毁失败之后', cwd: null, scrollback: '' }],
    })

    const tabs = useTabs.getState().tabs
    expect(tabs.map((t) => t.kind)).toEqual(['home', 'term'])
    expect(tabs[1].panes.map((p) => p.ptyId)).toEqual(['pty-after'])
    expect(emitToMock).toHaveBeenCalledWith('term-7', HANDOFF_ACK_EVENT, { label: 'term-3', tabId: 'src-tab-after' })
  })

  it('关自己这一步失败也不影响这次交接的结果（标签已经交出去了，窗口没关掉只是个可见但无损的结果）', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-3' })
    useTabs.setState({ tabs: [HOME, TAB_B], activeId: 'tab-b' })
    vi.mocked(ipc.destroyTermWindow).mockRejectedValue(new Error('窗口已经不在了'))

    const done = handoffTabToWindow('tab-b', 'term-5')
    await vi.advanceTimersByTimeAsync(0)
    fireAck('term-5', 'tab-b')

    expect(await done).toBe(true)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home'])
    expect(useHint.getState().message).toBeNull() // 不该报成一次失败的交接
  })
})

describe('handleHandoff — 新窗口侧的接管（设计文档 §4.2 第 5 步）', () => {
  const payload: HandoffPayload = {
    fromLabel: 'main',
    tabId: 'src-tab-1',
    toLabel: 'term-1',
    activePaneIndex: 0,
    panes: [
      { ptyId: 'pty-b', sessionId: 'sess-b', title: 'B', cwd: '/tmp/demo', scrollback: 'hello', threadKey: 'demo:root-b', dirName: '-tmp-demo', rootKey: 'root-b' },
    ],
  }

  beforeEach(() => {
    // 这一组模拟的是**接管方**那个窗口：本窗口 label 必须与载荷的 toLabel 一致，否则
    // C1 的第一道校验会直接拒收（拒收本身另有专门用例覆盖）。
    currentWindowMock.mockReturnValue({ label: 'term-1' })
    useTabs.setState({ tabs: [HOME], activeId: 'home' })
  })

  it('建出标签与窗格、绑定原来的 ptyId、回 ack 给来源窗口', async () => {
    await handleHandoff(payload)

    const tabs = useTabs.getState().tabs
    expect(tabs.length).toBe(2)
    const adopted = tabs[1]
    expect(adopted.kind).toBe('term')
    expect(adopted.title).toBe('B')
    expect(adopted.panes.map((p) => p.ptyId)).toEqual(['pty-b'])
    expect(adopted.panes[0].threadKey).toBe('demo:root-b')
    expect(adopted.panes[0].sessionId).toBe('sess-b')
    expect(useTabs.getState().activeId).toBe(adopted.id)
    // 接管的窗格绝不能重新 spawn 一个 PTY——那会凭空多起一个 claude 进程。
    expect(ipc.ptySpawn).not.toHaveBeenCalled()

    expect(emitToMock).toHaveBeenCalledWith('main', HANDOFF_ACK_EVENT, { label: 'term-1', tabId: 'src-tab-1' })
  })

  it('滚屏在标签进入 store 之前就排进了该 PTY 的待回放缓冲，attachPty 时第一批就是它', async () => {
    await handleHandoff(payload)

    const written: string[] = []
    const decoder = new TextDecoder()
    attachPty('pty-b', (bytes) => { written.push(decoder.decode(bytes)) }, () => {})
    expect(written[0]).toBe('hello')
  })

  // 多窗格标签（⌘D 分屏，最多 3 个）被整体拖出：载荷按窗格成数组，接管端必须把三个
  // 都建出来。若载荷只装得下一个终端，另外两个 PTY 会在旧窗口移除标签之后变成谁都
  // 看不到、也关不掉的孤儿进程——正是本任务要避免的用户可见损失。
  it('多窗格标签整体接管：三个窗格都建出来、焦点落在原来的那个、标题按窗格数重算', async () => {
    await handleHandoff({
      fromLabel: 'main',
      tabId: 'src-tab-multi',
      toLabel: 'term-1',
      activePaneIndex: 2,
      panes: [
        { ptyId: 'pty-1', title: '一', cwd: null, scrollback: '' },
        { ptyId: 'pty-2', title: '二', cwd: null, scrollback: '' },
        { ptyId: 'pty-3', title: '三', cwd: null, scrollback: '' },
      ],
    })

    const adopted = useTabs.getState().tabs[1]
    expect(adopted.panes.map((p) => p.ptyId)).toEqual(['pty-1', 'pty-2', 'pty-3'])
    expect(adopted.activePaneId).toBe(adopted.panes[2].id)
    expect(adopted.title).toBe('3 个对话')
    expect(adopted.paneWidths).toEqual([1 / 3, 1 / 3, 1 / 3])
  })

  // R1 的核心：旧窗口是在收到本窗口就绪事件之后才序列化的，所以 [本窗口监听就绪,
  // 旧窗口序列化] 这一小段实时输出同时躺在本窗口的缓冲里和快照里。不先清缓冲就会
  // 重复回放，Claude Code 跑在 alt-screen，重复的转义序列会把画面搞乱。
  // ptyBuffer 是模块级单例、状态跨用例保留（上面那条用例 attach 过 'pty-b' 且没有
  // detach），因此这两条各用自己的 ptyId，避免被别人留下的 sink 干扰。
  const withPty = (ptyId: string): HandoffPayload => ({
    ...payload,
    panes: [{ ...payload.panes[0], ptyId }],
  })

  it('写快照之前先丢弃该 ptyId 的既有缓冲：attachPty 只回放快照，不重放交接期间攒下的那份', async () => {
    // 交接期间到达、已经被本窗口 ptyBuffer 攒下的实时输出——它的内容也在快照里。
    firePtyOutput('pty-d1', 'already-buffered-and-also-in-snapshot')

    await handleHandoff(withPty('pty-d1'))

    const written: string[] = []
    const decoder = new TextDecoder()
    attachPty('pty-d1', (bytes) => { written.push(decoder.decode(bytes)) }, () => {})
    expect(written).toEqual(['hello'])
  })

  it('清掉的只是交接前那一份：接管之后新到的实时输出照常排在快照后面', async () => {
    firePtyOutput('pty-d2', 'stale')
    await handleHandoff(withPty('pty-d2'))
    firePtyOutput('pty-d2', 'fresh-after-handoff')

    const written: string[] = []
    const decoder = new TextDecoder()
    attachPty('pty-d2', (bytes) => { written.push(decoder.decode(bytes)) }, () => {})
    expect(written).toEqual(['hello', 'fresh-after-handoff'])
  })

  it('载荷里没有任何窗格时不建空标签，也不回 ack', async () => {
    await handleHandoff({ ...payload, panes: [] })
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home'])
    expect(emitToMock).not.toHaveBeenCalled()
  })
})

// 第 3 步：新窗口启动后主动发就绪事件。这条链跑在模块顶层（App.tsx 顶层
// side-effect 导入 './windowHandoff' 触发），因此要 resetModules 之后重新导入才能
// 在改了 label 的前提下重新执行一遍。
// R2/C1：emitTo 的 label 过滤对 target 为 Any 的监听器**无条件失效**（考据见
// windowHandoff.ts 顶部）。这一组盯的就是那条真实事故链：已开着 term-1 时再拖出一个
// 标签，term-1 也收到载荷、也接管、也回 ack → 同一个标签同时出现在两个窗口 → 用户关掉
// 多余那个 → closeTab 走 ptyKill → **正在跑的 claude 会话被杀**。
describe('C1 —— 定向投递不是私有信道，两层防护缺一不可', () => {
  it('载荷不是发给本窗口的（toLabel 对不上）：不建标签、也不回 ack', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-1' })
    useTabs.setState({ tabs: [HOME], activeId: 'home' })

    await handleHandoff({
      fromLabel: 'main',
      tabId: 'src-tab-x',
      toLabel: 'term-2', // 发给隔壁那个窗口的
      activePaneIndex: 0,
      panes: [{ ptyId: 'pty-x', title: 'X', cwd: null, scrollback: 'snap' }],
    })

    // 断的是真实 store 状态：没有多出任何标签。
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home'])
    // 更要命的是 ack：回了就等于替真正的接管方给了保证，发起方会据此删掉自己的标签。
    expect(emitToMock).not.toHaveBeenCalled()
  })

  it('已经开着的另一个 term-* 窗口不会收到发给别人的载荷（listen 限定了 target）', async () => {
    // 模拟一个早就存在的 term-1 窗口：它按 windowHandoffReady 的方式注册接管监听。
    currentWindowMock.mockReturnValue({ label: 'term-1' })
    vi.resetModules()
    const stale = await import('../windowHandoff')
    await stale.windowHandoffReady
    const staleHandler = vi.fn()
    // 取出它真正注册时用的 options，用同样的注册方式挂一个探针——探针收到，就说明真实
    // 监听器也会收到。
    const staleCall = listenMock.mock.calls.find((c) => c[0] === stale.HANDOFF_EVENT)
    expect(staleCall).toBeTruthy()
    expect(staleCall![2]).toEqual({ target: 'term-1' })
    await listenMock(stale.HANDOFF_EVENT, staleHandler, staleCall![2] as { target?: string })
    // 目标窗口 term-2 的探针，注册方式与 windowHandoffReady 完全一致。**这一个是关键**：
    // 没有它，下面 `staleHandler 没被调用` 就是一条恒真断言——替身若退回"只记录不投递"，
    // 谁都收不到，用例照样绿，而这正是这条 Critical 当初在单测里隐形的原因。
    const targetHandler = vi.fn()
    await listenMock(stale.HANDOFF_EVENT, targetHandler, { target: 'term-2' })

    // 主窗口拖出第二个标签，新窗口是 term-2。
    currentWindowMock.mockReturnValue({ label: 'main' })
    invokeMock.mockResolvedValue('term-2')
    const tabsMod = await import('../store/tabs')
    tabsMod.useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-b' })
    const done = stale.tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)
    fireReady('term-2')
    await vi.advanceTimersByTimeAsync(0)

    // 载荷确实投递到了目标窗口……
    expect(targetHandler).toHaveBeenCalledTimes(1)
    // ……而 term-1 的监听器一次都没被打到。
    expect(staleHandler).not.toHaveBeenCalled()

    fireAck('term-2', 'tab-b')
    await done
  })

  it('ack 的 label 对不上时不算数：不能被别的窗口的 ack 顶掉，继续等到超时并回滚', async () => {
    const done = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)
    fireReady('term-1')
    await vi.advanceTimersByTimeAsync(0)

    fireAck('term-999', 'tab-b') // 别的窗口回的 ack
    await vi.advanceTimersByTimeAsync(0)
    // 没有被顶掉——标签还在，交接也还没结束。
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])

    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1)
    expect(await done).toBe(false)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
  })

  // 终审 M1：ack 这条事件此前只做了半边——发送端是 `emitTo(payload.fromLabel, …)` 且载荷
  // 带接管方自己的 label，接收端却只有载荷比对、缺注册侧的 target。本分支的规矩是两头都
  // 做（Ruling 8 为此吃过一次 Critical，Ruling 15 又发现一个半成品）。
  //
  // 发起方的 label 刻意取一个**不是 'main'** 的值（链式拖出：从一个已经被拖出来的窗口里
  // 再拖一个标签出去，正是真机验收清单第 16 条那个场景）。用默认的 'main' 的话，把实现
  // 写死成 `{ target: 'main' }` 这条断言照样绿——初始值等于目标值，本分支已经栽过三次。
  it('ack 监听限定 target 为发起方自己的 label（与发送端 emitTo(fromLabel) 对齐）', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-3' })
    invokeMock.mockResolvedValue('term-4')

    const done = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)

    const ackCall = listenMock.mock.calls.find((c) => c[0] === HANDOFF_ACK_EVENT)
    expect(ackCall).toBeTruthy()
    expect(ackCall![2]).toEqual({ target: 'term-3' })

    // 另一半：这道限定不能把真正该收的 ack 挡在门外。走替身的真实投递语义
    // （emitTo → 命中 target 未声明的监听器 + target 恰为该 label 的监听器），不用
    // fireAck 那个绕过 target 过滤的辅助函数——那样就测不到这里想测的东西了。
    fireReady('term-4')
    await vi.advanceTimersByTimeAsync(0)
    await emitToMock('term-3', HANDOFF_ACK_EVENT, { label: 'term-4', tabId: 'tab-b' })
    await vi.advanceTimersByTimeAsync(0)

    // 断真实 store 状态：ack 真的被认下了，标签已经交出去。
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a'])
    expect(await done).toBe(true)
  })

  it('ack 报的是接管方自己的 label（不是把载荷里的 toLabel 原样回带）', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-5' })
    useTabs.setState({ tabs: [HOME], activeId: 'home' })

    await handleHandoff({
      fromLabel: 'main',
      tabId: 'src-tab-y',
      toLabel: 'term-5',
      activePaneIndex: 0,
      panes: [{ ptyId: 'pty-y', title: 'Y', cwd: null, scrollback: '' }],
    })

    expect(emitToMock).toHaveBeenCalledWith('main', HANDOFF_ACK_EVENT, { label: 'term-5', tabId: 'src-tab-y' })
  })
})

describe('windowHandoffReady — 新窗口启动时的接管入口（设计文档 §4.2 第 3 步）', () => {
  it('被拖出创建的窗口：先挂好接管监听，再发出带自己 label 的就绪事件', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-7' })
    vi.resetModules()
    const mod = await import('../windowHandoff')
    await mod.windowHandoffReady

    // 顺序是硬要求：就绪事件一发出去，旧窗口下一刻就会 emitTo 载荷过来——监听要是
    // 还没挂上，那份载荷就打在空处，一路等到 ack 超时。
    expect(listenMock.mock.calls.map((c) => c[0])).toContain(mod.HANDOFF_EVENT)
    const listenIdx = listenMock.mock.calls.findIndex((c) => c[0] === mod.HANDOFF_EVENT)
    expect(listenIdx).toBeGreaterThanOrEqual(0)
    expect(emitMock).toHaveBeenCalledWith(mod.HANDOFF_READY_EVENT, { label: 'term-7' })
    expect(listenMock.mock.invocationCallOrder[listenIdx]).toBeLessThan(emitMock.mock.invocationCallOrder[0])
  })

  it('先等自己的 pty-output 监听就绪，再宣告 ready——否则交接期间的输出会有一段谁都没收到', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-8' })
    let release!: () => void
    ptyListenGate.pending = new Promise<void>((r) => { release = r })
    vi.resetModules()
    const mod = await import('../windowHandoff')
    await vi.advanceTimersByTimeAsync(0)

    // pty-output 监听还没就绪：此刻宣告 ready，旧窗口就会立刻发载荷并在 ack 后移除
    // 标签，而这一段时间的实时输出新窗口一个字节都没攒到（旧窗口那份也随标签一起
    // 消失了）——那才是真正的空档。
    expect(emitMock).not.toHaveBeenCalled()

    ptyListenGate.pending = null
    release()
    await mod.windowHandoffReady
    expect(emitMock).toHaveBeenCalledWith(mod.HANDOFF_READY_EVENT, { label: 'term-8' })
  })

  // V3.4：主窗口**也挂接管监听**（标签现在可以拖回主窗口），但仍然不发就绪事件。
  // 就绪事件的语义是"我这个刚被 create_term_window 建出来的窗口起来了"——主窗口不是被谁
  // 建出来的，没有任何发起方在等它宣告就绪。
  it('主窗口：挂接管监听（V3.4 起它也是接收方），但仍然不发就绪事件', async () => {
    currentWindowMock.mockReturnValue({ label: 'main' })
    vi.resetModules()
    const mod = await import('../windowHandoff')
    await mod.windowHandoffReady

    expect(listenMock.mock.calls.map((c) => c[0])).toContain(mod.HANDOFF_EVENT)
    expect(emitMock).not.toHaveBeenCalled()
  })
})

// V3.4 §5.3：主窗口第一次成为交接的接收方。设计文档 §6 特别点名——去掉监听门禁之后，
// 它的 `{target}` 限定与载荷 `toLabel` 校验必须与 term-* 一致，两头防护一个字都不能松。
describe('主窗口作为接管方（V3.4：标签可以拖回主窗口）', () => {
  it('发给 main 的载荷主窗口收得到并真的建出标签、回 ack；target 为别的 label 的监听器一次都收不到', async () => {
    currentWindowMock.mockReturnValue({ label: 'main' })
    vi.resetModules()
    const mod = await import('../windowHandoff')
    const tabsMod = await import('../store/tabs')
    await mod.windowHandoffReady
    tabsMod.useTabs.setState({ tabs: [HOME], activeId: 'home' })

    // 主窗口真正注册时用的 options——两头防护的注册侧那一半。
    const mainCall = listenMock.mock.calls.find((c) => c[0] === mod.HANDOFF_EVENT)
    expect(mainCall).toBeTruthy()
    expect(mainCall![2]).toEqual({ target: 'main' })
    // 探针 label **刻意取 'main' 以外的值**（Ruling 14）：替身 label 与断言里的 target
    // 相同的话，"target 限定还在"就是一条恒真断言——替身若退回"只记录不投递"，或者实现
    // 把 target 整个删掉，用例照样绿。这个探针按 windowHandoffReady 完全一致的方式注册，
    // 只是 label 是隔壁那个 term-7 窗口。
    const otherWindowProbe = vi.fn()
    await listenMock(mod.HANDOFF_EVENT, otherWindowProbe, { target: 'term-7' })

    // 一个已经被拖出来的窗口把标签拖回主窗口：fromLabel 是它自己，toLabel 是 main。
    await emitToMock('main', mod.HANDOFF_EVENT, {
      fromLabel: 'term-7',
      tabId: 'src-tab-back',
      toLabel: 'main',
      activePaneIndex: 0,
      panes: [{ ptyId: 'pty-back', sessionId: 'sess-back', title: '拖回来的', cwd: null, scrollback: 'snap' }],
    } satisfies HandoffPayload)
    await vi.advanceTimersByTimeAsync(0)

    // 断真实 store 状态：标签真的建在主窗口里、追加在末尾、并且被激活。
    const tabs = tabsMod.useTabs.getState().tabs
    expect(tabs.map((t) => t.kind)).toEqual(['home', 'term'])
    expect(tabs[1].panes.map((p) => p.ptyId)).toEqual(['pty-back'])
    expect(tabsMod.useTabs.getState().activeId).toBe(tabs[1].id)
    // ack 定向回发起方，报的是主窗口自己的 label。
    expect(emitToMock).toHaveBeenCalledWith('term-7', mod.HANDOFF_ACK_EVENT, { label: 'main', tabId: 'src-tab-back' })
    // ……而隔壁窗口的监听器一次都没被打到。
    expect(otherWindowProbe).not.toHaveBeenCalled()
  })

  it('发给别的窗口的载荷主窗口不接管、也不回 ack（处理侧的 toLabel 校验没有因为它加入接收方而松动）', async () => {
    currentWindowMock.mockReturnValue({ label: 'main' })
    useTabs.setState({ tabs: [HOME], activeId: 'home' })

    await handleHandoff({
      fromLabel: 'term-7',
      tabId: 'src-tab-z',
      toLabel: 'term-2', // 发给隔壁那个窗口的
      activePaneIndex: 0,
      panes: [{ ptyId: 'pty-x', title: 'X', cwd: null, scrollback: 'snap' }],
    })

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home'])
    expect(emitToMock).not.toHaveBeenCalled()
  })
})

describe('isTornOutWindow — 用 label 前缀辨认"我是被拖出创建的新窗口"', () => {
  it('主窗口的 label 是 main，不是被拖出创建的', () => {
    expect(isTornOutWindow('main')).toBe(false)
  })

  it('create_term_window 分配的 term-<n> 才是被拖出创建的', () => {
    expect(isTornOutWindow('term-1')).toBe(true)
    expect(isTornOutWindow('term-42')).toBe(true)
  })

  it('既不是 main 也不是 term- 前缀的 label 一律按"不是"处理（不会误在别的窗口里抢接管）', () => {
    expect(isTornOutWindow('panel')).toBe(false)
    expect(isTornOutWindow('terminal-1')).toBe(false)
  })
})
