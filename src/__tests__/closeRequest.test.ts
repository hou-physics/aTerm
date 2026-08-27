import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, listenMock } = vi.hoisted(() => {
  const handlers: Record<string, () => void> = {}
  const listenMock = vi.fn(async (event: string, handler: () => void) => {
    handlers[event] = handler
    return () => {}
  })
  return { handlers, listenMock }
})

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }))

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: confirmMock }))
vi.mock('../ipc', () => ({
  ptyIsAlive: vi.fn(async () => false),
  confirmExit: vi.fn(async () => {}),
}))

import * as ipc from '../ipc'
import { buildExitConfirmMessage, closeRequestReady, handleCloseRequested } from '../closeRequest'
import { useTabs } from '../store/tabs'

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  vi.clearAllMocks()
})

describe('buildExitConfirmMessage（纯函数，不依赖 Tauri）', () => {
  it('没有存活会话时给出简单文案', () => {
    expect(buildExitConfirmMessage(0)).toBe('确定关闭 aTerm？')
  })

  it('有存活会话时文案里报出具体数量', () => {
    expect(buildExitConfirmMessage(3)).toBe('还有 3 个会话在运行，关闭 aTerm 会终止它们。确定关闭？')
    expect(buildExitConfirmMessage(1)).toBe('还有 1 个会话在运行，关闭 aTerm 会终止它们。确定关闭？')
  })
})

