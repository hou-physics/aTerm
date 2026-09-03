// 关闭一个拖出来的终端窗口（V3.3 设计文档 §5.3 / Task 5）。
//
// 这个文件要守住的两条不变式，正反两面都得断言（只断"某个 mock 没被调用"在异步 + 多
// 路径的场景里几乎总是恒真，本仓库出过事故，见 CLAUDE.md「测试纪律」）：
//   1. 关掉一个窗口**只**终止它自己持有的 PTY —— 断言"该杀的确实被杀了"**且**
//      "不该杀的确实一个都没被 kill"；
//   2. 交接中的标签的 PTY 不算"自己持有"—— 它此刻可能已经属于新窗口。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { listenTargets, listenHandlers, listenMock } = vi.hoisted(() => {
  const listenTargets: Record<string, unknown> = {}
  // 注册时挂上去的那个回调本身。要它是为了验"载荷有没有真的被转交给
  // handleWindowCloseRequested"——注册成 `listen(EV, handleWindowCloseRequested)`
  // （把 handler 直接当回调）在类型上也说得通，但那样 toLabel 收到的是整个事件对象、
  // 与本窗口 label 永远对不上，窗口从此**再也关不掉**。
  const listenHandlers: Record<string, (e: { payload: unknown }) => void> = {}
  const listenMock = vi.fn(async (event: string, handler: (e: { payload: unknown }) => void, options?: unknown) => {
    listenTargets[event] = options
    listenHandlers[event] = handler
    return () => {}
  })
  return { listenTargets, listenHandlers, listenMock }
})
const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }))
// 本窗口 label。默认是一个被拖出来的终端窗口——这个模块的全部行为都只对这种窗口生效。
const { labelMock } = vi.hoisted(() => ({ labelMock: vi.fn(async () => 'term-1') }))

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: confirmMock }))
vi.mock('../ipc', () => ({
  ptyIsAlive: vi.fn(async () => true),
  ptyKill: vi.fn(async () => {}),
  destroyTermWindow: vi.fn(async () => {}),
}))
vi.mock('../windowLabel', async () => {
  // isTornOutWindow 用真实实现（它就是那条 `term-` 前缀规则本身），只替换 label 来源。
  const actual = await vi.importActual<typeof import('../windowLabel')>('../windowLabel')
  return { ...actual, currentWindowLabel: labelMock }
})

import { beginHandoff, endHandoff } from '../handoffLock'
import * as ipc from '../ipc'
import { useTabs } from '../store/tabs'
import {
  WINDOW_CLOSE_EVENT,
  buildWindowCloseConfirmMessage,
  handleWindowCloseRequested,
  ownedPtyIds,
  windowCloseReady,
} from '../windowClose'

// 一份"真的还活着的 PTY"清单：ptyKill 从里面删，ptyIsAlive 读它。有了它，"不该被杀的
// 确实还活着"就是对**真实状态**的断言，而不是"kill 这个 mock 没被调用过"——后者在异步 +
// 多路径的场景里几乎总是成立（CLAUDE.md 点名的那类恒真）。
const livePtys = new Set<string>()
const seedLive = (...ids: string[]) => { for (const id of ids) livePtys.add(id) }

const HOME = { id: 'home', kind: 'home' as const, title: '主页', panes: [] }
const tab = (id: string, ptyIds: (string | undefined)[]) => ({
  id,
  kind: 'term' as const,
  title: id,
  panes: ptyIds.map((ptyId, i) => ({ id: `${id}-pane-${i}`, ptyId, title: id })),
  activePaneId: `${id}-pane-0`,
})

let errorSpy: ReturnType<typeof vi.spyOn> | undefined

beforeEach(() => {
  vi.clearAllMocks()
  labelMock.mockResolvedValue('term-1')
  livePtys.clear()
  vi.mocked(ipc.ptyIsAlive).mockImplementation(async (id: string) => livePtys.has(id))
  vi.mocked(ipc.ptyKill).mockImplementation(async (id: string) => { livePtys.delete(id) })
  vi.mocked(ipc.destroyTermWindow).mockResolvedValue(undefined)
  confirmMock.mockResolvedValue(true)
  useTabs.setState({ tabs: [HOME], activeId: 'home' })
  endHandoff('tab-x')
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy?.mockRestore()
})

