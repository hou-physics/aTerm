import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-1'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  readConversation: vi.fn(),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
import * as ipc from '../ipc'
import { useLayout } from '../store/layout'
import { useTabs } from '../store/tabs'
import { ConversationPanel } from '../components/ConversationPanel'
import { TabBar } from '../components/TabBar'

const CONV = {
  turns: [
    { role: 'user', text: '第一句话\n第二行', tsMs: new Date(2026, 7, 27, 12, 19).getTime(), uuid: 'u1' },
    { role: 'assistant', text: '好的，我来处理', tsMs: new Date(2026, 7, 27, 12, 20).getTime(), uuid: 'a1' },
  ],
  files: ['/x.jsonl'],
  totalBytes: 100,
}

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  // store/layout.ts 的 panelCollapsed 默认值现在是 true（首次启动默认收起，见该文件的
  // PANEL_COLLAPSED_DEFAULT）；本文件绝大多数用例都假定面板处于展开态才有意义，这里统一
  // 兜底展开，需要验证折叠行为的用例（如下方"折叠时不加载"一组）会自行覆盖这个状态。
  useLayout.setState({ panelCollapsed: false })
  vi.clearAllMocks()
})

describe('ConversationPanel', () => {
  it('当前标签无 rootKey（如主页）时显示空状态，不请求会话正文', () => {
    render(<ConversationPanel />)
    expect(screen.getByText(/没有关联的对话/)).toBeTruthy()
    expect(ipc.readConversation).not.toHaveBeenCalled()
  })

  it('挂载时按当前标签的 dirName/rootKey 加载正文，渲染时间线目录与正文', async () => {
    vi.mocked(ipc.readConversation).mockResolvedValue(CONV)
    useTabs.setState({
      tabs: [
        { id: 'home', kind: 'home', title: '主页', panes: [] },
        { id: 'tab-1', kind: 'term', title: '会话', panes: [{ id: 'pane-tab-1', ptyId: 'pty-tab-1', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }], activePaneId: 'pane-tab-1' },
      ],
      activeId: 'tab-1',
    })
    render(<ConversationPanel />)
    await waitFor(() => {
      expect(ipc.readConversation).toHaveBeenCalledWith('proj-a', 'root-1')
    })
    expect(await screen.findByText('8月27日')).toBeTruthy()
    expect(screen.getByText('12:19')).toBeTruthy()
    expect(screen.getByText('第一句话')).toBeTruthy() // 时间线摘要只取首行
    expect(screen.getByText('好的，我来处理')).toBeTruthy() // 正文按轮次渲染
  })

  it('点击刷新按钮重新请求正文', async () => {
    vi.mocked(ipc.readConversation).mockResolvedValue(CONV)
    useTabs.setState({
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', panes: [{ id: 'pane-tab-1', ptyId: 'pty-tab-1', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }], activePaneId: 'pane-tab-1' }],
      activeId: 'tab-1',
    })
    render(<ConversationPanel />)
    await waitFor(() => expect(ipc.readConversation).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTitle('刷新'))
    await waitFor(() => expect(ipc.readConversation).toHaveBeenCalledTimes(2))
  })

  it('加载失败时显示错误文案（拒绝的 promise 被妥善处理，不抛出未捕获异常）', async () => {
    vi.mocked(ipc.readConversation).mockRejectedValue(new Error('找不到会话链'))
    useTabs.setState({
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', panes: [{ id: 'pane-tab-1', ptyId: 'pty-tab-1', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }], activePaneId: 'pane-tab-1' }],
      activeId: 'tab-1',
    })
    render(<ConversationPanel />)
    expect(await screen.findByText(/加载失败/)).toBeTruthy()
  })

  it('过期响应保护：A 标签的请求晚于 B 标签落地，切到 B 后面板必须只显示 B 的内容，绝不显示 A', async () => {
    let resolveA!: (c: typeof CONV) => void
    let resolveB!: (c: typeof CONV) => void
    const pendingA = new Promise<typeof CONV>((res) => { resolveA = res })
    const pendingB = new Promise<typeof CONV>((res) => { resolveB = res })
    vi.mocked(ipc.readConversation).mockImplementation((dirName: string) =>
      dirName === 'proj-a' ? pendingA : pendingB
    )
    useTabs.setState({
      tabs: [
        { id: 'tab-a', kind: 'term', title: 'A', panes: [{ id: 'pane-tab-a', ptyId: 'pty-tab-a', title: 'A', dirName: 'proj-a', rootKey: 'root-a' }], activePaneId: 'pane-tab-a' },
        { id: 'tab-b', kind: 'term', title: 'B', panes: [{ id: 'pane-tab-b', ptyId: 'pty-tab-b', title: 'B', dirName: 'proj-b', rootKey: 'root-b' }], activePaneId: 'pane-tab-b' },
      ],
      activeId: 'tab-a',
    })
    render(<ConversationPanel />)
    await waitFor(() => expect(ipc.readConversation).toHaveBeenCalledWith('proj-a', 'root-a'))

    // 在 A 的请求解决之前切换到 B（模拟：冷会话 A 的请求较慢，用户已经点到了 B）
    act(() => {
      useTabs.setState({ activeId: 'tab-b' })
    })
    await waitFor(() => expect(ipc.readConversation).toHaveBeenCalledWith('proj-b', 'root-b'))

    // B（当前激活标签）的响应先落地
    await act(async () => {
      resolveB({
        turns: [{ role: 'assistant', text: 'B的回答', tsMs: Date.now(), uuid: 'b1' }],
        files: ['/b.jsonl'],
        totalBytes: 1,
      })
      await pendingB
    })
    expect(await screen.findByText('B的回答')).toBeTruthy()

    // A（已切走的旧标签）的响应晚到——必须被静默丢弃，不能覆盖 B 已显示的内容
    await act(async () => {
      resolveA({
        turns: [{ role: 'assistant', text: 'A的回答', tsMs: Date.now(), uuid: 'a1' }],
        files: ['/a.jsonl'],
        totalBytes: 1,
      })
      await pendingA
    })

    expect(screen.queryByText('A的回答')).toBeNull()
    expect(screen.getByText('B的回答')).toBeTruthy()
  })
})

