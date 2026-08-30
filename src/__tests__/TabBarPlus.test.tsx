import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-1'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  revealInFinder: vi.fn(async () => {}),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))

import * as ipc from '../ipc'
import { TabBar } from '../components/TabBar'
import { useLibrary } from '../store/library'
import { blockKey } from '../store/overview'
import { useSessions } from '../store/sessions'
import { useTabs } from '../store/tabs'
import { makeThread } from './factories'

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  useSessions.setState({
    projects: [{
      dirName: '-tmp-a', cwd: '/tmp/a', lastActivityMs: 1,
      threads: [makeThread({ rootKey: 'r1', title: '修登录', resumeSessionId: 's1' })],
    }],
    loading: false,
  })
  // 必须重置：与 SidebarList.test.tsx 同一理由——aliases/removedSessions 不清会在
  // 用例之间互相污染。
  useLibrary.setState({ aliases: {}, hiddenProjects: {}, removedSessions: {} })
  vi.clearAllMocks()
})

describe('标签栏的 ＋', () => {
  it('点一下弹出选择器，而不是直接开一个空终端', async () => {
    render(<TabBar />)
    fireEvent.click(screen.getByTitle(/新建/))
    // 选择器出现（「新终端（zsh）」是它固定的第一项）
    expect(screen.queryByText('新终端（zsh）')).toBeTruthy()
    // 冲一遍微任务队列再断言：openTerminal（store/tabs.ts）第一行是
    // `await ptyEventsReady`，不 await 推进一次的话，即使点击处理器背地里偷偷多调用
    // 了一次 newTerminal()，ptySpawn 也不可能在这次同步执行栈内被调用到——不冲队列，
    // 下面这条断言对任何实现都恒为真，测不出它本该防住的"浮层弹出的同时后台偷偷建了
    // 个标签"这种回归（本轮评审发现，见 task-5-report.md 的追加记录）。
    await act(async () => { await Promise.resolve() })
    // 关键：这一下不该已经起了 PTY；同时断言可观测结果而非仅仅"没调用某个函数"——
    // 即便换一条不经过 ptySpawn 的"背地里建标签"路径，也应该被这两行拦住。
    expect(ipc.ptySpawn).not.toHaveBeenCalled()
    expect(useTabs.getState().tabs.filter((t) => t.kind === 'term').length).toBe(0)
    expect(useTabs.getState().activeId).toBe('home')
  })

  it('在选择器里选一条会话 → 新建一个标签（而不是填充某个窗格）', async () => {
    render(<TabBar />)
    fireEvent.click(screen.getByTitle(/新建/))
    fireEvent.click(screen.getByText('修登录'))
    await waitFor(() => expect(ipc.ptySpawn).toHaveBeenCalled())
    const tabs = useTabs.getState().tabs
    // 多出了一个 term 标签
    expect(tabs.filter((t) => t.kind === 'term').length).toBe(1)
    expect(ipc.ptySpawn).toHaveBeenCalledWith(expect.objectContaining({ inject: 'claude --resume s1' }))
  })

  it('选「新终端（zsh）」→ 新建一个空终端标签', async () => {
    render(<TabBar />)
    fireEvent.click(screen.getByTitle(/新建/))
    fireEvent.click(screen.getByText('新终端（zsh）'))
    await waitFor(() => expect(ipc.ptySpawn).toHaveBeenCalled())
    expect(useTabs.getState().tabs.filter((t) => t.kind === 'term').length).toBe(1)
  })

  it('选完之后浮层关闭', async () => {
    render(<TabBar />)
    fireEvent.click(screen.getByTitle(/新建/))
    fireEvent.click(screen.getByText('新终端（zsh）'))
    await waitFor(() => expect(screen.queryByText('新终端（zsh）')).toBeNull())
  })
})

// SessionPicker（＋ 与 ⌘D 共用同一套界面）是第四个渲染会话标题的列表面，终审发现它
// 此前直渲 t.title——同样会露出 session_id 前 8 位，也无视用户刚起的别名。这里锁住
// displayTitle 的两条优先级规则在这个入口同样成立。
describe('＋ 选择器的会话标题走 displayTitle（不是裸的 t.title）', () => {
  it('titled 为 false 时显示「新对话」，不是 session_id 前 8 位', () => {
    useSessions.setState({
      projects: [{
        dirName: '-tmp-a', cwd: '/tmp/a', lastActivityMs: 1,
        threads: [makeThread({ rootKey: 'r1', title: 'ebd067d4', titled: false, resumeSessionId: 's1' })],
      }],
      loading: false,
    })
    render(<TabBar />)
    fireEvent.click(screen.getByTitle(/新建/))
    // 静态的「新对话」快捷菜单项本身也叫这个名字，所以这里不能用 getByText（会因
    // 命中两处而报错）——直接读该会话行的 .t 节点文本。
    const row = document.querySelector('.pane-picker-label + .pane-picker-item .t') as HTMLElement
    expect(row.textContent).toBe('新对话')
    expect(screen.queryByText('ebd067d4')).toBeNull()
  })

  it('有别名时优先显示别名，而不是原始标题——用户刚在侧栏起的名字这里也该认得', () => {
    useLibrary.setState({ aliases: { [blockKey('-tmp-a', 'r1')]: '我的任务' }, hiddenProjects: {}, removedSessions: {} })
    render(<TabBar />)
    fireEvent.click(screen.getByTitle(/新建/))
    expect(screen.queryByText('我的任务')).toBeTruthy()
    expect(screen.queryByText('修登录')).toBeNull()
  })

  it('已从列表移除的会话仍出现在选择器里——用户主动打开选择器就是为了找到它，不应被隐藏名单挡住', () => {
    useLibrary.setState({ aliases: {}, hiddenProjects: {}, removedSessions: { [blockKey('-tmp-a', 'r1')]: Date.now() + 999_999 } })
    render(<TabBar />)
    fireEvent.click(screen.getByTitle(/新建/))
    expect(screen.queryByText('修登录')).toBeTruthy()
  })
})
