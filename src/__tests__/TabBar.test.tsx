import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-picked'),
  ptyIsAlive: vi.fn(async () => false),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
  readConversation: vi.fn(),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
vi.mock('../closeRequest', () => ({}))
vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }))

import App from '../App'
import { useDnd } from '../store/dnd'
import { useHint } from '../store/hint'
import { useLayout } from '../store/layout'
import { useTabs } from '../store/tabs'

const HOME = { id: 'home', kind: 'home' as const, title: '主页', panes: [] }
const TAB_A = { id: 'tab-a', kind: 'term' as const, title: 'A', panes: [{ id: 'pane-a', ptyId: 'pty-a', title: 'A' }], activePaneId: 'pane-a' }
const TAB_B = { id: 'tab-b', kind: 'term' as const, title: 'B', panes: [{ id: 'pane-b', ptyId: 'pty-b', title: 'B' }], activePaneId: 'pane-b' }

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

// data-pane-id 元素的矩形由测试各自伪造（jsdom 不做真实布局，getBoundingClientRect
// 恒返回全 0）——与 App.test.tsx 用 Object.defineProperty 伪造 clientWidth 是同一手法。
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

function tabEl(title: string): HTMLElement {
  return screen.getByText(title).closest('.tab') as HTMLElement
}

async function drag(el: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  await act(async () => {
    fireEvent.pointerDown(el, { clientX: from.x, clientY: from.y, pointerId: 1 })
    fireEvent.pointerMove(el, { clientX: to.x, clientY: to.y, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: to.x, clientY: to.y, pointerId: 1 })
  })
}

describe('TabBar — 小幅移动的点击仍然正常切换标签（不误判为拖拽）', () => {
  it('pointerdown/move(<4px)/up 之后的原生 click 照常触发 setActive', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 100, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 101, clientY: 10, pointerId: 1 }) // 1px，低于 4px 阈值
      fireEvent.pointerUp(b, { clientX: 101, clientY: 10, pointerId: 1 })
      fireEvent.click(b) // 真实浏览器里 pointerup 后会补发这次 click
    })

    expect(useTabs.getState().activeId).toBe('tab-b')
  })

  it('点击关闭按钮不受拖拽判定影响，语义不变（stopPropagation，不切换标签）', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    const closeBtn = tabEl('B').querySelector('.tab-close') as HTMLElement

    await act(async () => {
      fireEvent.pointerDown(closeBtn, { clientX: 100, clientY: 10, pointerId: 1 })
      fireEvent.pointerUp(closeBtn, { clientX: 100, clientY: 10, pointerId: 1 })
      fireEvent.click(closeBtn)
    })

    // ptyIsAlive mock 恒为 false，closeTab 不会弹确认，直接移除
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeUndefined()
    expect(useTabs.getState().activeId).toBe('tab-a') // 没有被误判成"点击标签本身"而切过去
  })
})