// 分屏第二步：面板始终跟随"聚焦窗格"所属的会话（设计文档 §7）。ConversationPanel.tsx
// 本身从 step1 起就已经是"先找激活标签、再取其 activePaneId 对应窗格"的两级 selector
// （见该文件顶部注释），本用例只是证明：同一标签内切换 focusPane（⌘⌥←/→ 的落地动作）
// 也会驱动面板切换内容，并同样走 requestIdRef 过期响应保护，不需要也没有改动
// ConversationPanel.tsx 一行代码。
describe('ConversationPanel — 同一标签内切换聚焦窗格时，面板跟随切换内容', () => {
  it('多窗格标签：focusPane 切换后面板重新加载并只显示新聚焦窗格的会话', async () => {
    const convPane1 = {
      turns: [{ role: 'assistant', text: '窗格一的回答', tsMs: Date.now(), uuid: 'pane1-a' }],
      files: ['/1.jsonl'],
      totalBytes: 1,
    }
    const convPane2 = {
      turns: [{ role: 'assistant', text: '窗格二的回答', tsMs: Date.now(), uuid: 'pane2-a' }],
      files: ['/2.jsonl'],
      totalBytes: 1,
    }
    vi.mocked(ipc.readConversation).mockImplementation((dirName: string) =>
      Promise.resolve(dirName === 'proj-1' ? convPane1 : convPane2)
    )
    const tab = {
      id: 'tab-multi',
      kind: 'term' as const,
      title: '2 个对话',
      panes: [
        { id: 'pane-1', ptyId: 'pty-1', title: '窗格一', dirName: 'proj-1', rootKey: 'root-1' },
        { id: 'pane-2', ptyId: 'pty-2', title: '窗格二', dirName: 'proj-2', rootKey: 'root-2' },
      ],
      activePaneId: 'pane-1',
    }
    useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }, tab], activeId: 'tab-multi' })

    render(<ConversationPanel />)
    expect(await screen.findByText('窗格一的回答')).toBeTruthy()
    expect(screen.queryByText('窗格二的回答')).toBeNull()

    // 模拟 ⌘⌥→：焦点窗格从 pane-1 移到 pane-2（不切标签，activeId 不变）
    act(() => {
      useTabs.getState().focusPane('tab-multi', 'pane-2')
    })

    await waitFor(() => expect(ipc.readConversation).toHaveBeenCalledWith('proj-2', 'root-2'))
    expect(await screen.findByText('窗格二的回答')).toBeTruthy()
    expect(screen.queryByText('窗格一的回答')).toBeNull() // 旧窗格内容被替换，不是叠加显示
  })
})

