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
// 与 ptyBuffer 同一理由：这批测试不关心会话状态，整个模块换成不触碰真实 Tauri 事件桥的
// 空实现（真实的合并/聚合行为由 status.test.ts / StatusDot 相关测试单独覆盖）。
vi.mock('../store/status', () => ({ statusEventsReady: Promise.resolve(), useThreadStatus: () => undefined, useProjectStatus: () => 'unknown' as const }))
// 与上面 store/status 同一理由：这批测试不关心 hooks 安装状态，整个模块换成不触碰真实
// ipc 调用的空实现（真实行为由 HooksInstall.test.tsx / hooksInstall.test.ts 单独覆盖）。
vi.mock('../store/hooksInstall', () => ({
  hooksInstallReady: Promise.resolve(),
  hooksPhase: () => null,
  useHooksInstall: Object.assign(() => null, { getState: () => ({ dismiss: () => {}, install: async () => {}, uninstall: async () => {} }) }),
}))
vi.mock('../closeRequest', () => ({}))
vi.mock('../components/TerminalView', () => ({ TerminalView: () => null }))

import App from '../App'
import { attachDragSafetyNet } from '../dragSafetyNet'
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
  useDnd.setState({ target: null, dropMode: null, refusal: null, tabBarIndex: null })
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

// 本次修复的排查记录（见 .superpowers/context-menu-portal-report.md）：PaneTitleBar
// 那一份菜单曾经嵌在拖拽手柄的 DOM 子树里、点不动菜单项（见 PaneDetach.test.tsx 同名
// 描述块）。这里的排查结论是这处标签栏菜单当时结构上不受影响——渲染在 `.tabbar` 下、
// 与各 `.tab`（真正的拖拽手柄）是兄弟节点，不是嵌套关系，因此点击一直是好的。菜单
// portal 到 document.body 之后这个结论继续成立，这里补两条断言把它钉住，并顺带验证
// TabBar.tsx 新加的 `.context-menu` 早退 guard（纵深防御，即使将来这处嵌套关系被
// 改坏也能兜住同一类问题）。
describe('TabBar — 标签右键菜单不是标签拖拽手柄的 DOM 后代（防御性回归，见 context-menu-portal-report）', () => {
  it('菜单节点 portal 到 document.body，不是任何 .tab 元素的 DOM 后代', async () => {
    const MULTI = { id: 'tab-a', kind: 'term' as const, title: '2 个对话', panes: [{ id: 'p1', ptyId: 'pty-1', title: 'P1' }, { id: 'p2', ptyId: 'pty-2', title: 'P2' }], activePaneId: 'p1' }
    useTabs.setState({ tabs: [HOME, MULTI], activeId: 'tab-a' })
    await renderApp()
    const tab = tabEl('2 个对话')

    await act(async () => { fireEvent.contextMenu(tab, { clientX: 50, clientY: 10 }) })

    const menu = document.querySelector('.context-menu') as HTMLElement
    expect(menu).toBeTruthy()
    expect(tab.contains(menu)).toBe(false)
    expect(menu.parentElement).toBe(document.body)
  })

  it('在菜单项上按下不会触发标签拖拽手柄自己的 pointerdown 逻辑', async () => {
    const MULTI = { id: 'tab-a', kind: 'term' as const, title: '2 个对话', panes: [{ id: 'p1', ptyId: 'pty-1', title: 'P1' }, { id: 'p2', ptyId: 'pty-2', title: 'P2' }], activePaneId: 'p1' }
    useTabs.setState({ tabs: [HOME, MULTI], activeId: 'tab-a' })
    await renderApp()

    await act(async () => { fireEvent.contextMenu(tabEl('2 个对话'), { clientX: 50, clientY: 10 }) })
    const menuItem = screen.getByText('拆分为独立标签')

    await act(async () => { fireEvent.pointerDown(menuItem, { clientX: 50, clientY: 10, pointerId: 7 }) })

    // 与 PaneDetach.test.tsx 同名用例同一理由：标签拖拽手柄自己的 pointerdown 一旦
    // 被触发就会无条件 blockSelect()，这里不该出现。
    expect(document.body.classList.contains('dragging-no-select')).toBe(false)

    await act(async () => { fireEvent.pointerUp(menuItem, { clientX: 50, clientY: 10, pointerId: 7 }) })
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

// 窗口级兜底（本次新增，src/dragSafetyNet.ts）：上面的 lostpointercapture 测试只能
// 证明"收到这个事件名字后处理器本身做了正确的事"——jsdom 完全没实现
// setPointerCapture/releasePointerCapture/隐式释放，无法验证"真实 WKWebView 里，
// 被移出 DOM 的节点是否真的会把 lostpointercapture 送到 React"这一层（这正是
// .superpowers/drag-cleanup-report.md 的"关切点"）。这里验证的是比这更差的一种
// 情形：元素被移出 DOM 之后*完全不触发*任何指针事件（不发 lostpointercapture、也
// 不发 pointerup/pointercancel），只有原生 pointerup/blur 落在 window 上——窗口级
// 监听不依赖被拖元素是否还在 DOM 里、也不经过 React 的合成事件委托，应当仍能兜住。
describe('TabBar — 窗口级兜底：被拖元素在拖拽中途从 DOM 消失、且未收到任何指针事件时仍能清理', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
  })
  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('元素被移出 DOM（不触发任何指针事件）后，window 上的原生 pointerup 仍能清理', async () => {
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

    // 直接把被拖的标签节点从 DOM 里摘掉——不经过 lostpointercapture，只留下"节点已经
    // 不在文档树里"这一个既成事实，专门验证不依赖它的窗口级兜底。
    b.remove()

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 0)) // 兜底的 endDrag() 被 setTimeout(fn, 0) 宏任务推迟，见 dragSafetyNet.ts 顶部注释
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDnd.getState().target).toBeNull()
    expect(useDnd.getState().tabBarIndex).toBeNull()
    // 没有完成任何动作——窗口级兜底和 lostpointercapture 一样只清理，不识别落点。
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeTruthy()
  })

  it('元素被移出 DOM 后，window 上的原生 blur（例如 ⌘Tab 切到另一个 App）同样能清理', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 500, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 300, clientY: 50, pointerId: 1 })
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)

    b.remove()

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await new Promise((r) => setTimeout(r, 0)) // 见 dragSafetyNet.ts：setTimeout(fn, 0) 宏任务推迟，不是微任务
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDnd.getState().target).toBeNull()
  })

  it('endDrag() 会摘掉窗口级兜底监听器：清理之后不会残留全局 pointerup/pointercancel/blur 监听', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    // 故意不伪造任何窗格矩形——jsdom 默认的 getBoundingClientRect() 恒为全 0，光标
    // 因此落不进任何窗格范围，target 恒为 null，pointerup 走到 endDrag() 但不完成
    // 任何合并动作，专注验证监听器本身的挂/摘，不与"合并成功"的断言互相干扰。
    const b = tabEl('B')
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 500, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 300, clientY: 50, pointerId: 1 })
      fireEvent.pointerUp(b, { clientX: 300, clientY: 50, pointerId: 1 }) // 正常路径收尾，走 endDrag()
    })

    // pointerup/pointercancel 依旧走捕获阶段——这两处没有改动（见 dragSafetyNet.ts）。
    const removedCaptureTypes = removeSpy.mock.calls
      .filter(([, , opts]) => typeof opts === 'object' && opts !== null && opts.capture === true)
      .map(([type]) => type)
    expect(removedCaptureTypes).toEqual(expect.arrayContaining(['pointerup', 'pointercancel']))
    // blur 改成非捕获阶段监听（见 dragSafetyNet.ts 顶部注释：捕获阶段对不冒泡的事件
    // 同样会看到文档树里任意元素的失焦，只有非捕获阶段的 window 监听器才只在 window
    // 自己是事件目标时才会被命中）——因此这里摘除时不带 capture:true，单独断言一次。
    const blurRemovedWithoutCapture = removeSpy.mock.calls.some(
      ([type, , opts]) => type === 'blur' && !(typeof opts === 'object' && opts !== null && opts.capture === true),
    )
    expect(blurRemovedWithoutCapture).toBe(true)

    // 监听器确实摘掉了：清理之后再有一次原生 pointerup 落在 window 上，不会再产生任何
    // 可观察效果（body class 早已是干净状态，不会被重新弄脏，也不会误触发任何动作）。
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 0)) // 见 dragSafetyNet.ts：setTimeout(fn, 0) 宏任务推迟，不是微任务
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeTruthy()
  })
})

