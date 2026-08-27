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
import { useDragGhost } from '../store/dragGhost'
import { useHint } from '../store/hint'
import { useLayout } from '../store/layout'
import { useTabs } from '../store/tabs'

const HOME = { id: 'home', kind: 'home' as const, title: '主页', panes: [] }
const TAB_A = { id: 'tab-a', kind: 'term' as const, title: 'A', panes: [{ id: 'pane-a', ptyId: 'pty-a', title: 'A' }], activePaneId: 'pane-a' }
const TAB_B = { id: 'tab-b', kind: 'term' as const, title: 'B', panes: [{ id: 'pane-b', ptyId: 'pty-b', title: 'B' }], activePaneId: 'pane-b' }

beforeEach(() => {
  useTabs.setState({ tabs: [HOME], activeId: 'home' })
  useHint.setState({ message: null })
  useDnd.setState({ target: null, tabBarIndex: null })
  useDragGhost.setState({ visible: false, label: '', x: 0, y: 0 })
  document.body.classList.remove('dragging-no-select')
  document.body.classList.remove('dragging-grab')
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.classList.remove('dragging-no-select') // 防止某条断言失败时把 class 遗留给下一条用例
  document.body.classList.remove('dragging-grab')
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

// 标签拖拽排序（设计文档新增，见 store/tabs.ts 的 reorderTab 注释）用到的矩形伪造：
// 与 PaneDetach.test.tsx 的 mockRects 同一手法——按元素本身分类而不是按属性值查表，
// 因为 .tabbar 和标签栏里每个 .tab[data-tab-id] 是完全不同的两块区域。这里不需要
// 区分 .term-wrap（本文件的合并测试直接用现成的 mockPaneRects 处理 [data-pane-id]，
// 排序测试不需要窗格矩形），因此比 PaneDetach 那份少一类。
function mockTabBarRects(rects: Record<string, { left: number; top?: number; width: number; height?: number }>) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    let key: string | undefined
    if (this.classList.contains('tabbar')) key = 'tabbar'
    else if (this.classList.contains('tab') && this.hasAttribute('data-tab-id')) key = `tab:${this.getAttribute('data-tab-id')}`
    const r = key ? rects[key] : undefined
    const top = r?.top ?? 0
    const height = r?.height ?? 26
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

// 上一轮回归的直接回归测试（见 .superpowers/tab-menu-reorder-report.md）：pointerdown
// 上曾经无条件 e.preventDefault()，这会抑制随后本该正常触发的合成 click（右键菜单
// 项就渲染在拖拽手柄的 DOM 子树里，点击它时 pointerdown 会先冒泡到这里）。jsdom 测不出
// 这条链路本身（它的 click 从不依赖前面事件是否被 preventDefault），因此这里直接断言
// preventDefault 有没有被调用——用 fireEvent 的返回值（cancelable 事件被 preventDefault
// 后 dispatchEvent 返回 false）而不是拿 spy 去侵入合成事件对象。
describe('TabBar — 只在真正开始拖拽后才 preventDefault（不在 pointerdown 上）', () => {
  it('pointerdown 与低于 4px 阈值的 pointermove 都不 preventDefault；跨过阈值后才 preventDefault', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    const b = tabEl('B')

    let downResult = false
    let subThresholdResult = false
    let crossResult = true
    await act(async () => {
      downResult = fireEvent.pointerDown(b, { clientX: 500, clientY: 10, pointerId: 1, cancelable: true })
    })
    await act(async () => {
      subThresholdResult = fireEvent.pointerMove(b, { clientX: 502, clientY: 10, pointerId: 1, cancelable: true }) // 2px，低于阈值
    })
    await act(async () => {
      crossResult = fireEvent.pointerMove(b, { clientX: 300, clientY: 50, pointerId: 1, cancelable: true }) // 跨过 4px 阈值
    })
    await act(async () => {
      fireEvent.pointerUp(b, { clientX: 300, clientY: 50, pointerId: 1 })
    })

    expect(downResult).toBe(true) // 未被 preventDefault
    expect(subThresholdResult).toBe(true) // 未跨过阈值，未被 preventDefault
    expect(crossResult).toBe(false) // 真正开始拖拽的这一次 preventDefault 了
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

// 标签右键菜单（设计文档新增）：复用 TabPanes.tsx 窗格标题栏那一份 ContextMenu 组件
// （见该组件顶部注释），这里只测标签栏这一处接线——菜单本身"点外部/Escape/失焦关闭"
// 三种方式已经在 PaneDetach.test.tsx 里覆盖过组件行为，不重复测。
describe('TabBar — 标签右键菜单（拆分为独立标签 / 关闭标签）', () => {
  it('多窗格标签：菜单列出「拆分为独立标签」与「关闭标签」两项', async () => {
    const MULTI = { id: 'tab-a', kind: 'term' as const, title: '2 个对话', panes: [{ id: 'p1', ptyId: 'pty-1', title: 'P1' }, { id: 'p2', ptyId: 'pty-2', title: 'P2' }], activePaneId: 'p1' }
    useTabs.setState({ tabs: [HOME, MULTI], activeId: 'tab-a' })
    await renderApp()

    await act(async () => { fireEvent.contextMenu(tabEl('2 个对话'), { clientX: 50, clientY: 10 }) })

    expect(screen.getByText('拆分为独立标签')).toBeTruthy()
    expect(screen.getByText('关闭标签')).toBeTruthy()
  })

  it('单窗格标签：菜单只有「关闭标签」，没有「拆分为独立标签」这一项', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()

    await act(async () => { fireEvent.contextMenu(tabEl('A'), { clientX: 50, clientY: 10 }) })

    expect(screen.queryByText('拆分为独立标签')).toBeNull()
    expect(screen.getByText('关闭标签')).toBeTruthy()
  })

  it('主页标签：右键不弹出任何菜单', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()
    const home = document.querySelector('.tab[data-tab-id="home"]') as HTMLElement

    await act(async () => { fireEvent.contextMenu(home, { clientX: 10, clientY: 10 }) })

    expect(screen.queryByText('关闭标签')).toBeNull()
  })

  it('点击「拆分为独立标签」：产生 N 个各持有一个窗格的新标签，pane id 原样保留，菜单随即关闭', async () => {
    const MULTI = { id: 'tab-a', kind: 'term' as const, title: '2 个对话', panes: [{ id: 'p1', ptyId: 'pty-1', title: 'P1' }, { id: 'p2', ptyId: 'pty-2', title: 'P2' }], activePaneId: 'p1' }
    useTabs.setState({ tabs: [HOME, MULTI], activeId: 'tab-a' })
    await renderApp()

    await act(async () => { fireEvent.contextMenu(tabEl('2 个对话'), { clientX: 50, clientY: 10 }) })
    await act(async () => { fireEvent.click(screen.getByText('拆分为独立标签')) })

    expect(screen.queryByText('拆分为独立标签')).toBeNull() // 菜单已关闭
    const { tabs } = useTabs.getState()
    expect(tabs).toHaveLength(3) // home + 两个拆出来的新标签
    const newTabs = tabs.filter((t) => t.id !== 'home')
    expect(newTabs.map((t) => t.panes.map((p) => p.id))).toEqual([['p1'], ['p2']])
    expect(newTabs.map((t) => t.panes[0].ptyId)).toEqual(['pty-1', 'pty-2']) // ptyId 原样不变
  })

  it('点击「关闭标签」：走既有的 closeTab 路径（无存活 PTY 时直接移除，不弹确认）', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()

    await act(async () => { fireEvent.contextMenu(tabEl('A'), { clientX: 50, clientY: 10 }) })
    await act(async () => { fireEvent.click(screen.getByText('关闭标签')) })

    await vi.waitFor(() => {
      expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')).toBeUndefined()
    })
  })
})

// 标签拖拽排序（设计文档新增）：与"拖已打开的标签进窗格区"是同一次拖拽手势的两个
// 落点分支——光标在标签栏上走排序，在窗格区走既有的合并——见 TabBar.tsx 的
// onTabPointerMove/onTabPointerUp。这里只测标签栏这一处接线；纯数组数学
// （reorderInsertIndex/moveArrayItem）单独在 tabs.test.ts 里测。
describe('TabBar — 标签页拖拽排序（光标在标签栏上时，同一次拖拽走排序而不是合并）', () => {
  it('把标签拖到标签栏另一个位置：显示插入指示，松手后按位置重新排序', async () => {
    const TAB_C = { id: 'tab-c', kind: 'term' as const, title: 'C', panes: [{ id: 'pane-c', ptyId: 'pty-c', title: 'C' }], activePaneId: 'pane-c' }
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B, TAB_C], activeId: 'tab-a' })
    await renderApp()
    mockTabBarRects({
      tabbar: { left: 0, top: 0, width: 800, height: 30 },
      'tab:home': { left: 0, width: 50 },
      'tab:tab-a': { left: 50, width: 100 }, // 中点 100
      'tab:tab-b': { left: 150, width: 100 }, // 中点 200
      'tab:tab-c': { left: 250, width: 100 }, // 中点 300
    })
    const c = tabEl('C')

    // 把 C 拖到 A/B 之间（x=150，介于 A 中点 100 与 B 中点 200 之间，应插在 B 之前）
    await act(async () => {
      fireEvent.pointerDown(c, { clientX: 300, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(c, { clientX: 150, clientY: 10, pointerId: 1 })
    })
    expect(document.querySelector('.tabbar-drop-indicator')).toBeTruthy() // 插入指示出现
    expect(useDnd.getState().target).toBeNull() // 不是合并落点

    await act(async () => {
      fireEvent.pointerUp(c, { clientX: 150, clientY: 10, pointerId: 1 })
    })

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-c', 'tab-b'])
    expect(document.querySelector('.tabbar-drop-indicator')).toBeNull() // 落地后指示消失
  })

  it('主页标签恒排第一：不能被拖动（整个手势视为无效目标，不产生任何变化）', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockTabBarRects({
      tabbar: { left: 0, top: 0, width: 800, height: 30 },
      'tab:home': { left: 0, width: 50 },
      'tab:tab-a': { left: 50, width: 100 },
      'tab:tab-b': { left: 150, width: 100 },
    })
    const home = document.querySelector('.tab[data-tab-id="home"]') as HTMLElement
    const before = useTabs.getState().tabs

    await act(async () => {
      fireEvent.pointerDown(home, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(home, { clientX: 200, clientY: 10, pointerId: 1 })
    })
    expect(document.querySelector('.tabbar-drop-indicator')).toBeNull() // 无效目标，不显示指示
    expect(document.querySelector('.drag-ghost')).toBeNull()

    await act(async () => {
      fireEvent.pointerUp(home, { clientX: 200, clientY: 10, pointerId: 1 })
    })

    expect(useTabs.getState().tabs).toBe(before) // 连数组引用都没变
  })

  it('其它标签不能被拖到主页标签前面：插入下标被钳在 1', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockTabBarRects({
      tabbar: { left: 0, top: 0, width: 800, height: 30 },
      'tab:home': { left: 0, width: 50 }, // 中点 25
      'tab:tab-a': { left: 50, width: 100 },
      'tab:tab-b': { left: 150, width: 100 },
    })
    const b = tabEl('B')

    // 拖到主页标签中点左侧（几何换算的原始下标是 0），应被钳到 1（紧跟在主页后面）
    await drag(b, { x: 200, y: 10 }, { x: 5, y: 10 })

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-b', 'tab-a'])
  })

  it('落回原位：no-op，不产生状态变化', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockTabBarRects({
      tabbar: { left: 0, top: 0, width: 800, height: 30 },
      'tab:home': { left: 0, width: 50 },
      'tab:tab-a': { left: 50, width: 100 }, // 中点 100
      'tab:tab-b': { left: 150, width: 100 }, // 中点 200
    })
    const b = tabEl('B')
    const before = useTabs.getState().tabs

    // B 自己就在下标 2；把它拖到自己中点附近（几何换算仍是插在 B 之前，等同原地）
    await drag(b, { x: 200, y: 10 }, { x: 210, y: 10 })

    expect(useTabs.getState().tabs).toBe(before)
  })

  it('光标移出标签栏、落在窗格区：改走既有的合并行为，不误判成排序', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    // 局部覆盖 clientWidth，测完立即还原——不像本文件其它describe 块那样用
    // beforeEach/afterEach 包一层（只有这一条用例需要），直接手动 save/restore 避免
    // 泄漏给后面的用例/文件。
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('tabbar')) {
        return { top: 0, left: 0, width: 800, height: 30, right: 800, bottom: 30, x: 0, y: 0, toJSON() { return {} } } as DOMRect
      }
      if (this.hasAttribute('data-pane-id')) {
        return { top: 100, left: 0, width: 400, height: 100, right: 400, bottom: 200, x: 0, y: 100, toJSON() { return {} } } as DOMRect
      }
      return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() { return {} } } as DOMRect
    })
    const b = tabEl('B')

    try {
      // 光标终点 y=150 落在窗格矩形 [100,200) 内、在标签栏矩形 [0,30) 之外
      await drag(b, { x: 500, y: 10 }, { x: 300, y: 150 })

      // 走的是合并（B 被移入 A），不是排序（tabs 顺序里 B 已经不存在了，而不是被重排）
      expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeUndefined()
      const t = useTabs.getState().tabs.find((t) => t.id === 'tab-a')!
      expect(t.panes.map((p) => p.id)).toEqual(['pane-a', 'pane-b'])
    } finally {
      if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    }
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

