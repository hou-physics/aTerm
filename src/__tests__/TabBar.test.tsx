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
  useDnd.setState({ target: null })
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