// 上一轮回归（本轮修复，见 .superpowers/drag-blur-fix-report.md）：dragSafetyNet.ts 的
// blur 兜底曾经用 capture:true 挂在 window 上。捕获阶段对不冒泡的事件同样会先经过
// window——这意味着文档树里任意元素的 blur（不只是窗口整体失焦）都会被这张网误判成
// "应当中止拖拽"。pointerdown 上一轮移除了 preventDefault()（见 onTabPointerDown
// 注释）之后，焦点会正常从此前聚焦的元素（例如 xterm 的隐藏 textarea）移开，产生一次
// 元素级 blur——这张网在 pointerdown 刚挂上、第一次 pointermove 还没发生之前就先把
// dragRef 清空了，导致 onTabPointerMove 读到 null 直接 return，拖拽从未真正开始。
// 三处拖拽源（TabBar/Sidebar/TabPanes）共用同一张网，症状是"所有拖拽都失效"。
describe('TabBar — 回归：pointerdown 之后任意元素失焦不应中止正在进行的拖拽', () => {
  it('pointerdown → 文档内某元素 blur（不是 window 失焦）→ pointermove 越过阈值：拖拽仍正常开始并能完成排序', async () => {
    const TAB_C = { id: 'tab-c', kind: 'term' as const, title: 'C', panes: [{ id: 'pane-c', ptyId: 'pty-c', title: 'C' }], activePaneId: 'pane-c' }
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B, TAB_C], activeId: 'tab-a' })
    await renderApp()
    mockTabBarRects({
      tabbar: { left: 0, top: 0, width: 800, height: 30 },
      'tab:home': { left: 0, width: 50 },
      'tab:tab-a': { left: 50, width: 100 },
      'tab:tab-b': { left: 150, width: 100 },
      'tab:tab-c': { left: 250, width: 100 }, // 中点 300
    })
    const c = tabEl('C')

    // 模拟真实场景里 xterm 的隐藏 textarea：pointerdown 之后浏览器把焦点从它上面移开，
    // 触发一次纯粹的元素级 blur（不冒泡，target 是这个元素，不是 window）。
    const fakeXtermTextarea = document.createElement('textarea')
    document.body.appendChild(fakeXtermTextarea)
    fakeXtermTextarea.focus()

    await act(async () => {
      fireEvent.pointerDown(c, { clientX: 300, clientY: 10, pointerId: 1 })
    })
    await act(async () => {
      fakeXtermTextarea.dispatchEvent(new FocusEvent('blur', { bubbles: false, cancelable: false }))
      await new Promise((r) => setTimeout(r, 0)) // 安全网内部用 setTimeout(fn, 0) 宏任务延后判断，见 dragSafetyNet.ts
    })
    await act(async () => {
      fireEvent.pointerMove(c, { clientX: 150, clientY: 10, pointerId: 1 }) // 跨过 4px 阈值
    })

    // 用户可见症状的直接反证：如果安全网被元素 blur 误触发，dragRef 已经被清空，
    // onTabPointerMove 开头 `if (!drag) return` 会让指示线永远不出现。
    expect(document.querySelector('.tabbar-drop-indicator')).toBeTruthy()

    await act(async () => {
      fireEvent.pointerUp(c, { clientX: 150, clientY: 10, pointerId: 1 })
    })

    // 断言真实 store 状态（不是 mock 调用记录）：排序确实落地了。
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['home', 'tab-a', 'tab-c', 'tab-b'])
    document.body.removeChild(fakeXtermTextarea)
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