const TWO_DAY_CONV = {
  turns: [
    { role: 'user', text: '8月27日的话题\n详情A', tsMs: new Date(2026, 7, 27, 12, 19).getTime(), uuid: 'u-27' },
    { role: 'user', text: '8月26日的话题\n详情B', tsMs: new Date(2026, 7, 26, 9, 0).getTime(), uuid: 'u-26' },
  ],
  files: ['/x.jsonl'],
  totalBytes: 100,
}

describe('ConversationPanel — 时间线日期分组可折叠', () => {
  it('只展开最新一天的分组，其余日期默认折叠并显示条目数', async () => {
    vi.mocked(ipc.readConversation).mockResolvedValue(TWO_DAY_CONV)
    useTabs.setState({
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', panes: [{ id: 'pane-tab-1', ptyId: 'pty-tab-1', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }], activePaneId: 'pane-tab-1' }],
      activeId: 'tab-1',
    })
    render(<ConversationPanel />)
    expect(await screen.findByText('8月27日的话题')).toBeTruthy() // 最新一天默认展开
    expect(screen.queryByText('8月26日的话题')).toBeNull() // 较旧一天默认折叠
    const olderToggle = screen.getByText('8月26日').closest('button')!
    expect(olderToggle).toBeTruthy()
    expect(within(olderToggle).getByText('(1)')).toBeTruthy() // 折叠时显示条目数
    expect(olderToggle.getAttribute('aria-expanded')).toBe('false')
    const newerToggle = screen.getByText('8月27日').closest('button')!
    expect(newerToggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('点击折叠的分组标题展开条目，再点击收起', async () => {
    vi.mocked(ipc.readConversation).mockResolvedValue(TWO_DAY_CONV)
    useTabs.setState({
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', panes: [{ id: 'pane-tab-1', ptyId: 'pty-tab-1', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }], activePaneId: 'pane-tab-1' }],
      activeId: 'tab-1',
    })
    render(<ConversationPanel />)
    await screen.findByText('8月27日的话题')
    fireEvent.click(screen.getByText('8月26日'))
    expect(await screen.findByText('8月26日的话题')).toBeTruthy()
    fireEvent.click(screen.getByText('8月26日'))
    await waitFor(() => expect(screen.queryByText('8月26日的话题')).toBeNull())
  })

  it('切换标签加载新会话时，展开状态重新播种为新会话最新一天（不沿用旧会话的手动展开）', async () => {
    const convA = TWO_DAY_CONV
    const convB = {
      turns: [
        { role: 'user', text: 'B会话较新一天\n详情', tsMs: new Date(2026, 7, 27, 10, 0).getTime(), uuid: 'b-27' },
        { role: 'user', text: 'B会话较旧一天\n详情', tsMs: new Date(2026, 7, 20, 10, 0).getTime(), uuid: 'b-20' },
      ],
      files: ['/b.jsonl'],
      totalBytes: 1,
    }
    vi.mocked(ipc.readConversation).mockImplementation((dirName: string) =>
      Promise.resolve(dirName === 'proj-a' ? convA : convB)
    )
    useTabs.setState({
      tabs: [
        { id: 'tab-a', kind: 'term', title: 'A', panes: [{ id: 'pane-tab-a', ptyId: 'pty-tab-a', title: 'A', dirName: 'proj-a', rootKey: 'root-a' }], activePaneId: 'pane-tab-a' },
        { id: 'tab-b', kind: 'term', title: 'B', panes: [{ id: 'pane-tab-b', ptyId: 'pty-tab-b', title: 'B', dirName: 'proj-b', rootKey: 'root-b' }], activePaneId: 'pane-tab-b' },
      ],
      activeId: 'tab-a',
    })
    render(<ConversationPanel />)
    await screen.findByText('8月27日的话题')
    // 在 A 上手动展开较旧一天
    fireEvent.click(screen.getByText('8月26日'))
    expect(await screen.findByText('8月26日的话题')).toBeTruthy()

    act(() => { useTabs.setState({ activeId: 'tab-b' }) })
    await screen.findByText('B会话较新一天')
    // B 的较旧一天必须是折叠的，不能延续 A 里"展开较旧分组"的状态
    expect(screen.queryByText('B会话较旧一天')).toBeNull()
  })
})

describe('ConversationPanel — 面板宽度可拖拽', () => {
  const originalInnerWidth = window.innerWidth

  beforeEach(() => {
    useLayout.setState({ panelWidth: 400 })
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
  })

  it('拖动左边缘手柄改变宽度：向左拖变宽，仅在 pointerup 时落盘持久化', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    render(<ConversationPanel />)
    const handle = screen.getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 }) // 左移 100px → 变宽 100px
    expect(useLayout.getState().panelWidth).toBe(500)
    expect(setItemSpy).not.toHaveBeenCalledWith('aterm-panel-width', expect.anything())
    fireEvent.pointerUp(handle, { clientX: 400, pointerId: 1 })
    expect(setItemSpy).toHaveBeenCalledWith('aterm-panel-width', '500')
    setItemSpy.mockRestore()
  })

  it('向右拖变窄，且不超过 [280, 900] 的静态边界', () => {
    render(<ConversationPanel />)
    const handle = screen.getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 5000, pointerId: 1 }) // 尝试拖到远小于 280
    expect(useLayout.getState().panelWidth).toBe(280)
  })

  it('拖拽宽度不超过窗口宽度的 60%（现算，不依赖 resize 监听器）', () => {
    Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true }) // 60% = 360
    render(<ConversationPanel />)
    const handle = screen.getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 }) // 尝试拖到 900
    expect(useLayout.getState().panelWidth).toBe(360)
  })

  it('双击手柄把宽度复位到 400 并落盘', () => {
    useLayout.getState().setPanelWidth(700)
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    render(<ConversationPanel />)
    const handle = screen.getByRole('separator')
    fireEvent.doubleClick(handle)
    expect(useLayout.getState().panelWidth).toBe(400)
    expect(setItemSpy).toHaveBeenCalledWith('aterm-panel-width', '400')
    setItemSpy.mockRestore()
  })
})

