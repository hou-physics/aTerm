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

const PROJECTS = [
  {
    dirName: '-tmp-a', cwd: '/tmp/a', lastActivityMs: Date.now() - 60_000,
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
    fireEvent.contextMenu(screen.getByText('a'))     // 项目名（basename of /tmp/a）
    expect(screen.queryByText('在访达中显示')).toBeTruthy()
    expect(screen.queryByText('隐藏项目')).toBeTruthy()
  })

  it('「隐藏项目」后该项目从主页消失', async () => {
    render(<HomePage />)
    fireEvent.contextMenu(screen.getByText('a'))
    fireEvent.click(screen.getByText('隐藏项目'))
    await waitFor(() => expect(screen.queryByText('a')).toBeNull())
  })

  it('隐藏后给出可撤销提示，点撤销该项目回来', async () => {
    render(<HomePage />)
    fireEvent.contextMenu(screen.getByText('a'))
    fireEvent.click(screen.getByText('隐藏项目'))
    // 撤销动作被登记进 useHint
    const action = useHint.getState().action
    expect(action?.label).toBe('撤销')
    action!.onClick()
    await waitFor(() => expect(screen.queryByText('a')).toBeTruthy())
  })

  it('搜索结果不做隐藏过滤——明确搜出来的东西还藏起来只会让人以为坏了', async () => {
    render(<HomePage />)
    fireEvent.contextMenu(screen.getByText('a'))
    fireEvent.click(screen.getByText('隐藏项目'))
    await waitFor(() => expect(screen.queryByText('a')).toBeNull())
    fireEvent.change(screen.getByPlaceholderText(/搜索/), { target: { value: '修登录' } })
    await waitFor(() => expect(screen.queryByText('修登录')).toBeTruthy())
  })
})