// 拖拽期间屏蔽文本选择 + 跟随光标的拖拽指示（用户反馈"拖拽会顺带选中相邻文字"/
// "拖拽过程中没有任何视觉反馈"）：三个拖拽源共用 store/dragGhost.ts，这里只覆盖
// TabBar.tsx 这一处交互层面的接线是否正确；store 本身的行为在 dragGhost.test.ts。
describe('TabBar — 拖拽期间屏蔽文本选择并显示跟随光标的拖拽指示', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
  })
  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('跨过 4px 阈值确认是拖拽后：body 加上屏蔽选择 + 抓取光标的 class，指示显示被拖标签的标题', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 500, clientY: 10, pointerId: 1 })
    })
    expect(document.body.classList.contains('dragging-grab')).toBe(false) // 仅按下、还没跨过阈值：光标不该变

    await act(async () => {
      fireEvent.pointerMove(b, { clientX: 300, clientY: 50, pointerId: 1 }) // 超过 4px 阈值
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(true)
    expect(document.body.classList.contains('dragging-grab')).toBe(true)
    expect(document.querySelector('.drag-ghost')?.textContent).toBe('B')

    await act(async () => {
      fireEvent.pointerUp(b, { clientX: 300, clientY: 50, pointerId: 1 })
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false) // 落地后移除
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
  })

  it('pointercancel 同样移除 body class（含抓取光标）与指示（不只是正常松手这一条路径）', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 500, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 300, clientY: 50, pointerId: 1 })
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)
    expect(document.body.classList.contains('dragging-grab')).toBe(true)

    await act(async () => {
      fireEvent.pointerCancel(b, { clientX: 300, clientY: 50, pointerId: 1 })
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
  })

  it('落点被拒绝（超过上限）时同样正常清理，不留下卡住的 class', async () => {
    const TWO_A = { id: 'tab-a', kind: 'term' as const, title: '2 个对话', panes: [{ id: 'a1', ptyId: 'p-a1', title: 'A1' }, { id: 'a2', ptyId: 'p-a2', title: 'A2' }], activePaneId: 'a1' }
    const TWO_B = { id: 'tab-b', kind: 'term' as const, title: '2 个对话', panes: [{ id: 'b1', ptyId: 'p-b1', title: 'B1' }, { id: 'b2', ptyId: 'p-b2', title: 'B2' }], activePaneId: 'b1' }
    useTabs.setState({ tabs: [HOME, TWO_A, TWO_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ a1: { left: 0, width: 300, height: 100 }, a2: { left: 300, width: 300, height: 100 } })
    const b = screen.getAllByText('2 个对话')[1].closest('.tab') as HTMLElement

    await drag(b, { x: 900, y: 10 }, { x: 100, y: 50 })

    expect(screen.getByText('最多支持 3 个窗格')).toBeTruthy() // 拒绝分支确实被走到
    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
  })

  it('小幅移动（低于 4px 阈值）的普通点击：既不显示指示也不设置 class', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 100, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 101, clientY: 10, pointerId: 1 }) // 1px，低于阈值
      fireEvent.pointerUp(b, { clientX: 101, clientY: 10, pointerId: 1 })
      fireEvent.click(b)
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
    expect(useTabs.getState().activeId).toBe('tab-b') // 普通点击行为不变，仍正常切换标签
  })

  it('拖到自己标签的窗格区（no-op 分支）：从不显示指示，也不设置 class', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const a = tabEl('A')

    await drag(a, { x: 10, y: 10 }, { x: 300, y: 50 })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
  })
})