// 拖到空槽窗格（本次修复的主要设计间隙）：目标窗格没有 ptyId（⌘D 新建后还没选定
// 会话，正在渲染 PanePicker）时，拖放应该"填充"取代它的位置而不是像既有行为那样
// 在旁边"插入"——插入会让总窗格数意外增加，撞上 320px 最小宽度的上限而被拒绝，这
// 正是诊断（a10a46f）暴露出的问题本身。
describe('TabBar — 拖已打开的标签落在空槽窗格上：填充而不是插入', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
  })
  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('落在空槽窗格上：整个标签取代空槽的位置，窗格总数不变，pane id/ptyId 原样不变', async () => {
    const EMPTY_A = {
      id: 'tab-a', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'a1', ptyId: 'p-a1', title: 'A1' }, { id: 'a2', title: '新窗格' }],
      activePaneId: 'a1',
    }
    useTabs.setState({ tabs: [HOME, EMPTY_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ a1: { left: 0, width: 300, height: 100 }, a2: { left: 300, width: 400, height: 100 } })
    const b = tabEl('B')

    await drag(b, { x: 500, y: 10 }, { x: 450, y: 50 }) // 落在 a2（空槽）矩形 [300,700) 内

    const t = useTabs.getState().tabs.find((x) => x.id === 'tab-a')!
    expect(t.panes).toHaveLength(2) // 数量不变——不是 movePanesToTab 会给出的 3
    expect(t.panes.map((p) => p.id)).toEqual(['a1', 'pane-b']) // a2 被取代掉，位置不变
    const moved = t.panes.find((p) => p.id === 'pane-b')!
    expect(moved.ptyId).toBe('pty-b') // ptyId 原样不变，不是重新 spawn 的
    expect(t.activePaneId).toBe('pane-b')
    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-b')).toBeUndefined() // 源标签整体移除
  })

  it('同一目标标签内：落在实体窗格上仍是插入（数量+1），落在空槽窗格上则是填充（数量不变）', async () => {
    const MIXED = {
      id: 'tab-a', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'a1', ptyId: 'p-a1', title: 'A1' }, { id: 'a2', title: '新窗格' }],
      activePaneId: 'a1',
    }
    useTabs.setState({ tabs: [HOME, MIXED, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ a1: { left: 0, width: 300, height: 100 }, a2: { left: 300, width: 400, height: 100 } })
    const b = tabEl('B')

    // 落在 a1（有 ptyId）的右半侧（中点 150）
    await drag(b, { x: 500, y: 10 }, { x: 250, y: 50 })

    const t = useTabs.getState().tabs.find((x) => x.id === 'tab-a')!
    expect(t.panes).toHaveLength(3) // 插入，数量真的增加了
    expect(t.panes.map((p) => p.id)).toEqual(['a1', 'pane-b', 'a2'])
  })

  it('宽度只够当前数量、不够 +1：填充仍然成功（按结果数判断，不误判成插入而拒绝）', async () => {
    // 复现诊断记录的场景（.superpowers/pane-fill-report.md）：目标标签已有 2 个窗格
    // （其一是空槽），原始测量值 700px 够 2 个窗格（usable=675>=640）但不够 3 个
    // （usable=664<960）——填充按"结果数=2（不变）"判断应该装得下；若被误当成
    // "插入"（当成 2+1=3）就会被错误拒绝，这正是本次要修的间隙。
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 700 })
    useLayout.setState({ panelCollapsed: true, panelWidth: 0 })
    const EMPTY_A = {
      id: 'tab-a', kind: 'term' as const, title: '2 个对话',
      panes: [{ id: 'a1', ptyId: 'p-a1', title: 'A1' }, { id: 'a2', title: '新窗格' }],
      activePaneId: 'a1',
    }
    useTabs.setState({ tabs: [HOME, EMPTY_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ a1: { left: 0, width: 300, height: 100 }, a2: { left: 300, width: 400, height: 100 } })
    const b = tabEl('B')

    await drag(b, { x: 500, y: 10 }, { x: 450, y: 50 }) // 落在 a2（空槽）

    const t = useTabs.getState().tabs.find((x) => x.id === 'tab-a')!
    expect(t.panes).toHaveLength(2) // 成功填充，不是被拒绝后原样保留的 2
    expect(t.panes.map((p) => p.id)).toEqual(['a1', 'pane-b'])
    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-b')).toBeUndefined()
  })
})