describe('ConversationPanel — 时间线区域整体高度可拖拽 + 双击折叠', () => {
  beforeEach(() => {
    useLayout.setState({ timelineHeight: 220, timelineCollapsed: false })
    vi.mocked(ipc.readConversation).mockResolvedValue(CONV)
    useTabs.setState({
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', panes: [{ id: 'pane-tab-1', ptyId: 'pty-tab-1', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }], activePaneId: 'pane-tab-1' }],
      activeId: 'tab-1',
    })
  })

  it('拖动分隔条改变时间线区高度：向下拖变高，仅在 pointerup 时落盘持久化', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    render(<ConversationPanel />)
    const divider = await screen.findByTitle('拖动调整时间线高度（双击折叠）')
    fireEvent.pointerDown(divider, { clientY: 300, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientY: 350, pointerId: 1 }) // 下移 50px → 变高 50px
    expect(useLayout.getState().timelineHeight).toBe(270)
    expect(setItemSpy).not.toHaveBeenCalledWith('aterm-timeline-height', expect.anything())
    fireEvent.pointerUp(divider, { clientY: 350, pointerId: 1 })
    expect(setItemSpy).toHaveBeenCalledWith('aterm-timeline-height', '270')
    setItemSpy.mockRestore()
  })

  it('向上拖变矮，不低于 80px 下限', async () => {
    render(<ConversationPanel />)
    const divider = await screen.findByTitle('拖动调整时间线高度（双击折叠）')
    fireEvent.pointerDown(divider, { clientY: 300, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientY: -1000, pointerId: 1 }) // 尝试拖到远小于 80
    expect(useLayout.getState().timelineHeight).toBe(80)
  })

  it('拖拽高度不超过内容区高度的 60%（现算，不依赖 resize 监听器）', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 500 })
    try {
      render(<ConversationPanel />)
      const divider = await screen.findByTitle('拖动调整时间线高度（双击折叠）')
      fireEvent.pointerDown(divider, { clientY: 300, pointerId: 1 })
      fireEvent.pointerMove(divider, { clientY: 3000, pointerId: 1 }) // 尝试拖到远超过 60% of 500 = 300
      expect(useLayout.getState().timelineHeight).toBe(300)
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original)
    }
  })

  it('双击分隔条折叠/展开时间线区，并落盘持久化', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    render(<ConversationPanel />)
    const divider = await screen.findByTitle('拖动调整时间线高度（双击折叠）')
    fireEvent.doubleClick(divider)
    expect(useLayout.getState().timelineCollapsed).toBe(true)
    expect(setItemSpy).toHaveBeenCalledWith('aterm-timeline-collapsed', '1')
    fireEvent.doubleClick(divider)
    expect(useLayout.getState().timelineCollapsed).toBe(false)
    expect(setItemSpy).toHaveBeenCalledWith('aterm-timeline-collapsed', '0')
    setItemSpy.mockRestore()
  })

  it('折叠时间线区后，分隔条仍留在文档中、可再次双击恢复（不是随内容一起消失）', async () => {
    render(<ConversationPanel />)
    const divider = await screen.findByTitle('拖动调整时间线高度（双击折叠）')
    fireEvent.doubleClick(divider)
    expect(useLayout.getState().timelineCollapsed).toBe(true)
    expect(screen.getByTitle('拖动调整时间线高度（双击折叠）')).toBeTruthy()
    const timelineEl = document.querySelector('.conv-timeline') as HTMLElement
    expect(timelineEl.style.height).toBe('0px')
    fireEvent.doubleClick(screen.getByTitle('拖动调整时间线高度（双击折叠）'))
    expect(useLayout.getState().timelineCollapsed).toBe(false)
  })

  it('折叠状态下拖拽分隔条不产生效果（需要先双击展开）', async () => {
    useLayout.setState({ timelineCollapsed: true })
    render(<ConversationPanel />)
    const divider = await screen.findByTitle('拖动调整时间线高度（双击折叠）')
    const before = useLayout.getState().timelineHeight
    fireEvent.pointerDown(divider, { clientY: 300, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientY: 400, pointerId: 1 })
    expect(useLayout.getState().timelineHeight).toBe(before)
  })

  it('头部的折叠按钮与分隔条双击驱动同一份 timelineCollapsed 状态，两个入口保持同步', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    render(<ConversationPanel />)
    const divider = await screen.findByTitle('拖动调整时间线高度（双击折叠）')
    // 初始未折叠：按钮应显示"折叠时间线"（⌄）。
    const toggleButton = screen.getByTitle('折叠时间线')
    expect(toggleButton.textContent).toBe('⌄')

    fireEvent.click(toggleButton)
    expect(useLayout.getState().timelineCollapsed).toBe(true)
    expect(setItemSpy).toHaveBeenCalledWith('aterm-timeline-collapsed', '1') // 与双击一样会落盘
    expect(document.querySelector('.conv-timeline')?.getAttribute('style')).toContain('height: 0px')
    // 按钮翻转为"展开时间线"（⌃），与分隔条的折叠态保持一致。
    expect(screen.getByTitle('展开时间线').textContent).toBe('⌃')
    expect(screen.queryByTitle('折叠时间线')).toBeNull()

    // 换成分隔条双击来展开——证明两个入口驱动的是同一份状态，不是各管一头。
    fireEvent.doubleClick(divider)
    expect(useLayout.getState().timelineCollapsed).toBe(false)
    expect(setItemSpy).toHaveBeenCalledWith('aterm-timeline-collapsed', '0')
    expect(screen.getByTitle('折叠时间线').textContent).toBe('⌄')

    setItemSpy.mockRestore()
  })
})

