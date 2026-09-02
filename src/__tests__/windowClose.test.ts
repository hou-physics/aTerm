// 关闭一个拖出来的终端窗口（V3.3 设计文档 §5.3 / Task 5）。
//
// 这个文件要守住的两条不变式，正反两面都得断言（只断"某个 mock 没被调用"在异步 + 多
// 路径的场景里几乎总是恒真，本仓库出过事故，见 CLAUDE.md「测试纪律」）：
//   1. 关掉一个窗口**只**终止它自己持有的 PTY —— 断言"该杀的确实被杀了"**且**
//      "不该杀的确实一个都没被 kill"；
//   2. 交接中的标签的 PTY 不算"自己持有"—— 它此刻可能已经属于新窗口。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { listenTargets, listenMock } = vi.hoisted(() => {
  const listenTargets: Record<string, unknown> = {}
  const listenMock = vi.fn(async (event: string, _handler: unknown, options?: unknown) => {
    listenTargets[event] = options
    return () => {}
  })
  return { listenTargets, listenMock }
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
  vi.mocked(ipc.ptyIsAlive).mockResolvedValue(true)
  vi.mocked(ipc.ptyKill).mockResolvedValue(undefined)
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

    await handleWindowCloseRequested()

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

    await handleWindowCloseRequested()

    // 正面：自己的确实被杀了（没有这一条，下面那条就是恒真的）。
    expect(ipc.ptyKill).toHaveBeenCalledWith('pty-mine')
    // 反面：别人的一个都没碰——逐个点名，而不是只看总次数。
    expect(vi.mocked(ipc.ptyKill).mock.calls.map((c) => c[0])).toEqual(['pty-mine'])
  })

  it('交接中的标签：它的 PTY 不被 kill，而同一窗口里其它标签的照杀不误', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a']), tab('tab-x', ['pty-x'])], activeId: 'tab-a' })
    beginHandoff('tab-x')

    await handleWindowCloseRequested()

    expect(vi.mocked(ipc.ptyKill).mock.calls.map((c) => c[0])).toEqual(['pty-a'])
    endHandoff('tab-x')
  })

  it('本窗口没有任何存活会话时不弹确认，直接关窗', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a'])], activeId: 'tab-a' })
    vi.mocked(ipc.ptyIsAlive).mockResolvedValue(false)

    await handleWindowCloseRequested()

    expect(confirmMock).not.toHaveBeenCalled()
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    expect(ipc.destroyTermWindow).toHaveBeenCalledWith('term-1')
  })

  it('确认框里点"取消"：窗口不关、会话不动', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a'])], activeId: 'tab-a' })
    confirmMock.mockResolvedValue(false)

    await handleWindowCloseRequested()

    expect(ipc.ptyKill).not.toHaveBeenCalled()
    expect(ipc.destroyTermWindow).not.toHaveBeenCalled()
  })

  it('确认文案报出的是本窗口的存活会话数（死掉的那个不算）', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a', 'pty-dead', 'pty-c'])], activeId: 'tab-a' })
    vi.mocked(ipc.ptyIsAlive).mockImplementation(async (id: string) => id !== 'pty-dead')

    await handleWindowCloseRequested()

    expect(confirmMock).toHaveBeenCalledWith('还有 2 个会话在运行，关闭这个窗口会终止它们。确定关闭？', { title: 'aTerm' })
    expect(vi.mocked(ipc.ptyKill).mock.calls.map((c) => c[0])).toEqual(['pty-a', 'pty-c'])
  })

  it('单个 ptyIsAlive 查询失败时保守按"不存活"处理，不影响其余会话的终止', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-boom', 'pty-ok'])], activeId: 'tab-a' })
    vi.mocked(ipc.ptyIsAlive).mockImplementation(async (id: string) => {
      if (id === 'pty-boom') throw new Error('记录已被并发清理')
      return true
    })

    await handleWindowCloseRequested()

    expect(vi.mocked(ipc.ptyKill).mock.calls.map((c) => c[0])).toEqual(['pty-ok'])
    expect(ipc.destroyTermWindow).toHaveBeenCalledWith('term-1')
  })

  it('单个 ptyKill 失败不该让窗口关不掉（已经死掉的 PTY 会让 pty_kill 返回 Err）', async () => {
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-boom', 'pty-ok'])], activeId: 'tab-a' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(ipc.ptyKill).mockImplementation(async (id: string) => {
      if (id === 'pty-boom') throw new Error('pty 不存在')
    })

    await handleWindowCloseRequested()

    expect(vi.mocked(ipc.ptyKill).mock.calls.map((c) => c[0])).toEqual(['pty-boom', 'pty-ok'])
    expect(ipc.destroyTermWindow).toHaveBeenCalledWith('term-1')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  // 定向投递不是私有信道（同 windowHandoff.ts 顶部那段考据）：不传 target 的 listen 是
  // `{ kind: 'Any' }`，对任何 emit_to 无条件命中。主窗口若也处理这个事件，别的窗口关闭
  // 时它会把**自己**的会话全 kill 掉再去销毁自己——而主窗口的关闭本该等于退出应用、
  // 走 ⌘Q 确认框。
  it('主窗口收到这个事件也什么都不做（不杀任何 PTY、不销毁窗口）', async () => {
    labelMock.mockResolvedValue('main')
    useTabs.setState({ tabs: [HOME, tab('tab-a', ['pty-a'])], activeId: 'tab-a' })

    await handleWindowCloseRequested()

    expect(ipc.ptyIsAlive).not.toHaveBeenCalled()
    expect(ipc.ptyKill).not.toHaveBeenCalled()
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
    let releaseAlive!: () => void
    let aliveCalls = 0
    vi.mocked(ipc.ptyIsAlive).mockImplementation(() => {
      aliveCalls += 1
      // 第一轮卡在"查这个 PTY 还活着吗"这一步上，模拟"上一次关闭请求还没处理完"；
      // 第二轮若真的跑起来则不卡住——否则缺闸门时用例会挂到超时，而不是干净地转红。
      return aliveCalls === 1
        ? new Promise<boolean>((res) => { releaseAlive = () => res(true) })
        : Promise.resolve(true)
    })

    const first = handleWindowCloseRequested()
    await vi.waitFor(() => expect(ipc.ptyIsAlive).toHaveBeenCalled())

    await handleWindowCloseRequested() // 第二次请求：应当被整个丢弃
    expect(aliveCalls).toBe(1)
    expect(confirmMock).not.toHaveBeenCalled()

    releaseAlive()
    await first
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(ipc.destroyTermWindow).toHaveBeenCalledTimes(1)

    // 重入标志位必须复位，否则这个窗口从此再也关不掉。
    await handleWindowCloseRequested()
    expect(ipc.destroyTermWindow).toHaveBeenCalledTimes(2)
  })
})

describe('windowCloseReady — 监听注册', () => {
  it('拖出来的终端窗口注册了 window-close-requested，且 target 限定为本窗口', async () => {
    await windowCloseReady
    expect(listenTargets[WINDOW_CLOSE_EVENT]).toEqual({ target: 'term-1' })
  })
})
