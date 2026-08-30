import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

// 与 panes.test.tsx 同一套替身：PanePicker 只经由 useSessions 读项目数据、经由
// useTabs.getState().startPaneTerminal 落地窗格填充，两者都不涉及真实 IPC/PTY。
vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-picked'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  readConversation: vi.fn(),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))

import * as ipc from '../ipc'
import { PanePicker } from '../components/PanePicker'
import { useSessions } from '../store/sessions'
import { type Tab, useTabs } from '../store/tabs'

const PROJECTS = [
  {
    dirName: 'proj-a',
    cwd: '/home/proj-a',
    lastActivityMs: 1000,
    threads: [
      { rootKey: 'a1', resumeSessionId: 'sid-a1', title: '修复登录流程', cwd: '/home/proj-a', lastActivityMs: 1000, fileCount: 1 },
      { rootKey: 'a2', resumeSessionId: 'sid-a2', title: '写单元测试', cwd: '/home/proj-a', lastActivityMs: 900, fileCount: 1 },
    ],
  },
  {
    dirName: 'proj-b',
    cwd: '/home/proj-b',
    lastActivityMs: 800,
    threads: [
      { rootKey: 'b1', resumeSessionId: 'sid-b1', title: '重构支付模块', cwd: '/home/proj-b', lastActivityMs: 800, fileCount: 1 },
    ],
  },
]

function makeTab(panes: Tab['panes'], activePaneId?: string): Tab {
  return { id: 'tab-1', kind: 'term', title: 'T', panes, activePaneId }
}

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  useSessions.setState({ projects: PROJECTS as never })
  vi.clearAllMocks()
})

describe('PanePicker — 全部项目（浏览所有项目及其会话）', () => {
  it('列出全部项目，点击项目展开出其会话列表', () => {
    const tab = makeTab([{ id: 'p1', title: '新窗格' }], 'p1')
    render(<PanePicker tab={tab} paneId="p1" />)

    // 项目头（📁 前缀）与"最近会话"里项目名子串共存，用完整文案精确匹配避免歧义
    expect(screen.getByText('📁 proj-a')).toBeTruthy()
    expect(screen.getByText('📁 proj-b')).toBeTruthy()
    // 未展开时不渲染任何项目的会话列表容器（会话标题本身可能已经出现在"最近会话"里，
    // 因此不能直接断言标题文本不存在，而是断言展开容器未渲染）
    expect(document.querySelector('.pane-picker-thread-list')).toBeNull()

    fireEvent.click(screen.getByText('📁 proj-a'))
    // 展开出的会话标题也会出现在"最近会话"里（同一份数据），限定在展开出的
    // .pane-picker-thread-list 容器内查询，避免与"最近会话"里的同名条目产生歧义。
    const threadList = document.querySelector('.pane-picker-thread-list') as HTMLElement
    expect(within(threadList).getByText('写单元测试')).toBeTruthy()
  })

  it('从「全部项目」选择会话，与从「最近会话」选择走相同的窗格填充路径（startPaneTerminal）', async () => {
    // proj-b 只有一条会话，会同时出现在"最近会话"（默认展示全部项目的会话）里；
    // 这里改从展开的项目卡片里点击，验证走的是同一条 store 路径。
    const tab = makeTab([{ id: 'p1', ptyId: 'pty-1', title: '窗格甲', dirName: undefined }, { id: 'p2', title: '新窗格' }], 'p2')
    useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }, tab], activeId: 'tab-1' })
    render(<PanePicker tab={tab} paneId="p2" />)

    fireEvent.click(screen.getByText('📁 proj-a'))
    const threadList = document.querySelector('.pane-picker-thread-list') as HTMLElement
    fireEvent.click(within(threadList).getByText('写单元测试'))

    await vi.waitFor(() => {
      const pane = useTabs.getState().tabs.find((x) => x.id === 'tab-1')!.panes.find((p) => p.id === 'p2')!
      expect(pane.ptyId).toBe('pty-picked')
      expect(pane.threadKey).toBe('proj-a:a2')
      expect(pane.dirName).toBe('proj-a')
      expect(pane.rootKey).toBe('a2')
      expect(pane.title).toBe('写单元测试')
    })
  })
})