describe('ConversationPanel — 渲染时钳制时间线高度（不仅是拖拽时现算）', () => {
  it('持久化的高度超过内容区 60% 时，挂载后被纠正（而非原样应用导致溢出）', async () => {
    // 模拟"窗口在保存了较大高度之后被缩短过"：持久化值 1000 远超当前内容区能给的上限。
    useLayout.setState({ timelineHeight: 1000, timelineCollapsed: false })
    vi.mocked(ipc.readConversation).mockResolvedValue(CONV)
    useTabs.setState({
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', panes: [{ id: 'pane-tab-1', ptyId: 'pty-tab-1', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }], activePaneId: 'pane-tab-1' }],
      activeId: 'tab-1',
    })
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 500 })
    try {
      render(<ConversationPanel />)
      await screen.findByText('第一句话') // 等内容真正渲染出来（这一刻内容区高度才可测）
      // 60% of 500 = 300：既没有原样应用 1000，也不是只在视觉上裁一刀——store 里的值本身
      // 被纠正了，并且落盘了（下次挂载不会又读回超量的旧值）。
      await waitFor(() => expect(useLayout.getState().timelineHeight).toBe(300))
      expect(setItemSpy).toHaveBeenCalledWith('aterm-timeline-height', '300')
      const timelineEl = document.querySelector('.conv-timeline') as HTMLElement
      expect(timelineEl.style.height).toBe('300px')
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original)
      setItemSpy.mockRestore()
    }
  })

  it('持久化的高度本就在 60% 以内时，挂载后保持原样、不触发多余的落盘', async () => {
    useLayout.setState({ timelineHeight: 220, timelineCollapsed: false })
    vi.mocked(ipc.readConversation).mockResolvedValue(CONV)
    useTabs.setState({
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', panes: [{ id: 'pane-tab-1', ptyId: 'pty-tab-1', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }], activePaneId: 'pane-tab-1' }],
      activeId: 'tab-1',
    })
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 500 }) // 60% = 300 > 220
    try {
      render(<ConversationPanel />)
      await screen.findByText('第一句话')
      await Promise.resolve()
      expect(useLayout.getState().timelineHeight).toBe(220)
      expect(setItemSpy).not.toHaveBeenCalledWith('aterm-timeline-height', expect.anything())
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original)
      setItemSpy.mockRestore()
    }
  })
})

