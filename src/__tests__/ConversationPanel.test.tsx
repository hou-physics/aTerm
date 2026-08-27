import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-1'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  readConversation: vi.fn(),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
import * as ipc from '../ipc'
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
