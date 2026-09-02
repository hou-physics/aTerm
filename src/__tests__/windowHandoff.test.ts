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
// 当前窗口的 label。默认 'main'：模块顶层的 windowHandoffReady 因此按"主窗口"早退，
// 不会在别的用例里顺手注册监听/发就绪事件。下面「新窗口启动」那组用例会临时改成
// term-<n> 再 resetModules 重新导入，模拟真的被拖出来的那个窗口。
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
  tearOutTab,
  type HandoffPayload,
} from '../windowHandoff'
import { isTornOutWindow } from '../windowLabel'
import { attachPty } from '../ptyBuffer'
import { useHint } from '../store/hint'
import { useSessions } from '../store/sessions'
import { HANDOFF_IN_FLIGHT_HINT, useTabs } from '../store/tabs'

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
/** 模拟"新窗口回了接管确认"。*/
function fireAck(label: string) {
  for (const h of listeners.get(HANDOFF_ACK_EVENT) ?? []) h({ payload: { label } })
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

    fireAck('term-1')
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
    fireAck('term-1')
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
    fireAck('term-1')
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
    fireAck('term-9')
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
    fireAck('term-1')
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

    fireAck('term-1')
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
    fireAck('term-1')
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
    fireAck('term-1')
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

    fireAck('term-1')
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

describe('handleHandoff — 新窗口侧的接管（设计文档 §4.2 第 5 步）', () => {
  const payload: HandoffPayload = {
    fromLabel: 'main',
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

    expect(emitToMock).toHaveBeenCalledWith('main', HANDOFF_ACK_EVENT, { label: 'term-1' })
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

    fireAck('term-2')
    await done
  })

  it('ack 的 label 对不上时不算数：不能被别的窗口的 ack 顶掉，继续等到超时并回滚', async () => {
    const done = tearOutTab('tab-b', { x: 0, y: 0 })
    await vi.advanceTimersByTimeAsync(0)
    fireReady('term-1')
    await vi.advanceTimersByTimeAsync(0)

    fireAck('term-999') // 别的窗口回的 ack
    await vi.advanceTimersByTimeAsync(0)
    // 没有被顶掉——标签还在，交接也还没结束。
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])

    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1)
    expect(await done).toBe(false)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-b'])
  })

  it('ack 报的是接管方自己的 label（不是把载荷里的 toLabel 原样回带）', async () => {
    currentWindowMock.mockReturnValue({ label: 'term-5' })
    useTabs.setState({ tabs: [HOME], activeId: 'home' })

    await handleHandoff({
      fromLabel: 'main',
      toLabel: 'term-5',
      activePaneIndex: 0,
      panes: [{ ptyId: 'pty-y', title: 'Y', cwd: null, scrollback: '' }],
    })

    expect(emitToMock).toHaveBeenCalledWith('main', HANDOFF_ACK_EVENT, { label: 'term-5' })
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

  it('主窗口：既不挂接管监听、也不发就绪事件（它自己就是发起方）', async () => {
    currentWindowMock.mockReturnValue({ label: 'main' })
    vi.resetModules()
    const mod = await import('../windowHandoff')
    await mod.windowHandoffReady

    expect(listenMock.mock.calls.map((c) => c[0])).not.toContain(mod.HANDOFF_EVENT)
    expect(emitMock).not.toHaveBeenCalled()
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