// 落点指示条按语义切换覆盖范围（Fix 2）：'fill' 覆盖整个窗格，'insert' 沿用既有的
// 半侧覆盖——container（.content）在 jsdom 里矩形恒为 0，因此指示条的内联 top/left
// 直接等于目标窗格矩形本身（未经任何偏移），据此断言 width 是否是"整窗格"还是"半
// 窗格"最直接。
describe('TabBar — 落点指示条按语义切换覆盖范围（整窗格 / 半窗格）', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
  })
  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  const EMPTY_A = {
    id: 'tab-a', kind: 'term' as const, title: '2 个对话',
    panes: [{ id: 'a1', ptyId: 'p-a1', title: 'A1' }, { id: 'a2', title: '新窗格' }],
    activePaneId: 'a1',
  }

  it('悬停空槽窗格：指示条覆盖整个窗格宽度（不是切半后的一半）', async () => {
    useTabs.setState({ tabs: [HOME, EMPTY_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ a1: { left: 0, width: 300, height: 100 }, a2: { left: 300, width: 400, height: 100 } })
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 500, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 450, clientY: 50, pointerId: 1 }) // 落在 a2 内
    })

    const indicator = document.querySelector('.pane-drop-indicator') as HTMLElement
    expect(indicator).toBeTruthy()
    expect(indicator.classList.contains('pane-drop-indicator-refused')).toBe(false)
    expect(indicator.style.width).toBe('400px') // a2 的整个宽度
    expect(indicator.style.left).toBe('300px')
  })

  it('悬停已有 ptyId 的窗格：指示条只覆盖半个窗格宽度', async () => {
    useTabs.setState({ tabs: [HOME, EMPTY_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ a1: { left: 0, width: 300, height: 100 }, a2: { left: 300, width: 400, height: 100 } })
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 500, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 250, clientY: 50, pointerId: 1 }) // 落在 a1 右半侧（中点 150）
    })

    const indicator = document.querySelector('.pane-drop-indicator') as HTMLElement
    expect(indicator).toBeTruthy()
    expect(indicator.style.width).toBe('150px') // a1 宽度 300 的一半
    expect(indicator.style.left).toBe('150px')
  })
})