describe('buildWindowCloseConfirmMessage（纯函数）', () => {
  it('文案说的是"关闭这个窗口"，不是"关闭 aTerm"——两件事的后果差着一整个应用', () => {
    expect(buildWindowCloseConfirmMessage(2)).toBe('还有 2 个会话在运行，关闭这个窗口会终止它们。确定关闭？')
  })

  // R1/M5：与 store/tabs.ts 的 buildTabCloseConfirmMessage 一样按数量分档。
  it('只剩一个会话时用单数措辞', () => {
    expect(buildWindowCloseConfirmMessage(1)).toBe('进程仍在运行，关闭这个窗口会终止它。确定关闭？')
  })
})

describe('ownedPtyIds — 本窗口持有哪些 PTY', () => {
  it('收集本窗口全部终端标签的 ptyId，跳过还没选定会话的空槽窗格', () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a']), tab('tab-b', ['pty-b1', undefined, 'pty-b2'])], activeId: 'tab-a' })
    expect(ownedPtyIds()).toEqual(['pty-a', 'pty-b1', 'pty-b2'])
  })

  it('交接中的标签不算本窗口持有——那些 PTY 此刻可能已经属于新窗口', () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a']), tab('tab-x', ['pty-x'])], activeId: 'tab-a' })
    // 前置：不上锁时它是算进来的（不然下面那条断言就是恒真的）。
    expect(ownedPtyIds()).toEqual(['pty-a', 'pty-x'])

    expect(beginHandoff('tab-x')).toBe(true)
    expect(ownedPtyIds()).toEqual(['pty-a'])
    endHandoff('tab-x')
  })
})