describe('PanePicker — 搜索框过滤最近会话与全部项目（大小写不敏感）', () => {
  it('按会话标题子串过滤，命中项目下只保留匹配的会话', () => {
    const tab = makeTab([{ id: 'p1', title: '新窗格' }], 'p1')
    render(<PanePicker tab={tab} paneId="p1" />)

    fireEvent.change(screen.getByPlaceholderText('搜索会话或项目…'), { target: { value: '支付' } })

    // 最近会话里只剩"重构支付模块"
    expect(screen.getByText('重构支付模块')).toBeTruthy()
    expect(screen.queryByText('修复登录流程')).toBeNull()
    expect(screen.queryByText('写单元测试')).toBeNull()
    // 全部项目：proj-a 名字不匹配且其会话都不匹配，整个项目隐去；proj-b 保留
    expect(screen.queryByText(/proj-a/)).toBeNull()
    expect(screen.getByText('📁 proj-b')).toBeTruthy()
  })

  it('大小写不敏感：大写关键字命中小写标题', () => {
    const tab = makeTab([{ id: 'p1', title: '新窗格' }], 'p1')
    useSessions.setState({
      projects: [
        {
          dirName: 'proj-mixed',
          cwd: '/home/CamelCase',
          lastActivityMs: 500,
          threads: [{ rootKey: 'm1', resumeSessionId: 'sid-m1', title: 'fix Login Bug', cwd: '/home/CamelCase', lastActivityMs: 500, fileCount: 1 }],
        },
      ],
    })
    render(<PanePicker tab={tab} paneId="p1" />)

    fireEvent.change(screen.getByPlaceholderText('搜索会话或项目…'), { target: { value: 'CAMELCASE' } })
    expect(screen.getByText('fix Login Bug')).toBeTruthy()
  })

  it('按项目名过滤时保留该项目下全部会话（即便会话标题本身不匹配）', () => {
    const tab = makeTab([{ id: 'p1', title: '新窗格' }], 'p1')
    render(<PanePicker tab={tab} paneId="p1" />)

    fireEvent.change(screen.getByPlaceholderText('搜索会话或项目…'), { target: { value: 'proj-a' } })
    fireEvent.click(screen.getByText('📁 proj-a'))
    const threadList = document.querySelector('.pane-picker-thread-list') as HTMLElement
    expect(within(threadList).getByText('修复登录流程')).toBeTruthy()
    expect(within(threadList).getByText('写单元测试')).toBeTruthy()
  })

  it('无匹配时显示空状态提示，且不渲染任何会话/项目条目', () => {
    const tab = makeTab([{ id: 'p1', title: '新窗格' }], 'p1')
    render(<PanePicker tab={tab} paneId="p1" />)

    fireEvent.change(screen.getByPlaceholderText('搜索会话或项目…'), { target: { value: '这个关键字不会命中任何东西xyz' } })

    expect(screen.getByText('没有匹配的会话或项目')).toBeTruthy()
    expect(screen.queryByText(/proj-a/)).toBeNull()
    expect(screen.queryByText(/proj-b/)).toBeNull()
    expect(screen.queryByText('修复登录流程')).toBeNull()
  })
})

describe('PanePicker — 「新对话」默认项目解析', () => {
  it('来源窗格（拆分出本窗格的那个窗格）带 dirName 时，点击「新对话」直接用该项目启动，不再二次选择', async () => {
    const tab = makeTab(
      [{ id: 'p1', ptyId: 'pty-1', title: '窗格甲', dirName: 'proj-a', rootKey: 'a1', threadKey: 'proj-a:a1' }, { id: 'p2', title: '新窗格' }],
      'p2',
    )
    useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }, tab], activeId: 'tab-1' })
    render(<PanePicker tab={tab} paneId="p2" />)

    fireEvent.click(screen.getByText('新对话'))

    await vi.waitFor(() => {
      const pane = useTabs.getState().tabs.find((x) => x.id === 'tab-1')!.panes.find((p) => p.id === 'p2')!
      expect(pane.ptyId).toBe('pty-picked')
      expect(pane.title).toBe('新对话')
    })
    // 不应出现"选择项目"二次选择列表
    expect(screen.queryByText('选择项目')).toBeNull()
  })

  // 回归用例（Task 1 评审补测）：PanePicker 此前自己写死 `inject: 'claude'`，绕过了
  // 身份绑定——上面两个用例只断言 ptyId/title，改回写死值也不会报错。这里锁住
  // startNewConversationIn 真的走了 newConversationSpec：spawn 命令里带 --session-id，
  // 且窗格上记的 sessionId 与 inject 里的那个 uuid 必须是同一个（不能只各自非空）。
  it('「新对话」注入 --session-id，且窗格记录的 sessionId 与注入命令里的 uuid 一致', async () => {
    const tab = makeTab(
      [{ id: 'p1', ptyId: 'pty-1', title: '窗格甲', dirName: 'proj-a', rootKey: 'a1', threadKey: 'proj-a:a1' }, { id: 'p2', title: '新窗格' }],
      'p2',
    )
    useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }, tab], activeId: 'tab-1' })
    render(<PanePicker tab={tab} paneId="p2" />)

    fireEvent.click(screen.getByText('新对话'))

    await vi.waitFor(() => {
      expect(ipc.ptySpawn).toHaveBeenCalledWith(
        expect.objectContaining({ inject: expect.stringMatching(/^claude --session-id [0-9a-f-]{36}$/) }),
      )
    })

    const pane = useTabs.getState().tabs.find((x) => x.id === 'tab-1')!.panes.find((p) => p.id === 'p2')!
    expect(pane.sessionId).toBeTruthy()
    const call = vi.mocked(ipc.ptySpawn).mock.calls[0][0] as { inject: string }
    expect(call.inject).toBe(`claude --session-id ${pane.sessionId}`)
  })

  it('来源窗格没有 dirName（如普通 zsh 终端）时，点击「新对话」改为列出全部项目供选择', async () => {
    const tab = makeTab([{ id: 'p1', ptyId: 'pty-1', title: 'zsh' }, { id: 'p2', title: '新窗格' }], 'p2')
    useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }, tab], activeId: 'tab-1' })
    render(<PanePicker tab={tab} paneId="p2" />)

    fireEvent.click(screen.getByText('新对话'))
    expect(screen.getByText('选择项目')).toBeTruthy()

    fireEvent.click(screen.getByText('proj-b'))
    await vi.waitFor(() => {
      const pane = useTabs.getState().tabs.find((x) => x.id === 'tab-1')!.panes.find((p) => p.id === 'p2')!
      expect(pane.ptyId).toBe('pty-picked')
      expect(pane.title).toBe('新对话')
    })
  })
})