// 指针捕获丢失时的清理（review 发现：三个拖拽源此前只在 pointerup/pointercancel 上
// 清理，元素若在拖拽中途被移出 DOM，浏览器会静默释放指针捕获、只发 lostpointercapture
// 而不补发 pointerup，导致 body.dragging-no-select/dragging-grab 与拖拽指示永久卡住）。
// 这里不需要真的把标签元素从 DOM 移除——只需要证明处理器对这个事件名字本身有正确
// 反应，即证明 onTabLostPointerCapture 接线正确；真实触发场景（Sidebar.tsx 的
// 「最近会话」列表被 refresh() 挤出前 12 条）在 Sidebar.test.tsx 里用真实的 DOM 移除
// 复现。
describe('TabBar — 指针捕获丢失或组件卸载时同样清理拖拽状态（不会永久卡住 body class）', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
  })
  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('lostpointercapture：清理 body class、拖拽指示与 useDnd 的落点状态', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 500, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 300, clientY: 50, pointerId: 1 }) // 跨过阈值，真正开始拖拽
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)
    expect(document.body.classList.contains('dragging-grab')).toBe(true)
    expect(useDnd.getState().target).not.toBeNull()

    await act(async () => {
      fireEvent(b, new Event('lostpointercapture', { bubbles: true, cancelable: false }))
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
    expect(useDnd.getState().target).toBeNull()
    expect(useDnd.getState().tabBarIndex).toBeNull()
    // 没有完成任何动作——lostpointercapture 只清理，不识别落点。
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeTruthy()
  })

  it('组件卸载时若仍有一次拖拽正在进行：同样清理 body class 与拖拽状态', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    const utils = await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 500, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 300, clientY: 50, pointerId: 1 })
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)

    await act(async () => { utils.unmount() })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDnd.getState().target).toBeNull()
  })

  it('清理函数被调用两次是无害的空操作（lostpointercapture 之后又收到一次 pointerup/pointercancel）', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 500, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 300, clientY: 50, pointerId: 1 })
    })

    await act(async () => {
      fireEvent(b, new Event('lostpointercapture', { bubbles: true, cancelable: false }))
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(false)

    expect(() => {
      fireEvent.pointerCancel(b, { clientX: 300, clientY: 50, pointerId: 1 })
    }).not.toThrow()

    // 第二次调用没有把已经清空的状态重新弄脏，也没有意外触发任何合并/排序动作。
    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDnd.getState().target).toBeNull()
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeTruthy()
  })
})