// 拖拽过程中实时预览"松手会不会被拒绝"（Fix 3）：此前只有松手后一闪而过 2.2s 的
// 轻提示，用户反馈"完全没看到就消失了，以为功能坏了"。现在应该在悬停期间就能看出
// 拒绝状态，且理由持续显示直到光标移开或松手。
describe('TabBar — 会被拒绝的落点：拖拽过程中即可见，持续显示具体理由（Fix 3）', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('宽度不够：指示条带 refused 样式，理由携带具体差额（与 paneFitShortfall 对应），松手后仍不做任何事', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    useLayout.setState({ panelCollapsed: true, panelWidth: 0 })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 640 })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 640, height: 100 } })
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 630, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 500, clientY: 50, pointerId: 1 }) // pane-a 右半侧
    })

    const indicator = document.querySelector('.pane-drop-indicator') as HTMLElement
    expect(indicator).toBeTruthy()
    expect(indicator.classList.contains('pane-drop-indicator-refused')).toBe(true)
    expect(document.querySelector('.pane-drop-reason')?.textContent).toBe('窗口太窄，还差 25px')

    await act(async () => {
      fireEvent.pointerUp(b, { clientX: 500, clientY: 50, pointerId: 1 })
    })

    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeTruthy() // 没有被合并
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(1)
    expect(screen.getByText('窗口太窄，放不下新窗格')).toBeTruthy() // 松手后仍有既有的一次性轻提示复盘
  })

  it('数量超过上限：指示条带 refused 样式，理由是固定文案「最多支持 3 个窗格」', async () => {
    const TWO_A = { id: 'tab-a', kind: 'term' as const, title: '2 个对话', panes: [{ id: 'a1', ptyId: 'p-a1', title: 'A1' }, { id: 'a2', ptyId: 'p-a2', title: 'A2' }], activePaneId: 'a1' }
    const TWO_B = { id: 'tab-b', kind: 'term' as const, title: '2 个对话', panes: [{ id: 'b1', ptyId: 'p-b1', title: 'B1' }, { id: 'b2', ptyId: 'p-b2', title: 'B2' }], activePaneId: 'b1' }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
    useTabs.setState({ tabs: [HOME, TWO_A, TWO_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ a1: { left: 0, width: 300, height: 100 }, a2: { left: 300, width: 300, height: 100 } })
    const b = screen.getAllByText('2 个对话')[1].closest('.tab') as HTMLElement

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 900, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 100, clientY: 50, pointerId: 1 })
    })

    const indicator = document.querySelector('.pane-drop-indicator') as HTMLElement
    expect(indicator.classList.contains('pane-drop-indicator-refused')).toBe(true)
    expect(document.querySelector('.pane-drop-reason')?.textContent).toBe('最多支持 3 个窗格')
  })

  it('会成功的落点：不带 refused 样式，也没有理由文案（与拒绝态视觉上不含糊）', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 500, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 300, clientY: 50, pointerId: 1 })
    })

    const indicator = document.querySelector('.pane-drop-indicator') as HTMLElement
    expect(indicator.classList.contains('pane-drop-indicator-refused')).toBe(false)
    expect(document.querySelector('.pane-drop-reason')).toBeNull()
  })
})

