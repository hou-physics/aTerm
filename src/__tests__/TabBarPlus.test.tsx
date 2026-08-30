import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

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
  it('点一下弹出选择器，而不是直接开一个空终端', () => {
    render(<TabBar />)
    fireEvent.click(screen.getByTitle(/新建/))
    // 选择器出现（「新终端（zsh）」是它固定的第一项）
    expect(screen.queryByText('新终端（zsh）')).toBeTruthy()
    // 关键：这一下不该已经起了 PTY
    expect(ipc.ptySpawn).not.toHaveBeenCalled()
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
