import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-picked'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  readConversation: vi.fn(),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
// App.tsx 顶层 side-effect 导入，替身掉的理由与 App.test.tsx 完全一致（见该文件注释）。
vi.mock('../closeRequest', () => ({}))
// 与 App.test.tsx 不同：这里刻意不把 TerminalView 替身成 () => null，而是渲染一个可
// 用 testid 定位、且带挂载计数的 div——本文件要验证的正是"DOM 节点/挂载次数是否
// 跨标签切换、跨窗格增删保持不变"，用 () => null 就什么都测不出来了。mountCounts 只在
// useEffect（空依赖数组，只在真正挂载时跑一次）里累加，同一节点的多次重渲染不会重复计数，
// 只有卸载后重新挂载才会让计数增加，这正是本文件要区分的"重渲染 vs 卸载重挂"。
const mountCounts = new Map<string, number>()
vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ ptyId }: { ptyId: string; active: boolean }) => {
    useEffect(() => {
      mountCounts.set(ptyId, (mountCounts.get(ptyId) ?? 0) + 1)
    }, [])
    return <div data-testid={`term-${ptyId}`} />
  },
}))

import App from '../App'
import { useTabs } from '../store/tabs'

const HOME = { id: 'home', kind: 'home' as const, title: '主页', panes: [] }
const TAB_A = { id: 'tab-a', kind: 'term' as const, title: 'A', panes: [{ id: 'pane-a', ptyId: 'pty-a', title: 'A' }], activePaneId: 'pane-a' }
const TAB_B = { id: 'tab-b', kind: 'term' as const, title: 'B', panes: [{ id: 'pane-b', ptyId: 'pty-b', title: 'B' }], activePaneId: 'pane-b' }

beforeEach(() => {
  useTabs.setState({ tabs: [HOME], activeId: 'home' })
  mountCounts.clear()
})

// 与 App.test.tsx 同一个 renderApp 帮助函数（渲染后 flush 一次微任务，吸收 useSessions
// 挂载时那次异步 refresh()，避免与本文件断言无关的 act() 噪音）。
async function renderApp() {
  const utils = render(<App />)
  await act(async () => { await Promise.resolve() })
  return utils
}

describe('TerminalLayer — 扁平挂载：终端实例不随标签切换/窗格增删销毁重建', () => {
  it('切换标签前后，同一窗格的终端 DOM 节点是同一个实例（未卸载重挂）', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()

    const before = screen.getByTestId('term-pty-a')
    await act(async () => { useTabs.getState().setActive('tab-b') })
    await act(async () => { useTabs.getState().setActive('tab-a') })
    const after = screen.getByTestId('term-pty-a')

    expect(after).toBe(before) // 同一个 DOM 节点引用，不是"看起来一样"的新节点
    expect(mountCounts.get('pty-a')).toBe(1) // mount effect 只跑过一次
  })

  it('非激活标签的终端仍然挂载在 DOM 里（只是隐藏），不是被移除', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()

    expect(screen.getByTestId('term-pty-b')).toBeTruthy() // tab-b 未激活，节点仍在
    expect(mountCounts.get('pty-b')).toBe(1)

    const wrapper = screen.getByTestId('term-pty-b').closest('.terminal-wrapper') as HTMLElement
    expect(wrapper.style.display).toBe('none') // 隐藏方式是 display:none，不是卸载
  })

  it('激活标签的终端包裹层可见（display 不是 none）', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()

    const wrapper = screen.getByTestId('term-pty-a').closest('.terminal-wrapper') as HTMLElement
    expect(wrapper.style.display).not.toBe('none')
  })

  it('给标签新增一个窗格后，已存在窗格的终端实例不受影响（仍是同一节点、挂载次数不变）', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()

    const before = screen.getByTestId('term-pty-a')
    await act(async () => { useTabs.getState().addPane('tab-a', 'pane-a') })
    const after = screen.getByTestId('term-pty-a')

    expect(after).toBe(before)
    expect(mountCounts.get('pty-a')).toBe(1)
  })

  it('关闭一个窗格后，该窗格的终端节点从 DOM 中移除；其余窗格的实例不受影响', async () => {
    const TWO = {
      id: 'tab-two', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'q1', ptyId: 'pty-q1', title: 'Q1' }, { id: 'q2', ptyId: 'pty-q2', title: 'Q2' }],
      activePaneId: 'q1',
    }
    useTabs.setState({ tabs: [HOME, TWO], activeId: 'tab-two' })
    await renderApp()

    const q1Before = screen.getByTestId('term-pty-q1')
    await act(async () => { await useTabs.getState().closePane('tab-two', 'q2') })

    expect(screen.queryByTestId('term-pty-q2')).toBeNull() // 关闭的窗格，终端节点真的没了
    expect(screen.getByTestId('term-pty-q1')).toBe(q1Before) // 剩下那个窗格未受影响
  })
})

describe('TerminalLayer — 点击终端聚焦所在窗格（设计文档 §6，终端现在渲染在扁平层里）', () => {
  it('点击某个非聚焦窗格的终端会把该窗格设为 activePaneId', async () => {
    const TWO = {
      id: 'tab-two', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'q1', ptyId: 'pty-q1', title: 'Q1' }, { id: 'q2', ptyId: 'pty-q2', title: 'Q2' }],
      activePaneId: 'q1',
    }
    useTabs.setState({ tabs: [HOME, TWO], activeId: 'tab-two' })
    await renderApp()

    fireEvent.pointerDown(screen.getByTestId('term-pty-q2'))

    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-two')!.activePaneId).toBe('q2')
  })

  it('点击已经聚焦的窗格的终端不产生多余的 focusPane 调用（activePaneId 保持不变即可）', async () => {
    const TWO = {
      id: 'tab-two', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'q1', ptyId: 'pty-q1', title: 'Q1' }, { id: 'q2', ptyId: 'pty-q2', title: 'Q2' }],
      activePaneId: 'q1',
    }
    useTabs.setState({ tabs: [HOME, TWO], activeId: 'tab-two' })
    await renderApp()

    fireEvent.pointerDown(screen.getByTestId('term-pty-q1'))

    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-two')!.activePaneId).toBe('q1')
  })
})
