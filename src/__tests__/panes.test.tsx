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
// 不再需要替身 TerminalView：自扁平挂载重构后，TabPanes.tsx 不再渲染 <TerminalView>
// 本身（那部分现在挂在同级的 TerminalLayer.tsx 里，见 TerminalLayer.test.tsx），
// 持有 PTY 的窗格这里只渲染一个几何占位插槽（.pane-body[data-pane-slot]），下面用
// 这个插槽是否存在/数量来断言"是终端窗格还是选择器窗格"。

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
    expect(document.querySelector('[data-pane-slot="p1"]')).toBeTruthy() // 持有 PTY，渲染出终端插槽
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
    // 这里点击的是窗格自己的几何占位插槽（.pane-body[data-pane-slot]）——验证的是
    // PaneItem 挂在 .pane 上的 onPointerDownCapture 本身（标题栏、插槽区域都由它捕获）。
    // 真实点击落在终端渲染像素上的等价路径已经挪到 TerminalLayer.tsx 自己的
    // onPointerDownCapture，见 TerminalLayer.test.tsx 里对应的聚焦测试。
    const tab = {
      id: 'tab-1', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'p1', ptyId: 'pty-1', title: '窗格甲' }, { id: 'p2', ptyId: 'pty-2', title: '窗格乙' }],
      activePaneId: 'p1',
    }
    useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }, tab], activeId: 'tab-1' })
    render(<TabPanes tab={tab} isActiveTab />)

    const secondSlot = document.querySelectorAll('[data-pane-slot]')[1]
    fireEvent.pointerDown(secondSlot)

    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-1')!.activePaneId).toBe('p2')
  })
})

describe('TabPanes — 未选定会话的窗格显示选择器（设计文档 §5-A）', () => {
  it('待选窗格（无 ptyId）渲染选择器而不是终端插槽', () => {
    const tab = {
      id: 'tab-1', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'p1', ptyId: 'pty-1', title: '窗格甲' }, { id: 'p2', title: '新窗格' }],
      activePaneId: 'p2',
    }
    render(<TabPanes tab={tab} isActiveTab />)
    expect(screen.getByText('新终端（zsh）')).toBeTruthy()
    expect(screen.getByText('新对话')).toBeTruthy()
    expect(document.querySelectorAll('[data-pane-slot]')).toHaveLength(1) // 只有窗格甲是真终端，带插槽
  })

  it('选择「新终端（zsh）」后，该窗格获得 ptyId（渲染出终端插槽）', async () => {
    const tab = {
      id: 'tab-1', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'p1', ptyId: 'pty-1', title: '窗格甲' }, { id: 'p2', title: '新窗格' }],
      activePaneId: 'p2',
    }
    useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }, tab], activeId: 'tab-1' })
    render(<TabPanes tab={tab} isActiveTab />)

    fireEvent.click(screen.getByText('新终端（zsh）'))

    // 注：这里的 <TabPanes> 是拿字面量 tab 对象直接渲染的（不是订阅 store 的响应式
    // 树），下面 startPaneTerminal 落地后组件不会自动重渲染——本测试与改动前一样，
    // 只断言 store 状态本身，不断言 DOM（"渲染出终端插槽"这件事在真实 App 里成立，
    // 由 store 变化驱动 TabPanes 用新的 tab.panes 重渲染，见 panes.test.tsx 顶部
    // 其它用 useTabs.setState 换新 tab 对象重渲的用例，以及 App.test.tsx 的端到端路径）。
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