describe('ConversationPanel — 折叠态完全消失，展开/折叠分别由 TabBar 与面板顶栏两个入口负责', () => {
  beforeEach(() => {
    useLayout.setState({ panelCollapsed: false })
  })

  it('折叠时面板不渲染任何内容（不是收成细条）', () => {
    const { container } = render(<ConversationPanel />)
    act(() => { useLayout.getState().togglePanel() })
    expect(useLayout.getState().panelCollapsed).toBe(true)
    expect(container.firstChild).toBeNull() // 完全不渲染，不占用任何空间
  })

  it('展开态头部自带折叠按钮，点击后 panelCollapsed 变为 true', async () => {
    vi.mocked(ipc.readConversation).mockResolvedValue(CONV)
    useTabs.setState({
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', panes: [{ id: 'pane-tab-1', ptyId: 'pty-tab-1', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }], activePaneId: 'pane-tab-1' }],
      activeId: 'tab-1',
    })
    render(<ConversationPanel />)
    const btn = screen.getByTitle('隐藏对话面板 (⌘J)')
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
    expect(useLayout.getState().panelCollapsed).toBe(true)
    await waitFor(() => expect(ipc.readConversation).toHaveBeenCalledWith('proj-a', 'root-1'))
  })

  // 关键坑位回归：面板顶栏原有的 conv-header-actions 整个包在 `{hasThread && ...}`
  // 里——折叠按钮绝不能放进这个条件内部，否则用户在没有关联对话的标签（例如普通
  // zsh 终端标签）上打开面板后，面板顶栏没有任何按钮，而 TabBar 那个又因为展开态被
  // 隐藏——面板会彻底关不掉。这条用例的当前标签（home，无 panes）hasThread 必为
  // false，折叠按钮仍须存在。
  it('hasThread 为 false（当前标签没有关联对话）时，面板顶栏的折叠按钮仍然在', () => {
    useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
    render(<ConversationPanel />)
    expect(screen.getByText(/没有关联的对话/)).toBeTruthy() // 确认这条用例确实处于 hasThread=false 分支
    expect(screen.getByTitle('隐藏对话面板 (⌘J)')).toBeTruthy()
  })

  it('TabBar 与面板顶栏两个入口共享同一份 panelCollapsed：展开态 TabBar 按钮隐藏、折叠交给面板；折叠后反过来', () => {
    render(
      <>
        <TabBar />
        <ConversationPanel />
      </>,
    )
    // 展开态：面板顶栏的折叠按钮在，TabBar 的展开/折叠按钮已隐藏
    expect(screen.getByTitle('隐藏对话面板 (⌘J)')).toBeTruthy() // 面板顶栏那个
    expect(document.querySelector('.panel-toggle')).toBeNull() // TabBar 那个已隐藏
    expect(document.querySelector('.conv-panel-dock')).toBeTruthy()

    // 从面板顶栏的按钮收起
    fireEvent.click(screen.getByTitle('隐藏对话面板 (⌘J)'))
    expect(useLayout.getState().panelCollapsed).toBe(true)
    expect(document.querySelector('.conv-panel-dock')).toBeNull() // 面板完全消失
    expect(screen.getByTitle('显示对话面板 (⌘J)')).toBeTruthy() // TabBar 按钮重新出现（收起态，负责展开）

    // 从 TabBar 的按钮展开
    fireEvent.click(screen.getByTitle('显示对话面板 (⌘J)'))
    expect(useLayout.getState().panelCollapsed).toBe(false)
    expect(document.querySelector('.conv-panel-dock')).toBeTruthy()
    expect(document.querySelector('.panel-toggle')).toBeNull() // TabBar 按钮再次隐藏
  })
})

