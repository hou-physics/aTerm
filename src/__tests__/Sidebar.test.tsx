import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

// App.tsx 挂载时会用真实的 useSessions().refresh() 覆盖任何提前用 setState 种下的
// projects（refresh 内部把 listProjects() 的结果原样写回 store）——所以这里直接在
// mock 里给出会话数据，而不是在 beforeEach 里 useSessions.setState，否则会被这次
// 挂载时的 refresh() 用空数组悄悄覆盖掉。
vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-picked'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => [
    {
      dirName: 'proj-a',
      cwd: '/home/proj-a',
      lastActivityMs: 100,
      threads: [{ rootKey: 'root-a', resumeSessionId: 'sid-a', title: '修复登录', cwd: '/home/proj-a', lastActivityMs: 100, fileCount: 1 }],
    },
  ]),
  readConversation: vi.fn(),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
vi.mock('../closeRequest', () => ({}))
vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }))

import App from '../App'
import { useDnd } from '../store/dnd'
import { useHint } from '../store/hint'
import { useTabs } from '../store/tabs'

const HOME = { id: 'home', kind: 'home' as const, title: '主页', panes: [] }
const TAB_A = { id: 'tab-a', kind: 'term' as const, title: 'A', panes: [{ id: 'pane-a', ptyId: 'pty-a', title: 'A' }], activePaneId: 'pane-a' }

beforeEach(() => {
  useTabs.setState({ tabs: [HOME], activeId: 'home' })
  useHint.setState({ message: null })
  useDnd.setState({ target: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function renderApp() {
  const utils = render(<App />)
  await act(async () => { await Promise.resolve() })
  return utils
}

function mockPaneRects(rects: Record<string, { left: number; top?: number; width: number; height?: number }>) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const paneId = this.getAttribute('data-pane-id')
    const r = paneId ? rects[paneId] : undefined
    const top = r?.top ?? 0
    const height = r?.height ?? 100
    const left = r?.left ?? 0
    const width = r?.width ?? 0
    return {
      top, left, width, height, right: left + width, bottom: top + height, x: left, y: top,
      toJSON() { return {} },
    } as DOMRect
  })
}

async function drag(el: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  await act(async () => {
    fireEvent.pointerDown(el, { clientX: from.x, clientY: from.y, pointerId: 1 })
    fireEvent.pointerMove(el, { clientX: to.x, clientY: to.y, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: to.x, clientY: to.y, pointerId: 1 })
  })
}

describe('Sidebar — 小幅移动的点击仍然正常触发 resumeThread（不误判为拖拽）', () => {
  it('pointerdown/move(<4px)/up 之后的原生 click 照常打开该会话', async () => {
    await renderApp() // activeId 默认 home
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await act(async () => {
      fireEvent.pointerDown(item, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(item, { clientX: 11, clientY: 10, pointerId: 1 }) // 1px，低于阈值
      fireEvent.pointerUp(item, { clientX: 11, clientY: 10, pointerId: 1 })
      fireEvent.click(item)
    })

    // resumeThread 命中不了任何已开的窗格，走 openTerminal：新开一个标签
    expect(useTabs.getState().tabs).toHaveLength(2)
    expect(useTabs.getState().tabs[1]).toMatchObject({ kind: 'term', title: '修复登录' })
  })
})

describe('Sidebar — 从「最近会话」拖入窗格区（设计文档 §5-B 场景 B）', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
  })
  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('落在激活标签窗格的右半侧：新建窗格并用该会话启动，等同 ⌘D 选择器选中同一会话', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await drag(item, { x: 10, y: 10 }, { x: 300, y: 50 }) // pane-a 矩形 [0,400) 的右半侧（中点 200）

    // 没有新开顶层标签，还是同一个 tab-a，只是多了一个窗格
    expect(useTabs.getState().tabs).toHaveLength(2)
    const t = useTabs.getState().tabs.find((x) => x.id === 'tab-a')!
    expect(t.panes.map((p) => p.id)).toEqual(['pane-a', expect.any(String)])
    const newPane = t.panes[1]
    await act(async () => { await Promise.resolve() }) // startPaneTerminal 是 async，flush 一次
    const updated = useTabs.getState().tabs.find((x) => x.id === 'tab-a')!.panes.find((p) => p.id === newPane.id)!
    expect(updated).toMatchObject({
      ptyId: 'pty-picked',
      title: '修复登录',
      threadKey: 'proj-a:root-a',
      dirName: 'proj-a',
      rootKey: 'root-a',
    })
    expect(t.activePaneId).toBe(newPane.id) // 新窗格立即成为焦点
  })

  it('落在左半侧：新窗格插在目标窗格左边', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await drag(item, { x: 10, y: 10 }, { x: 100, y: 50 }) // 左半侧

    const t = useTabs.getState().tabs.find((x) => x.id === 'tab-a')!
    expect(t.panes.map((p) => p.id)[1]).toBe('pane-a') // pane-a 现在排在第二位
    expect(t.panes).toHaveLength(2)
  })

  it('已达 3 个窗格时拒绝：显示轻提示，不新建窗格', async () => {
    const THREE = {
      id: 'tab-a', kind: 'term' as const, title: '3 个对话',
      panes: [{ id: 'p1', ptyId: 'p-1', title: 'P1' }, { id: 'p2', ptyId: 'p-2', title: 'P2' }, { id: 'p3', ptyId: 'p-3', title: 'P3' }],
      activePaneId: 'p1',
    }
    useTabs.setState({ tabs: [HOME, THREE], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ p1: { left: 0, width: 300, height: 100 } })
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await drag(item, { x: 10, y: 10 }, { x: 100, y: 50 })

    expect(screen.getByText('最多支持 3 个窗格')).toBeTruthy()
    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-a')!.panes).toHaveLength(3)
  })

  it('松手时光标不在任何窗格范围内：视为放弃，不新建窗格', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await drag(item, { x: 10, y: 10 }, { x: 9000, y: 9000 })

    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-a')!.panes).toHaveLength(1)
  })

  it('当前是主页标签（没有窗格）：拖拽全程没有落点，松手不产生任何变化', async () => {
    await renderApp() // activeId 默认 home
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement
    const before = useTabs.getState().tabs

    await drag(item, { x: 10, y: 10 }, { x: 300, y: 50 })

    expect(useDnd.getState().target).toBeNull()
    expect(useTabs.getState().tabs).toBe(before)
  })
})