describe('handleWindowCloseRequested — 关窗只杀自己持有的 PTY', () => {
  it('终止本窗口全部存活会话后才销毁窗口（先 kill 再 destroy，反过来会留下后台孤儿）', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a']), tab('tab-b', ['pty-b'])], activeId: 'tab-a' })
    seedLive('pty-a', 'pty-b')

    await handleWindowCloseRequested('term-1')

    // 真实状态：这两个会话确实不再活着了。
    expect([...livePtys]).toEqual([])
    expect(ipc.ptyKill).toHaveBeenCalledWith('pty-a')
    expect(ipc.ptyKill).toHaveBeenCalledWith('pty-b')
    expect(ipc.destroyTermWindow).toHaveBeenCalledWith('term-1')
    // 顺序：两次 kill 的调用序号都必须早于 destroy。
    const killOrders = vi.mocked(ipc.ptyKill).mock.invocationCallOrder
    const destroyOrder = vi.mocked(ipc.destroyTermWindow).mock.invocationCallOrder[0]
    expect(Math.max(...killOrders)).toBeLessThan(destroyOrder)
  })

  it('只杀本窗口 store 里的那些：别的窗口的 PTY 不在本窗口 store 里，因此一次都不会被 kill', async () => {
    // 「别的窗口持有的会话」在本窗口的 JS 上下文里就是"不在 useTabs 里的 ptyId"——各
    // 窗口是独立的 JS 上下文、各有一份 store，这正是所有权模型的落点。
    useTabs.setState({ tabs: [HOME, tab('tab-mine', ['pty-mine'])], activeId: 'tab-mine' })
    // 'pty-others' 代表别的窗口持有的会话：它不在本窗口的 useTabs 里，但确实活着。
    seedLive('pty-mine', 'pty-others')

    await handleWindowCloseRequested('term-1')

    // 正面：自己的确实被杀了（没有这一条，下面两条就是恒真的）。
    expect(ipc.ptyKill).toHaveBeenCalledWith('pty-mine')
    // 反面之一（真实状态）：别的窗口那个会话**确实还活着**。
    expect([...livePtys]).toEqual(['pty-others'])
    // 反面：别人的一个都没碰——逐个点名，而不是只看总次数。
    expect(vi.mocked(ipc.ptyKill).mock.calls.map((c) => c[0])).toEqual(['pty-mine'])
  })

  it('交接中的标签：它的 PTY 不被 kill，而同一窗口里其它标签的照杀不误', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a']), tab('tab-x', ['pty-x'])], activeId: 'tab-a' })
    seedLive('pty-a', 'pty-x')
    beginHandoff('tab-x')

    await handleWindowCloseRequested('term-1')

    expect(vi.mocked(ipc.ptyKill).mock.calls.map((c) => c[0])).toEqual(['pty-a'])
    // 真实状态：交接中那个会话**确实还活着**（新窗口可能已经在用它）。
    expect([...livePtys]).toEqual(['pty-x'])
    endHandoff('tab-x')
  })

  it('本窗口没有任何存活会话时不弹确认，直接关窗', async () => {
    // 不往存活清单里播种：这个 PTY 早就死了（用户在终端里敲过 exit）。
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a'])], activeId: 'tab-a' })

    await handleWindowCloseRequested('term-1')

    expect(confirmMock).not.toHaveBeenCalled()
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    expect(ipc.destroyTermWindow).toHaveBeenCalledWith('term-1')
  })

  it('确认框里点"取消"：窗口不关、会话不动', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a'])], activeId: 'tab-a' })
    seedLive('pty-a')
    confirmMock.mockResolvedValue(false)

    await handleWindowCloseRequested('term-1')

    expect(ipc.ptyKill).not.toHaveBeenCalled()
    expect([...livePtys]).toEqual(['pty-a']) // 真实状态：会话还活着
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
  })

  it('确认文案报出的是本窗口的存活会话数（死掉的那个不算）', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a', 'pty-dead', 'pty-c'])], activeId: 'tab-a' })
    seedLive('pty-a', 'pty-c') // pty-dead 不播种

    await handleWindowCloseRequested('term-1')

    expect(confirmMock).toHaveBeenCalledWith('还有 2 个会话在运行，关闭这个窗口会终止它们。确定关闭？', { title: 'aTerm' })
    expect(vi.mocked(ipc.ptyKill).mock.calls.map((c) => c[0])).toEqual(['pty-a', 'pty-c'])
  })

  it('单个 ptyIsAlive 查询失败时保守按"不存活"处理，不影响其余会话的终止', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-boom', 'pty-ok'])], activeId: 'tab-a' })
    seedLive('pty-boom', 'pty-ok')
    vi.mocked(ipc.ptyIsAlive).mockImplementation(async (id: string) => {
      if (id === 'pty-boom') throw new Error('记录已被并发清理')
      return livePtys.has(id)
    })

    await handleWindowCloseRequested('term-1')

    expect(vi.mocked(ipc.ptyKill).mock.calls.map((c) => c[0])).toEqual(['pty-ok'])
    expect(ipc.destroyTermWindow).toHaveBeenCalledWith('term-1')
  })

  it('单个 ptyKill 失败不该让窗口关不掉（已经死掉的 PTY 会让 pty_kill 返回 Err）', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-boom', 'pty-ok'])], activeId: 'tab-a' })
    seedLive('pty-boom', 'pty-ok')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(ipc.ptyKill).mockImplementation(async (id: string) => {
      if (id === 'pty-boom') throw new Error('pty 不存在')
      livePtys.delete(id)
    })

    await handleWindowCloseRequested('term-1')

    expect(vi.mocked(ipc.ptyKill).mock.calls.map((c) => c[0])).toEqual(['pty-boom', 'pty-ok'])
    expect(ipc.destroyTermWindow).toHaveBeenCalledWith('term-1')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  // ── R1/I2：定向投递不是私有信道，必须显式校验 + 显式 target ─────────────────
  //
  // 注册侧的 `{ target: label }` 是第一层；它一旦失效（不传 options 的 listen 落成
  // `{ kind: 'Any' }`，对 emit_to 的 label 过滤**无条件命中**），兄弟 term 窗口就会收到
  // 发给别人的关闭事件——而 isTornOutWindow 对它同样为真，它会把**自己**的全部会话杀光
  // 再自毁。载荷里的 toLabel 比对是第二层。
  it('兄弟 term 窗口收到不属于自己的关闭事件：毫无动作，它自己的会话确实还活着', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a'])], activeId: 'tab-a' })
    seedLive('pty-a')

    // 本窗口是 term-1，这条事件是发给 term-2 的。
    await handleWindowCloseRequested('term-2')

    // 真实状态断言：会话**确实还在跑**（不是"kill 这个 mock 没被调用"）。
    expect([...livePtys]).toEqual(['pty-a'])
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    expect(confirmMock).not.toHaveBeenCalled()
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()

    // 正面对照：同一个窗口、同一份状态，事件真的发给它时该做的事一件不少——没有这一半，
    // 上面那组断言就可能只是"这个函数什么都不做"。
    await handleWindowCloseRequested('term-1')
    expect([...livePtys]).toEqual([])
    expect(ipc.destroyTermWindow).toHaveBeenCalledWith('term-1')
  })

  // ── R1/M1：确认框可能开很久，破坏性操作不许拿确认之前的快照 ────────────────
  //
  // 与 Ruling 9 同一条规矩。两个方向各一条，因为它们错的方式相反。

  it('确认期间新开了一个标签：它的会话也会被终止（否则窗口销毁后它成了后台孤儿）', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a'])], activeId: 'tab-a' })
    seedLive('pty-a')
    let resolveConfirm!: (v: boolean) => void
    confirmMock.mockImplementation(() => new Promise<boolean>((res) => { resolveConfirm = res }))

    const done = handleWindowCloseRequested('term-1')
    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalled())

    // 用户在确认框还开着的时候，在这个窗口里开了个新终端。
    useTabs.setState((st) => ({ tabs: [...st.tabs, tab('tab-late', ['pty-late'])] }))
    seedLive('pty-late')

    resolveConfirm(true)
    await done

    // 真实状态：两个都不再活着——按确认之前那份快照杀的话，pty-late 会被漏掉。
    expect([...livePtys]).toEqual([])
    expect(vi.mocked(ipc.ptyKill).mock.calls.map((c) => c[0]).sort()).toEqual(['pty-a', 'pty-late'])
  })

  it('确认期间某个标签进入交接：它的会话不被终止，且确实还活着', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a']), tab('tab-x', ['pty-x'])], activeId: 'tab-a' })
    seedLive('pty-a', 'pty-x')
    let resolveConfirm!: (v: boolean) => void
    confirmMock.mockImplementation(() => new Promise<boolean>((res) => { resolveConfirm = res }))

    const done = handleWindowCloseRequested('term-1')
    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalled())
    // 确认框还开着时，用户把 tab-x 拖了出去——它的 PTY 此刻可能已经归新窗口了。
    beginHandoff('tab-x')

    resolveConfirm(true)
    await done

    expect(vi.mocked(ipc.ptyKill).mock.calls.map((c) => c[0])).toEqual(['pty-a'])
    expect([...livePtys]).toEqual(['pty-x']) // 真实状态：交接中那个确实还活着
    endHandoff('tab-x')
  })

  // 定向投递不是私有信道（同 windowHandoff.ts 顶部那段考据）：不传 target 的 listen 是
  // `{ kind: 'Any' }`，对任何 emit_to 无条件命中。主窗口若也处理这个事件，别的窗口关闭
  // 时它会把**自己**的会话全 kill 掉再去销毁自己——而主窗口的关闭本该等于退出应用、
  // 走 ⌘Q 确认框。
  it('主窗口收到这个事件也什么都不做（不杀任何 PTY、不销毁窗口）', async () => {
    labelMock.mockResolvedValue('main')
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a'])], activeId: 'tab-a' })
    seedLive('pty-a')

    // 载荷 label 与本窗口一致（'main'）——这里单独考的是"主窗口不参与"这一层，不是
    // 下面那条 toLabel 比对。
    await handleWindowCloseRequested('main')

    expect(ipc.ptyIsAlive).not.toHaveBeenCalled()
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    expect([...livePtys]).toEqual(['pty-a']) // 真实状态：主窗口的会话一个没少
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
  })

  // 断言的是"第二次请求连**活都没干**"（ptyIsAlive 一次都没多调），不是"confirm 只被
  // 调了一次"。后者看起来更直白，但实测**不具区分力**：把重入闸门删掉之后它照样绿——
  // 第二轮会各自 `await import('@tauri-apps/plugin-dialog')`，两次并发的动态 import 在
  // vitest 里有一次拿到的是**真实**模块而不是替身，真实 confirm 在 jsdom 里读
  // window.__TAURI_INTERNALS__ 抛 TypeError，被 handleWindowCloseRequested 的 catch 吞掉，
  // 于是 confirmMock 的计数仍然是 1。改成断言闸门之前就发生的那次真实动作（清点自己
  // 持有的会话）之后，删掉闸门立刻转红。
  it('第一轮还在处理时，重复的关闭请求被丢弃（不重复清点、不堆第二个对话框），且这一轮结束后能再次发起', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a'])], activeId: 'tab-a' })
    seedLive('pty-a')
    let releaseAlive!: () => void
    let aliveCalls = 0
    vi.mocked(ipc.ptyIsAlive).mockImplementation((id: string) => {
      aliveCalls += 1
      // 第一轮卡在"查这个 PTY 还活着吗"这一步上，模拟"上一次关闭请求还没处理完"；
      // 第二轮若真的跑起来则不卡住——否则缺闸门时用例会挂到超时，而不是干净地转红。
      return aliveCalls === 1
        ? new Promise<boolean>((res) => { releaseAlive = () => res(livePtys.has(id)) })
        : Promise.resolve(livePtys.has(id))
    })

    const first = handleWindowCloseRequested('term-1')
    await vi.waitFor(() => expect(ipc.ptyIsAlive).toHaveBeenCalled())

    await handleWindowCloseRequested('term-1') // 第二次请求：应当被整个丢弃
    expect(aliveCalls).toBe(1)
    expect(confirmMock).not.toHaveBeenCalled()

    releaseAlive()
    await first
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(ipc.destroyTermWindow).toHaveBeenCalledTimes(1)

    // 重入标志位必须复位，否则这个窗口从此再也关不掉。
    await handleWindowCloseRequested('term-1')
    expect(ipc.destroyTermWindow).toHaveBeenCalledTimes(2)
  })
})