describe('ConversationPanel — 折叠时不加载，展开时按需补载', () => {
  it('挂载即折叠：切换到有会话的标签、甚至多次切换，全程不发起任何请求', async () => {
    vi.mocked(ipc.readConversation).mockResolvedValue(CONV)
    useLayout.setState({ panelCollapsed: true })
    useTabs.setState({
      tabs: [
        { id: 'home', kind: 'home', title: '主页', panes: [] },
        { id: 'tab-a', kind: 'term', title: 'A', panes: [{ id: 'pane-tab-a', ptyId: 'pty-tab-a', title: 'A', dirName: 'proj-a', rootKey: 'root-a' }], activePaneId: 'pane-tab-a' },
        { id: 'tab-b', kind: 'term', title: 'B', panes: [{ id: 'pane-tab-b', ptyId: 'pty-tab-b', title: 'B', dirName: 'proj-b', rootKey: 'root-b' }], activePaneId: 'pane-tab-b' },
      ],
      activeId: 'home',
    })
    const { container } = render(<ConversationPanel />)
    expect(container.firstChild).toBeNull() // 折叠态不渲染任何东西

    act(() => { useTabs.setState({ activeId: 'tab-a' }) })
    act(() => { useTabs.setState({ activeId: 'tab-b' }) })
    // 没有 waitFor 可等——断言的正是"什么都不会发生"；给微任务队列一次机会
    // 排空，确认不是因为异步还没跑到才看起来没调用。
    await Promise.resolve()
    await Promise.resolve()
    expect(ipc.readConversation).not.toHaveBeenCalled()
  })

  it('先在折叠状态下切到某个会话标签，再展开：只补发一次针对当前激活标签的请求', async () => {
    vi.mocked(ipc.readConversation).mockResolvedValue(CONV)
    useLayout.setState({ panelCollapsed: true })
    useTabs.setState({
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', panes: [{ id: 'pane-tab-1', ptyId: 'pty-tab-1', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }], activePaneId: 'pane-tab-1' }],
      activeId: 'tab-1',
    })
    render(<ConversationPanel />)
    await Promise.resolve()
    expect(ipc.readConversation).not.toHaveBeenCalled() // 折叠期间纵有激活会话也不加载

    act(() => { useLayout.getState().togglePanel() }) // 展开
    await waitFor(() => expect(ipc.readConversation).toHaveBeenCalledTimes(1))
    expect(ipc.readConversation).toHaveBeenCalledWith('proj-a', 'root-1')
    expect(await screen.findByText('第一句话')).toBeTruthy() // 展开后确实渲染出了内容

    // 再收起又展开：内容已经在手上，不应该重新拉取
    act(() => { useLayout.getState().togglePanel() }) // 收起
    act(() => { useLayout.getState().togglePanel() }) // 展开
    await Promise.resolve()
    expect(ipc.readConversation).toHaveBeenCalledTimes(1)
  })

  it('折叠瞬间让飞行中的旧响应过期：收起前发出的请求，收起后才落地也不会写入 state', async () => {
    let resolve!: (c: typeof CONV) => void
    const pending = new Promise<typeof CONV>((res) => { resolve = res })
    vi.mocked(ipc.readConversation).mockReturnValue(pending)
    useLayout.setState({ panelCollapsed: false })
    useTabs.setState({
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', panes: [{ id: 'pane-tab-1', ptyId: 'pty-tab-1', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }], activePaneId: 'pane-tab-1' }],
      activeId: 'tab-1',
    })
    render(<ConversationPanel />)
    await waitFor(() => expect(ipc.readConversation).toHaveBeenCalledTimes(1))

    act(() => { useLayout.getState().togglePanel() }) // 请求仍在飞行中时收起面板
    expect(useLayout.getState().panelCollapsed).toBe(true)

    await act(async () => {
      resolve(CONV)
      await pending
    })

    // 响应虽然落地了，但收起时那次生成计数已经作废它——展开后必须重新触发一次全新请求，
    // 而不是直接沿用这个"晚到"的响应。
    act(() => { useLayout.getState().togglePanel() }) // 展开
    await waitFor(() => expect(ipc.readConversation).toHaveBeenCalledTimes(2))
  })
})
