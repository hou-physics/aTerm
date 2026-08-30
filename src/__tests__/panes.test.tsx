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
import { makeThread } from './factories'

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

describe('TabPanes — 分隔条拖拽：换算前先扣除容器内边距/分隔条/窗格边框开销', () => {
  it('拖到远超右侧边界时，左侧应被夹到"扣除开销后的可用宽度 - 320px"，而不是原始 clientWidth - 320px', () => {
    // 回归 review 记录的漏洞：修正前 PaneDivider 直接把 rowRef.current.clientWidth
    // （.term-wrap 的原始测量值，含 12px 内边距）喂给 clampDividerDrag，会让换算出的
    // 像素比真实渲染宽出一截。这里把 clientWidth 挂在 HTMLElement.prototype 上（jsdom
    // 不跑真实布局，与 App.test.tsx 的 ⌘D 边界用例同一手法），断言 store 里落盘的
    // paneWidths 换算自"扣除开销后"的可用宽度，不是原始 800px。
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 })
    try {
      const tab = {
        id: 'tab-1', kind: 'term' as const, title: '2 个对话',
        panes: [{ id: 'p1', ptyId: 'pty-1', title: '窗格甲' }, { id: 'p2', ptyId: 'pty-2', title: '窗格乙' }],
        activePaneId: 'p1',
        paneWidths: [0.5, 0.5],
      }
      useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }, tab], activeId: 'tab-1' })
      render(<TabPanes tab={tab} isActiveTab />)

      const divider = document.querySelector('.pane-divider')!
      fireEvent.pointerDown(divider, { clientX: 0, pointerId: 1 })
      fireEvent.pointerMove(divider, { clientX: 1000, pointerId: 1 }) // 远超右侧边界，触发夹紧

      const usable = 800 - 12 - 9 - 4 // term-wrap 内边距 12px + 1 条分隔条 9px + 2 个窗格边框各 2px
      const t = useTabs.getState().tabs.find((x) => x.id === 'tab-1')!
      expect(t.paneWidths![0] * usable).toBeCloseTo(usable - 320)
      expect(t.paneWidths![1] * usable).toBeCloseTo(320)
      // 修正前的错误换算会是相对 800（原始 clientWidth）算出的占比——用它反推得到的
      // 像素宽度不会恰好等于 usable - 320，用这条反例确认这条用例真的在验证"用哪个
      // 宽度换算"，不是恰好凑出同一个数字。
      expect(t.paneWidths![0] * 800).not.toBeCloseTo(800 - 320)
    } finally {
      if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    }
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
          threads: [makeThread({ rootKey: 'root-a', title: '修复登录' })],
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