describe('closeRequest：收到 app-close-requested 后统计存活会话并弹确认', () => {
  it('模块加载时已向 app-close-requested 注册监听（在任何用户交互之前）', async () => {
    // listenMock 的调用记录会被上面 beforeEach 里的 vi.clearAllMocks() 清空，但注册这件事
    // 本身发生在模块顶层导入时（早于任何一个 beforeEach）——这里改为直接断言 handlers 里
    // 挂的正是 handleCloseRequested 本身，而不是断言 listenMock 的调用历史（后者在模块
    // 只导入一次、多个用例共享同一次注册的前提下并不可靠）。
    await closeRequestReady
    expect(handlers['app-close-requested']).toBe(handleCloseRequested)
  })

  it('统计当前标签里存活的终端 PTY 数量，用它拼出确认文案；确认后调用 confirm_exit', async () => {
    await closeRequestReady
    useTabs.setState({
      tabs: [
        { id: 'home', kind: 'home', title: '主页', panes: [] },
        { id: 'tab-a', kind: 'term', title: 'A', panes: [{ id: 'pane-tab-a', ptyId: 'pty-a', title: 'A' }], activePaneId: 'pane-tab-a' },
        { id: 'tab-b', kind: 'term', title: 'B', panes: [{ id: 'pane-tab-b', ptyId: 'pty-b', title: 'B' }], activePaneId: 'pane-tab-b' },
        { id: 'tab-c', kind: 'term', title: 'C', panes: [{ id: 'pane-tab-c', ptyId: 'pty-c', title: 'C' }], activePaneId: 'pane-tab-c' },
      ],
      activeId: 'tab-a',
    })
    vi.mocked(ipc.ptyIsAlive).mockImplementation(async (id: string) => id !== 'pty-c')
    confirmMock.mockResolvedValue(true)

    await handleCloseRequested()

    expect(confirmMock).toHaveBeenCalledWith(
      '还有 2 个会话在运行，关闭 aTerm 会终止它们。确定关闭？',
      { title: 'aTerm' },
    )
    expect(ipc.confirmExit).toHaveBeenCalled()
  })

  it('没有任何存活会话时使用简单文案', async () => {
    await closeRequestReady
    useTabs.setState({
      tabs: [{ id: 'tab-a', kind: 'term', title: 'A', panes: [{ id: 'pane-tab-a', ptyId: 'pty-a', title: 'A' }], activePaneId: 'pane-tab-a' }],
      activeId: 'tab-a',
    })
    vi.mocked(ipc.ptyIsAlive).mockResolvedValue(false)
    confirmMock.mockResolvedValue(true)

    await handleCloseRequested()

    expect(confirmMock).toHaveBeenCalledWith('确定关闭 aTerm？', { title: 'aTerm' })
  })

  it('用户取消确认时不调用 confirm_exit', async () => {
    await closeRequestReady
    useTabs.setState({
      tabs: [{ id: 'tab-a', kind: 'term', title: 'A', panes: [{ id: 'pane-tab-a', ptyId: 'pty-a', title: 'A' }], activePaneId: 'pane-tab-a' }],
      activeId: 'tab-a',
    })
    vi.mocked(ipc.ptyIsAlive).mockResolvedValue(true)
    confirmMock.mockResolvedValue(false)

    await handleCloseRequested()

    expect(confirmMock).toHaveBeenCalled()
    expect(ipc.confirmExit).not.toHaveBeenCalled()
  })

  it('确认对话框仍在等待用户操作时，重复的关闭请求被丢弃（不堆叠出第二个对话框）', async () => {
    await closeRequestReady
    useTabs.setState({
      tabs: [{ id: 'tab-a', kind: 'term', title: 'A', panes: [{ id: 'pane-tab-a', ptyId: 'pty-a', title: 'A' }], activePaneId: 'pane-tab-a' }],
      activeId: 'tab-a',
    })
    vi.mocked(ipc.ptyIsAlive).mockResolvedValue(true)
    let resolveConfirm!: (v: boolean) => void
    confirmMock.mockImplementation(() => new Promise<boolean>((res) => { resolveConfirm = res }))

    // Rust 侧在 prevent_close/prevent_exit 之后每次都会重新 emit 同一个事件，所以
    // "确认框还开着的时候用户又按了一次 ⌘Q / 又点了一次标题栏关闭按钮"完全可能发生：
    // 这里同一时刻发起两次关闭请求，模拟这种重入。
    const first = handleCloseRequested()
    const second = handleCloseRequested()

    // handleCloseRequested 在真正调用 confirm() 之前还要先 await countLiveTerminalTabs()
    // 和一次动态 import，都要等真正跑到 confirm() 被调用（resolveConfirm 才会被赋值）
    // 才能去 resolve 它，否则会在 resolveConfirm 还是 undefined 时就调用它。
    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalled())
    resolveConfirm(true)
    await Promise.all([first, second])

    expect(confirmMock).toHaveBeenCalledTimes(1) // 没有堆出第二个对话框
    expect(ipc.confirmExit).toHaveBeenCalledTimes(1)

    // 这一轮确认已经跑完，guard 必须复位——下一次关闭请求要能重新触发一轮全新确认，
    // 而不是被永久锁死。
    confirmMock.mockResolvedValue(true)
    await handleCloseRequested()
    expect(confirmMock).toHaveBeenCalledTimes(2)
  })

  it('单次 ptyIsAlive 查询失败时保守按"不存活"计数，不影响其余会话的统计', async () => {
    await closeRequestReady
    useTabs.setState({
      tabs: [
        { id: 'tab-a', kind: 'term', title: 'A', panes: [{ id: 'pane-tab-a', ptyId: 'pty-a', title: 'A' }], activePaneId: 'pane-tab-a' },
        { id: 'tab-b', kind: 'term', title: 'B', panes: [{ id: 'pane-tab-b', ptyId: 'pty-b', title: 'B' }], activePaneId: 'pane-tab-b' },
      ],
      activeId: 'tab-a',
    })
    vi.mocked(ipc.ptyIsAlive).mockImplementation(async (id: string) => {
      if (id === 'pty-a') throw new Error('会话已被清理')
      return true
    })
    confirmMock.mockResolvedValue(true)

    await handleCloseRequested()

    expect(confirmMock).toHaveBeenCalledWith(
      '还有 1 个会话在运行，关闭 aTerm 会终止它们。确定关闭？',
      { title: 'aTerm' },
    )
  })
})
