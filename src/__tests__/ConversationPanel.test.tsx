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

const CONV = {
  turns: [
    { role: 'user', text: '第一句话\n第二行', tsMs: new Date(2026, 7, 27, 12, 19).getTime(), uuid: 'u1' },
    { role: 'assistant', text: '好的，我来处理', tsMs: new Date(2026, 7, 27, 12, 20).getTime(), uuid: 'a1' },
  ],
  files: ['/x.jsonl'],
  totalBytes: 100,
}

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页' }], activeId: 'home' })
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
        { id: 'home', kind: 'home', title: '主页' },
        { id: 'tab-1', kind: 'term', title: '会话', dirName: 'proj-a', rootKey: 'root-1' },
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
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }],
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
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }],
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
        { id: 'tab-a', kind: 'term', title: 'A', dirName: 'proj-a', rootKey: 'root-a' },
        { id: 'tab-b', kind: 'term', title: 'B', dirName: 'proj-b', rootKey: 'root-b' },
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
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }],
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
      tabs: [{ id: 'tab-1', kind: 'term', title: '会话', dirName: 'proj-a', rootKey: 'root-1' }],
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
        { id: 'tab-a', kind: 'term', title: 'A', dirName: 'proj-a', rootKey: 'root-a' },
        { id: 'tab-b', kind: 'term', title: 'B', dirName: 'proj-b', rootKey: 'root-b' },
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