describe('windowCloseReady — 监听注册', () => {
  it('拖出来的终端窗口注册了 window-close-requested，且 target 限定为本窗口', async () => {
    await windowCloseReady
    expect(listenTargets[WINDOW_CLOSE_EVENT]).toEqual({ target: 'term-1' })
  })

  // 载荷必须被转交下去（R1/I2 的接线那一半）。少了这一条，把回调写成
  // `listen(EV, handleWindowCloseRequested)` 也照样"注册成功"——而那样 toLabel 拿到的是
  // 整个事件对象，与本窗口 label 永远不等，这个窗口从此再也关不掉。
  it('注册的回调把事件载荷（目标窗口 label）转交给处理函数，而不是丢掉', async () => {
    await windowCloseReady
    const handler = listenHandlers[WINDOW_CLOSE_EVENT]
    expect(typeof handler).toBe('function')

    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a'])], activeId: 'tab-a' })
    seedLive('pty-a')

    // 发给别人的：本窗口毫无动作，会话还活着。
    handler({ payload: 'term-2' })
    await vi.waitFor(() => expect(labelMock).toHaveBeenCalled())
    expect([...livePtys]).toEqual(['pty-a'])
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()

    // 发给自己的：走完整流程。
    handler({ payload: 'term-1' })
    await vi.waitFor(() => expect(ipc.destroyTermWindow).toHaveBeenCalledWith('term-1'))
    expect([...livePtys]).toEqual([])
  })
})