// 拖放路径也使用修正后的可用宽度（review 发现：⌘D 的拒绝阈值已经用 usablePaneAreaWidth
// 扣掉了容器内边距/分隔条/窗格边框开销，但 TabBar.tsx 的合并落点仍在用原始
// clientWidth，同一份几何在两条路径上可能给出矛盾的结论）。数字与
// App.test.tsx"⌘D 新建窗格"一节的边界用例完全对应：原始测量值 640px，2 个窗格所需
// 的开销是 12+9+4=25px，修正后可用宽度只有 615px，装不下 2×320=640px。
describe('TabBar — 拖放创建窗格也按修正后的可用宽度判定，与 ⌘D 不会互相矛盾', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('原始测量值 640px：⌘D 与拖放合并对同一个 nextCount=2 的窗口几何给出同一个"拒绝"结论', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    useLayout.setState({ panelCollapsed: true, panelWidth: 0 })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 640 })
    const { getByText } = await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 640, height: 100 } })

    // 先用 ⌘D 在 tab-a 自己身上新建第二个窗格（nextCount=2），钉住这个几何下 ⌘D
    // 本身确实拒绝。
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true, cancelable: true }))
    })
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(1)
    expect(getByText('窗口太窄，放不下新窗格')).toBeTruthy()
    await act(async () => { useHint.setState({ message: null }) }) // 清掉这次提示，不干扰下面对同一条提示的断言

    // 拖放合并（把 tab-b 并进 tab-a）同样是 nextCount=2，理应给出同一个结论——修正前
    // 这里会因为用原始 clientWidth 而误判"刚好装得下"，与 ⌘D 的判断相矛盾。
    const b = tabEl('B')
    await drag(b, { x: 630, y: 10 }, { x: 500, y: 50 }) // 落在 pane-a 矩形 [0,640) 的右半侧

    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeTruthy() // 没有被误判成装得下而合并
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(1)
    expect(getByText('窗口太窄，放不下新窗格')).toBeTruthy()
  })

  it('原始测量值 665px（640+25px 开销）：⌘D 与拖放合并对同一个几何给出同一个"装得下"结论', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    useLayout.setState({ panelCollapsed: true, panelWidth: 0 })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 665 })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 665, height: 100 } })
    const b = tabEl('B')

    await drag(b, { x: 655, y: 10 }, { x: 500, y: 50 }) // 落在 pane-a 矩形右半侧

    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeUndefined() // 合并成功
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(2)
  })
})