describe('TabBar — 拖已打开的标签进窗格区（设计文档 §5-B 场景 A）', () => {
  // 与 App.test.tsx 的 ⌘D 用例同一手法：这里默认给足够宽的内容区（decidePaneFit
  // 的第一步就看它），避免与本描述块无关的窄窗口降级分支意外接管——那条路径单独在
  // 下面"⌘D 窄窗口降级复用同一套 decidePaneFit"里测。
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
  })
  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('拖非激活标签、落在激活标签窗格的右半侧：整个窗格移入，源标签移除，pane id/ptyId 原样不变，且没有走确认流程', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const b = tabEl('B')

    // 落在 pane-a 矩形 [0,400) 的右半侧（中点 200）
    await drag(b, { x: 500, y: 10 }, { x: 300, y: 50 })

    // 同步断言（不经过 waitFor）：movePanesToTab 是纯同步的 store 更新，如果代码
    // 意外走了 closeTab 那条"仍在运行则确认"的异步路径，这里的状态不会在这一刻
    // 就已经落地——这就是"没有弹确认"的直接证据，不需要去检查某个 mock 有没有被调用。
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeUndefined()
    const t = useTabs.getState().tabs.find((t) => t.id === 'tab-a')!
    expect(t.panes.map((p) => p.id)).toEqual(['pane-a', 'pane-b'])
    const moved = t.panes.find((p) => p.id === 'pane-b')!
    expect(moved.ptyId).toBe('pty-b') // ptyId 原样不变，不是重新 spawn 的
    expect(t.activePaneId).toBe('pane-b') // 移入的窗格成为焦点
  })

  it('落在左半侧：新窗格插在目标窗格左边', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const b = tabEl('B')

    await drag(b, { x: 500, y: 10 }, { x: 100, y: 50 }) // 左半侧（中点 200）

    const t = useTabs.getState().tabs.find((t) => t.id === 'tab-a')!
    expect(t.panes.map((p) => p.id)).toEqual(['pane-b', 'pane-a'])
  })

  it('移入后总窗格数超过 3：拒绝，显示轻提示，两个标签都不受影响', async () => {
    const TWO_A = { id: 'tab-a', kind: 'term' as const, title: '2 个对话', panes: [{ id: 'a1', ptyId: 'p-a1', title: 'A1' }, { id: 'a2', ptyId: 'p-a2', title: 'A2' }], activePaneId: 'a1' }
    const TWO_B = { id: 'tab-b', kind: 'term' as const, title: '2 个对话', panes: [{ id: 'b1', ptyId: 'p-b1', title: 'B1' }, { id: 'b2', ptyId: 'p-b2', title: 'B2' }], activePaneId: 'b1' }
    useTabs.setState({ tabs: [HOME, TWO_A, TWO_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ a1: { left: 0, width: 300, height: 100 }, a2: { left: 300, width: 300, height: 100 } })
    const b = screen.getAllByText('2 个对话')[1].closest('.tab') as HTMLElement

    await drag(b, { x: 900, y: 10 }, { x: 100, y: 50 })

    expect(screen.getByText('最多支持 3 个窗格')).toBeTruthy()
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeTruthy() // 源标签还在
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(2) // 目标标签未被改动
  })

  it('拖到自己标签的窗格区（激活标签自己）：空操作，不产生任何状态变化', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const a = tabEl('A')
    const before = useTabs.getState().tabs

    await drag(a, { x: 10, y: 10 }, { x: 300, y: 50 })

    expect(useTabs.getState().tabs).toBe(before) // 连引用都没变
    expect(useDnd.getState().target).toBeNull() // 拖拽过程中也从未出现过落点指示
  })

  it('松手时光标不在任何窗格范围内：视为放弃，不移动', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const b = tabEl('B')

    await drag(b, { x: 500, y: 10 }, { x: 9000, y: 9000 }) // 远在 pane-a 矩形之外

    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeTruthy()
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(1)
  })
})

describe('TabBar — ⌘D 窄窗口降级复用同一套 decidePaneFit（拖拽路径）', () => {
  // 与 App.test.tsx 的 ⌘D 用例同一手法：getContentWidth() 读的是 `.content` 元素的
  // clientWidth，jsdom 恒为 0，用 Object.defineProperty 在原型上伪造一个固定值，
  // 测完照原样恢复，避免污染其它测试文件。
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('内容区太窄、收起面板也不够：拒绝并提示，不移动、不误收面板', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    useLayout.setState({ panelCollapsed: false, panelWidth: 200 })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 300, height: 100 } })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 300 }) // 300+200=500 < 2*320=640
    const b = tabEl('B')

    await drag(b, { x: 500, y: 10 }, { x: 100, y: 50 })

    expect(screen.getByText('窗口太窄，放不下新窗格')).toBeTruthy()
    expect(useLayout.getState().panelCollapsed).toBe(false)
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeTruthy()
  })
})
