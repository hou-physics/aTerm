import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-1'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  revealInFinder: vi.fn(async () => {}),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
vi.mock('../store/status', () => ({
  statusEventsReady: Promise.resolve(),
  useThreadStatus: () => undefined,
  useProjectStatus: () => 'unknown' as const,
  useStatusStore: (selector: (s: { statuses: Map<string, unknown> }) => unknown) => selector({ statuses: new Map() }),
  threadStatusKey: (dirName: string, rootKey: string) => `${dirName}::${rootKey}`,
}))

import * as ipc from '../ipc'
import { Sidebar } from '../components/Sidebar'
import { useLibrary } from '../store/library'
import { blockKey } from '../store/overview'
import { useSessions } from '../store/sessions'
import { useSettings } from '../store/settings'
import { useTabs } from '../store/tabs'
import { makeThread } from './factories'

const dayMs = 24 * 60 * 60 * 1000

function seed(n: number) {
  useSessions.setState({
    projects: [{
      dirName: '-tmp-a', cwd: '/tmp/a', lastActivityMs: Date.now(),
      threads: Array.from({ length: n }, (_, i) =>
        makeThread({ rootKey: `r${i}`, title: `会话${i}`, lastActivityMs: Date.now() - i * 1000 })),
    }],
    loading: false,
  })
}

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  // 必须重置：removedSessions（以及同一个 store 里的 aliases/hiddenProjects）不清会在
  // 用例之间互相污染——那类污染的典型表现是"单跑绿、全量红"，因为后一条用例种下的
  // removedSessions 会残留到下一条，非常难查。
  useLibrary.setState({ aliases: {}, hiddenProjects: {}, removedSessions: {} })
  vi.clearAllMocks()
})

describe('侧栏最近会话', () => {
  it('超过 12 条也全部渲染——列表本就填满高度并滚动，不该再截断', () => {
    seed(20)
    render(<Sidebar />)
    expect(screen.queryByText('会话19')).toBeTruthy()
  })

  it('按今天/昨天/更早分组，且不产出空组', () => {
    const now = Date.now()
    useSessions.setState({
      projects: [{
        dirName: '-tmp-a', cwd: '/tmp/a', lastActivityMs: now,
        threads: [
          makeThread({ rootKey: 'r1', title: '今天的', lastActivityMs: now }),
          makeThread({ rootKey: 'r2', title: '很早的', lastActivityMs: now - 10 * dayMs }),
        ],
      }],
      loading: false,
    })
    render(<Sidebar />)
    expect(screen.queryByText('今天')).toBeTruthy()
    expect(screen.queryByText('更早')).toBeTruthy()
    expect(screen.queryByText('昨天')).toBeNull()   // 没有昨天的会话就不该有这个标题
  })

  it('单击只选中不打开——这正是防误触的要点', () => {
    seed(3)
    render(<Sidebar />)
    fireEvent.click(screen.getByText('会话0'))
    expect(ipc.ptySpawn).not.toHaveBeenCalled()
    expect(useTabs.getState().tabs.filter((t) => t.kind === 'term').length).toBe(0)
  })

  it('单击后该行带上选中态 class', () => {
    seed(3)
    render(<Sidebar />)
    const row = screen.getByText('会话0').closest('.side-item')!
    expect(row.classList.contains('side-item-selected')).toBe(false)
    fireEvent.click(screen.getByText('会话0'))
    expect(row.classList.contains('side-item-selected')).toBe(true)
  })

  it('双击才打开', async () => {
    seed(3)
    render(<Sidebar />)
    // resumeThread → useTabs.openTerminal 在调用 ptySpawn 之前先 `await ptyEventsReady`
    // （即便是已 resolve 的 promise，也要让出一次微任务），因此这里需要 act(async) 让
    // 出一次微任务队列，断言才能看到 ptySpawn 已被调用——与 OverviewPage.test.tsx 里
    // 「双击到底有没有打开会话」那条用例遇到的是同一类异步边界，只是那边选择整个
    // mock 掉 ../actions 绕开这条链路，这里维持 brief 给的、直接断言 ipc.ptySpawn 的
    // 写法，只补上必需的一次微任务让出。
    await act(async () => {
      fireEvent.doubleClick(screen.getByText('会话0'))
    })
    expect(ipc.ptySpawn).toHaveBeenCalled()
  })

  it('未命名会话显示「新对话」而不是 uuid 前 8 位', () => {
    useSessions.setState({
      projects: [{
        dirName: '-tmp-a', cwd: '/tmp/a', lastActivityMs: Date.now(),
        threads: [makeThread({ rootKey: 'r1', title: 'ebd067d4', titled: false, lastActivityMs: Date.now() })],
      }],
      loading: false,
    })
    render(<Sidebar />)
    expect(screen.queryByText('新对话')).toBeTruthy()
    expect(screen.queryByText('ebd067d4')).toBeNull()
  })

  it('已移除的会话不出现在列表里，同项目其它会话仍在', () => {
    seed(3)
    // 移除时刻晚于 r0 的 lastActivityMs——isSessionRemoved 应判定为"仍隐去"。
    useLibrary.setState({ removedSessions: { [blockKey('-tmp-a', 'r0')]: Date.now() + dayMs } })
    render(<Sidebar />)
    expect(screen.queryByText('会话0')).toBeNull()
    expect(screen.queryByText('会话1')).toBeTruthy()
  })

  it('移除后又有新活动的会话会自动回到列表——「下次再用它默认可以出现」', () => {
    seed(3)
    // 移除时刻早于 r0 的 lastActivityMs：移除之后这条会话又有了新活动，应自动回归，
    // 不该被永久隐藏。这条专门盯住 isSessionRemoved 的比较方向有没有被写反——只有
    // 上一条「仍隐去」用例的话，把实现改成"只要在 removedSessions 里就永久隐藏"
    // 同样会通过。
    useLibrary.setState({ removedSessions: { [blockKey('-tmp-a', 'r0')]: 1 } })
    render(<Sidebar />)
    expect(screen.queryByText('会话0')).toBeTruthy()
  })
})