// 回归测试（Fix 1）：dragSafetyNet.ts 曾经用 queueMicrotask 推迟 endDrag()，理由写的是
// "推迟到本次事件的捕获+目标+冒泡三个阶段全部跑完之后"——这个假设是错的：HTML 规范要求
// "每个监听器回调一返回、只要 JS 调用栈已清空，就做一次 microtask checkpoint"，不是
// "整个派发结束后才做一次"。安全网的 pointerup 监听器挂在 window 上、capture:true，是
// 捕获阶段最先跑的监听器之一，它一返回，checkpoint 立刻发生——排在 queueMicrotask 里的
// endDrag() 就在这个 checkpoint 里被调用，此时事件根本还没走到目标/冒泡阶段，组件自己
// 冒泡阶段的 onTabPointerUp 完全没机会先跑，导致这张"安全网"在每一次正常收尾的拖拽上
// 都抢先把 dragRef 清空，把合法的 drop 悄悄变成空操作。
//
// 这里不能直接用 `fireEvent.pointerUp(标签元素, ...)` 一次性触发（jsdom 的 dispatchEvent
// 实现不会在捕获阶段监听器返回后插入一次真实的 microtask checkpoint 再继续派发——这正是
// 这条回归当初能骗过整套已有测试套件的原因，见任务记录）。改为手动拆成两步，用一次
// `window.dispatchEvent` 只让安全网自己的 window 级监听器单独处理这次 pointerup（此时
// 事件的目标是 window 本身，不会传导到标签元素，组件自己的处理器完全不会被牵扯进来），
// 中间插入一次"只 flush 微任务、不 flush 宏任务"的 await（`await Promise.resolve()`），
// 然后才真正触发标签元素自己的 pointerup（组件冒泡阶段的处理器）——这精确还原了真实
// 浏览器里"捕获阶段监听器返回 → 立即一次 microtask checkpoint → 之后才轮到目标/冒泡
// 阶段"的时序，不依赖 jsdom 对 dispatchEvent 内部具体怎么串联捕获/冒泡与微任务队列。
describe('TabBar — 回归（Fix 1）：安全网的 pointerup 触发不应抢在组件自身的冒泡处理器之前结束拖拽', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
  })
  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('安全网先一步收到 pointerup 并判定 isDragActive=true，随后组件自己的 onTabPointerUp 才跑：drop 仍然正常完成（断言真实 store 状态，不是某个 mock 被调用过）', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 500, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 300, clientY: 50, pointerId: 1 }) // 落在 pane-a 右半侧
    })
    expect(useDnd.getState().target).not.toBeNull()

    // 第一步：只让安全网的 window 级监听器单独处理这次 pointerup，中间只 flush 微任务
    // ——旧的 queueMicrotask 写法会在这一步就抢跑，同步把 dragRef 清空。
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    // 第二步：组件自己冒泡阶段的处理器现在才跑——修复前，上一步已经把 dragRef 清空，
    // 这里会因为 `!drag || !drag.dragging` 直接 early-return，drop 根本不会发生。
    await act(async () => {
      fireEvent.pointerUp(b, { clientX: 300, clientY: 50, pointerId: 1 })
    })
    // flush 一次宏任务：即便安全网还留有尚未触发的 setTimeout（例如上一步已经通过组件
    // 自己的 endDrag() 摘掉了监听器/取消了计时器），这里确保不会有任何迟到的副作用。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // 断言真实 store 状态——drop 应当照常完成，与「拖已打开的标签进窗格区」那组用例
    // 里"落在右半侧"的断言完全一致。
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeUndefined()
    const t = useTabs.getState().tabs.find((t) => t.id === 'tab-a')!
    expect(t.panes.map((p) => p.id)).toEqual(['pane-a', 'pane-b'])
    expect(t.panes.find((p) => p.id === 'pane-b')!.ptyId).toBe('pty-b')
  })

  it('对照组：组件自己的处理器真的完全没跑时（元素在拖拽中途被移出 DOM），安全网仍然独立完成清理——证明这张网的本职功能没有被 Fix 1 破坏', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A, TAB_B], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const b = tabEl('B')

    await act(async () => {
      fireEvent.pointerDown(b, { clientX: 500, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(b, { clientX: 300, clientY: 50, pointerId: 1 })
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)
    expect(useDnd.getState().target).not.toBeNull()

    // 被拖的标签节点直接从 DOM 里摘掉——不触发 lostpointercapture、也不触发
    // pointerup/pointercancel（jsdom 不模拟隐式指针捕获释放），组件自己的
    // onTabPointerUp 因此彻底没有机会执行。只剩窗口级安全网这一条路可以兜底。
    b.remove()

    // 只 dispatch window 级事件，绝不触碰组件自己的处理器。
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 0)) // 见 dragSafetyNet.ts：现在是宏任务，不是微任务
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDnd.getState().target).toBeNull()
    // 没有完成任何动作——安全网和 lostpointercapture 一样只清理，不识别落点、不下判断。
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-b')).toBeTruthy()
  })
})

