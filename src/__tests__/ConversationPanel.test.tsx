import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

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
})