// 终审必修 3a：会话被逐条「从列表移除」到空之后，`.sidebar-list` 此前是一片空白，
// 没有任何解释。与 HomePage.tsx「已隐藏全部项目」那条空态同一惯例——必须区分
// "本来就没有会话"与"有会话、但被自己全部移除了"，不能用同一句文案糊弄过去。
describe('侧栏空态（终审必修 3a）', () => {
  it('本来就没有任何会话：显示「尚未发现 Claude Code 会话」', () => {
    useSessions.setState({ projects: [], loading: false })
    render(<Sidebar />)
    expect(screen.queryByText(/尚未发现 Claude Code 会话/)).toBeTruthy()
    expect(screen.queryByText(/已从列表移除/)).toBeNull()
  })

  it('有会话，但全被移除了：显示「已从列表移除全部会话」，不是「尚未发现会话」', () => {
    seed(2)
    useLibrary.setState({
      removedSessions: {
        [blockKey('-tmp-a', 'r0')]: Date.now() + dayMs,
        [blockKey('-tmp-a', 'r1')]: Date.now() + dayMs,
      },
    })
    render(<Sidebar />)
    // 不是「尚未发现会话」那句——那是给"真的一个会话都没有"准备的，语义不同，用错了
    // 会让用户误以为 ~/.claude/projects 是空的，而不是"我自己把它们移除了"。
    expect(screen.queryByText(/尚未发现 Claude Code 会话/)).toBeNull()
    expect(screen.queryByText(/已从列表移除全部会话/)).toBeTruthy()
  })

  it('还有至少一条会话在列表里时，不显示任何空态文案', () => {
    seed(2)
    render(<Sidebar />)
    expect(screen.queryByText(/尚未发现 Claude Code 会话/)).toBeNull()
    expect(screen.queryByText(/已从列表移除全部会话/)).toBeNull()
  })
})

// Task 5：侧栏底部清空——主题选择器（ThemeSwitcher.tsx）与 hooks 手动入口
// （HooksInstall.tsx 的 HooksControl）都已复制进新的设置浮层（Task 3/4：
// AppearanceSection.tsx / HooksSection.tsx），旧的两个组件在这里应当彻底不再渲染，
// 换成一个打开设置浮层的齿轮按钮。
describe('Sidebar — 底部清空为设置按钮（Task 5）', () => {
  it('侧栏不再渲染主题选择器与 hooks 控件', () => {
    seed(1)
    render(<Sidebar />)
    // Task 5 R1 修复：原来这里写的是 screen.queryByText('Hooks：')，评审变异验证
    // 发现这条断言恒为 null——Testing Library 的 queryByText 要求文本节点内容与
    // 查询串逐字相等，而真实渲染里"Hooks："从不单独成一个文本节点，永远是
    // "Hooks：未安装"这样的拼接结果（HooksControl 的 JSX 是
    // `Hooks：{phase ? STATE_LABEL[phase] : '查询中…'}`，"Hooks："与状态词是两个
    // 相邻但不合并的 JSX 表达式），所以这条断言与 Hooks 控件是否被渲染毫无关系。
    // 改成与下面 .theme-switcher 同一路子的类名选择器——HooksControl 的根元素是
    // `<div className="hooks-control">`，直接查这个类名，不依赖具体文案怎么拼。
    expect(document.querySelector('.hooks-control')).toBeNull()
    expect(document.querySelector('.theme-switcher')).toBeNull()
  })

  it('侧栏底部有设置按钮，点击后打开设置浮层', () => {
    useSettings.setState({ open: false })
    seed(1)
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(useSettings.getState().open).toBe(true)
  })
})
