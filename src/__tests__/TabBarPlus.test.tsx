import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-1'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  revealInFinder: vi.fn(async () => {}),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))

import * as ipc from '../ipc'
import { TabBar } from '../components/TabBar'
import { useSessions } from '../store/sessions'
import { useTabs } from '../store/tabs'
import { makeThread } from './factories'

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  useSessions.setState({
    projects: [{
      dirName: '-tmp-a', cwd: '/tmp/a', lastActivityMs: 1,
      threads: [makeThread({ rootKey: 'r1', title: '修登录', resumeSessionId: 's1' })],
    }],
    loading: false,
  })
  vi.clearAllMocks()
})

describe('标签栏的 ＋', () => {
  it('点一下弹出选择器，而不是直接开一个空终端', async () => {
    render(<TabBar />)
    fireEvent.click(screen.getByTitle(/新建/))
    // 选择器出现（「新终端（zsh）」是它固定的第一项）
    expect(screen.queryByText('新终端（zsh）')).toBeTruthy()
    // 冲一遍微任务队列再断言：openTerminal（store/tabs.ts）第一行是
    // `await ptyEventsReady`，不 await 推进一次的话，即使点击处理器背地里偷偷多调用
    // 了一次 newTerminal()，ptySpawn 也不可能在这次同步执行栈内被调用到——不冲队列，
    // 下面这条断言对任何实现都恒为真，测不出它本该防住的"浮层弹出的同时后台偷偷建了
    // 个标签"这种回归（本轮评审发现，见 task-5-report.md 的追加记录）。
    await act(async () => { await Promise.resolve() })
    // 关键：这一下不该已经起了 PTY；同时断言可观测结果而非仅仅"没调用某个函数"——
    // 即便换一条不经过 ptySpawn 的"背地里建标签"路径，也应该被这两行拦住。
    expect(ipc.ptySpawn).not.toHaveBeenCalled()
    expect(useTabs.getState().tabs.filter((t) => t.kind === 'term').length).toBe(0)
    expect(useTabs.getState().activeId).toBe('home')
  })

  it('在选择器里选一条会话 → 新建一个标签（而不是填充某个窗格）', async () => {
    render(<TabBar />)
    fireEvent.click(screen.getByTitle(/新建/))
    fireEvent.click(screen.getByText('修登录'))
    await waitFor(() => expect(ipc.ptySpawn).toHaveBeenCalled())
    const tabs = useTabs.getState().tabs
    // 多出了一个 term 标签
    expect(tabs.filter((t) => t.kind === 'term').length).toBe(1)
    expect(ipc.ptySpawn).toHaveBeenCalledWith(expect.objectContaining({ inject: 'claude --resume s1' }))
  })

  it('选「新终端（zsh）」→ 新建一个空终端标签', async () => {
    render(<TabBar />)
    fireEvent.click(screen.getByTitle(/新建/))
    fireEvent.click(screen.getByText('新终端（zsh）'))
    await waitFor(() => expect(ipc.ptySpawn).toHaveBeenCalled())
    expect(useTabs.getState().tabs.filter((t) => t.kind === 'term').length).toBe(1)
  })

  it('选完之后浮层关闭', async () => {
    render(<TabBar />)
    fireEvent.click(screen.getByTitle(/新建/))
    fireEvent.click(screen.getByText('新终端（zsh）'))
    await waitFor(() => expect(screen.queryByText('新终端（zsh）')).toBeNull())
  })
})
