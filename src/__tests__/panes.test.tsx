import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-picked'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  readConversation: vi.fn(),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
// TerminalView 实例化真实 xterm.js，与本文件要验证的"窗格标题栏/选择器渲染与交互"
// 无关，替身掉——与 App.test.tsx 同一处理。
vi.mock('../components/TerminalView', () => ({ TerminalView: ({ ptyId }: { ptyId: string }) => <div data-testid="terminal-view">{ptyId}</div> }))

import { TabPanes } from '../components/TabPanes'
import { useSessions } from '../store/sessions'
import { useTabs } from '../store/tabs'

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  useSessions.setState({ projects: [] })
  vi.clearAllMocks()
})

describe('TabPanes — 窗格标题栏仅在多窗格时渲染（设计文档 §4）', () => {
  it('单窗格标签：不渲染标题栏', () => {
    const tab = {
      id: 'tab-1', kind: 'term' as const, title: 'A',
      panes: [{ id: 'p1', ptyId: 'pty-1', title: 'A' }],
      activePaneId: 'p1',
    }
    render(<TabPanes tab={tab} isActiveTab />)
    expect(document.querySelector('.pane-titlebar')).toBeNull()
    expect(screen.getByTestId('terminal-view')).toBeTruthy()
  })

  it('多窗格标签：每个窗格都有标题栏，聚焦窗格的标题栏带 focused class', () => {
    const tab = {
      id: 'tab-1', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'p1', ptyId: 'pty-1', title: '窗格甲' }, { id: 'p2', ptyId: 'pty-2', title: '窗格乙' }],
      activePaneId: 'p2',
    }
    render(<TabPanes tab={tab} isActiveTab />)
    const bars = document.querySelectorAll('.pane-titlebar')
    expect(bars).toHaveLength(2)
    expect(screen.getByText('窗格甲')).toBeTruthy()
    expect(screen.getByText('窗格乙')).toBeTruthy()
    expect(bars[0].classList.contains('pane-titlebar-focused')).toBe(false)
    expect(bars[1].classList.contains('pane-titlebar-focused')).toBe(true)
  })

  it('点击 × 触发 closePane：无存活 PTY 时直接从 store 移除该窗格', async () => {
    const tab = {
      id: 'tab-1', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'p1', ptyId: 'pty-1', title: '窗格甲' }, { id: 'p2', ptyId: 'pty-2', title: '窗格乙' }],
      activePaneId: 'p1',
    }
    useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }, tab], activeId: 'tab-1' })
    render(<TabPanes tab={tab} isActiveTab />)

    const closeButtons = document.querySelectorAll('.pane-titlebar-close')
    fireEvent.click(closeButtons[1]) // 关闭"窗格乙"

    await vi.waitFor(() => {
      const t = useTabs.getState().tabs.find((x) => x.id === 'tab-1')!
      expect(t.panes.map((p) => p.id)).toEqual(['p1'])
    })
  })

  it('点击窗格内部会聚焦该窗格（写回 store 的 activePaneId）', () => {
    const tab = {
      id: 'tab-1', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'p1', ptyId: 'pty-1', title: '窗格甲' }, { id: 'p2', ptyId: 'pty-2', title: '窗格乙' }],
      activePaneId: 'p1',
    }
    useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }, tab], activeId: 'tab-1' })
    render(<TabPanes tab={tab} isActiveTab />)

    const secondTerminal = screen.getAllByTestId('terminal-view')[1]
    fireEvent.pointerDown(secondTerminal)

    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-1')!.activePaneId).toBe('p2')
  })
})

describe('TabPanes — 未选定会话的窗格显示选择器（设计文档 §5-A）', () => {
  it('待选窗格（无 ptyId）渲染选择器而不是 TerminalView', () => {
    const tab = {
      id: 'tab-1', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'p1', ptyId: 'pty-1', title: '窗格甲' }, { id: 'p2', title: '新窗格' }],
      activePaneId: 'p2',
    }
    render(<TabPanes tab={tab} isActiveTab />)
    expect(screen.getByText('新终端（zsh）')).toBeTruthy()
    expect(screen.getByText('新对话')).toBeTruthy()
    expect(screen.getAllByTestId('terminal-view')).toHaveLength(1) // 只有窗格甲是真终端
  })

  it('选择「新终端（zsh）」后，该窗格获得 ptyId 并渲染出 TerminalView', async () => {
    const tab = {
      id: 'tab-1', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'p1', ptyId: 'pty-1', title: '窗格甲' }, { id: 'p2', title: '新窗格' }],
      activePaneId: 'p2',
    }
    useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }, tab], activeId: 'tab-1' })
    render(<TabPanes tab={tab} isActiveTab />)

    fireEvent.click(screen.getByText('新终端（zsh）'))

    await vi.waitFor(() => {
      const pane = useTabs.getState().tabs.find((x) => x.id === 'tab-1')!.panes.find((p) => p.id === 'p2')!
      expect(pane.ptyId).toBe('pty-picked')
      expect(pane.title).toBe('zsh')
    })
  })

  it('选择器展示最近会话（复用 useSessions 数据源），点击后带上 threadKey/dirName/rootKey 启动', async () => {
    useSessions.setState({
      projects: [
        {
          dirName: 'proj-a',
          cwd: '/home/proj-a',
          lastActivityMs: 100,
          threads: [{ rootKey: 'root-a', resumeSessionId: 'sid-a', title: '修复登录', cwd: '/home/proj-a', lastActivityMs: 100, fileCount: 1 }],
        },
      ],
    })
    const tab = {
      id: 'tab-1', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'p1', ptyId: 'pty-1', title: '窗格甲' }, { id: 'p2', title: '新窗格' }],
      activePaneId: 'p2',
    }
    useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }, tab], activeId: 'tab-1' })
    render(<TabPanes tab={tab} isActiveTab />)

    expect(screen.getByText('修复登录')).toBeTruthy()
    fireEvent.click(screen.getByText('修复登录'))

    await vi.waitFor(() => {
      const pane = useTabs.getState().tabs.find((x) => x.id === 'tab-1')!.panes.find((p) => p.id === 'p2')!
      expect(pane.ptyId).toBe('pty-picked')
      expect(pane.threadKey).toBe('proj-a:root-a')
      expect(pane.dirName).toBe('proj-a')
      expect(pane.rootKey).toBe('root-a')
    })
  })
})