// 回归测试（Fix 2）：dragSafetyNet.ts 的调用方（TabBar.tsx/Sidebar.tsx/TabPanes.tsx）
// 挂新网前现在会先摘掉 netCleanupRef 里任何仍然挂着的旧网（见 onTabPointerDown 注释），
// 正常情况下不该再有两张网同时存活。但"万一"这道防线失守（例如未来某次重构不小心漏掉了
// 这一行），isDragActive() 本身也不能只看共享的 dragRef 是否非空——那样一张属于旧拖拽的
// 网，只要有任何一次新的拖拽正在进行（dragRef 非空，但指向的是新拖拽），就会把自己误判成
// "仍然存活"，从而有能力打断这次它根本不认识的新拖拽。这里直接在 dragSafetyNet.ts 的层面
// 单元测试这条"第二道保险"：isDragActive 必须比较 drag id，不能只判断非空——这正是三处
// 调用方现在构造 isDragActive 闭包的真实写法（`dragRef.current !== null && dragRef.current.id === dragId`），
// 不是假设性的写法。
describe('dragSafetyNet — 回归（Fix 2）：一张属于旧拖拽的网不能结束一次新的拖拽', () => {
  it('两张网都挂着（模拟旧网泄漏未被摘除）：旧网收到匹配自己 pointerId 的事件时，不会打断新网所属的、仍在进行中的拖拽；新网自己随后正常收尾时机也不受影响', async () => {
    // 与三处真实调用方完全相同的写法：一个共享的、可变的"当前拖拽"引用 + 每次开始
    // 拖拽时分配的单调递增 id，isDragActive 同时比较"非空"与"id 相同"两个条件。
    const dragRef: { current: { id: number } | null } = { current: null }
    let nextId = 0
    const endDragCalls: number[] = []

    function startDrag(pointerId: number) {
      const id = ++nextId
      dragRef.current = { id }
      const cleanup = attachDragSafetyNet(
        pointerId,
        () => dragRef.current !== null && dragRef.current.id === id,
        () => {
          endDragCalls.push(id)
          dragRef.current = null
        },
      )
      return { id, cleanup }
    }

    // "旧拖拽"：pointerId=1，网挂上之后没有被正常摘除（模拟泄漏）。
    const stale = startDrag(1)
    // "新拖拽"：pointerId=2，覆盖了共享的 dragRef——此刻 dragRef.current.id 是新拖拽的 id。
    const fresh = startDrag(2)
    expect(dragRef.current?.id).toBe(fresh.id)

    // 一次匹配旧拖拽 pointerId 的 pointerup（例如某个滞后到达的、与旧拖拽相关的事件）
    // 落在 window 上——只有旧网会响应（pointerId 过滤），新网不受影响。
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 0))

    // 新拖拽必须还活着：旧网的 isDragActive() 因为 id 不匹配而判定为 false，没有调用 endDrag()。
    expect(dragRef.current).not.toBeNull()
    expect(dragRef.current?.id).toBe(fresh.id)
    expect(endDragCalls).toEqual([])

    // 新拖拽随后正常收尾（自己的 pointerId=2），断言这次真正成功——不是"从未被打断"这种
    // 消极断言，是"完整走完一次生命周期，自己的 endDrag 被调用了恰好一次"。
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(dragRef.current).toBeNull()
    expect(endDragCalls).toEqual([fresh.id])

    stale.cleanup()
    fresh.cleanup()
  })
})
