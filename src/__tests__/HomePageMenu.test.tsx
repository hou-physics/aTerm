import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// mock 块照抄 src/__tests__/HomePage.test.tsx 现有的那一份，额外在 ../ipc 的 mock 里加
// revealInFinder（本任务的「在访达中显示」菜单项要用）。HomePage 会渲染 <HooksPromptBar/>，
// store/hooksInstall 的三个导出缺一个就会在 import 期抛错，整份测试文件直接跑不起来
// （同 Task 6 的注释、同 HomePage.test.tsx 的既有 mock）。
vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-1'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  revealInFinder: vi.fn(async () => {}),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
vi.mock('../store/status', () => ({ statusEventsReady: Promise.resolve(), useThreadStatus: () => undefined, useProjectStatus: () => 'unknown' as const }))
vi.mock('../store/hooksInstall', () => ({
  hooksInstallReady: Promise.resolve(),
  hooksPhase: () => null,
  useHooksInstall: Object.assign(() => null, { getState: () => ({ dismiss: () => {}, install: async () => {}, uninstall: async () => {} }) }),
}))

import { HomePage } from '../components/HomePage'
import { useHint } from '../store/hint'
import { useLibrary } from '../store/library'
import { useSessions } from '../store/sessions'
import { useTabs } from '../store/tabs'
import { makeThread } from './factories'

// 项目名用 "widget" 而不是单字符 "a"：单字符在 getByText 精确匹配下容易踩到"包一层
// span 才能命中"的陷阱（评审 Task 8 ④）。定位项目名沿用本仓库 HomePage.test.tsx 早已
// 在用的惯用法——正则局部匹配卡片里"📁 widget"这段合并文本，不需要改动生产代码的
// DOM 结构，也不引入一个只为测试存在、没有任何 CSS/选择器引用的 class。
const PROJECTS = [
  {
    dirName: '-tmp-widget', cwd: '/tmp/widget', lastActivityMs: Date.now() - 60_000,
    threads: [
      makeThread({ title: '修登录', resumeSessionId: 'sid-1' }),
    ],
  },
]

beforeEach(() => {
  useSessions.setState({ projects: PROJECTS as never, loading: false })
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  useLibrary.setState({ aliases: {}, hiddenProjects: {}, removedSessions: {} })
  useHint.setState({ message: null, action: null })
  vi.clearAllMocks()
})

describe('主页项目右键菜单', () => {
  it('右键项目卡片弹出两项', () => {
    render(<HomePage />)
    fireEvent.contextMenu(screen.getByText(/widget/))     // 项目名（basename of /tmp/widget）
    expect(screen.queryByText('在访达中显示')).toBeTruthy()
    expect(screen.queryByText('隐藏项目')).toBeTruthy()
  })

  it('「隐藏项目」后该项目从主页消失', async () => {
    render(<HomePage />)
    fireEvent.contextMenu(screen.getByText(/widget/))
    fireEvent.click(screen.getByText('隐藏项目'))
    await waitFor(() => expect(screen.queryByText(/widget/)).toBeNull())
  })

  it('隐藏后给出可撤销提示，点撤销该项目回来', async () => {
    render(<HomePage />)
    fireEvent.contextMenu(screen.getByText(/widget/))
    fireEvent.click(screen.getByText('隐藏项目'))
    // 撤销动作被登记进 useHint
    const action = useHint.getState().action
    expect(action?.label).toBe('撤销')
    action!.onClick()
    await waitFor(() => expect(screen.queryByText(/widget/)).toBeTruthy())
  })

  it('搜索结果不做隐藏过滤——明确搜出来的东西还藏起来只会让人以为坏了', async () => {
    render(<HomePage />)
    fireEvent.contextMenu(screen.getByText(/widget/))
    fireEvent.click(screen.getByText('隐藏项目'))
    await waitFor(() => expect(screen.queryByText(/widget/)).toBeNull())
    fireEvent.change(screen.getByPlaceholderText(/搜索/), { target: { value: '修登录' } })
    await waitFor(() => expect(screen.queryByText('修登录')).toBeTruthy())
  })
})

// 评审 Task 8 ①：把「最近项目」唯一的一个项目隐藏之后，卡片区不能变成一片空白——
// 本期没有设置面板兜底，唯一的恢复手段是隐藏那一刻的 2.2 秒轻提示，一旦错过就无处
// 可寻。空态文案必须让用户明白"是我自己藏起来的"，不是"没有会话"——这两件事对用户
// 是完全不同的含义，不能被同一句"尚未发现 Claude Code 会话"糊弄过去（那句是给"真的
// 一个会话都没有"这个完全不同的情形准备的）。
describe('主页项目全部隐藏后的空态提示（评审 Task 8 ①）', () => {
  it('隐藏唯一的项目后，卡片区给出"已隐藏"提示，而不是"尚未发现会话"、也不是一片空白', async () => {
    render(<HomePage />)
    fireEvent.contextMenu(screen.getByText(/widget/))
    fireEvent.click(screen.getByText('隐藏项目'))
    await waitFor(() => expect(screen.queryByText(/widget/)).toBeNull())

    // 不是「尚未发现会话」那句——那是给"真的没有任何会话"准备的，语义不同，用错了
    // 会让用户误以为 ~/.claude/projects 是空的，而不是"我自己把它藏起来了"。
    expect(screen.queryByText(/尚未发现/)).toBeNull()
    // 卡片区必须给出能让用户理解现状的提示，不能什么都不显示。
    expect(screen.queryByText(/已隐藏/)).toBeTruthy()
  })
})
