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
import { useTabs } from '../store/tabs'

const HOME = { id: 'home', kind: 'home' as const, title: '主页', panes: [] }

beforeEach(() => {
  useTabs.setState({ tabs: [HOME], activeId: 'home' })
  useHint.setState({ message: null })
  useDnd.setState({ target: null, tabBarIndex: null })
  useDragGhost.setState({ visible: false, label: '', x: 0, y: 0 })
  document.body.classList.remove('dragging-no-select')
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.classList.remove('dragging-no-select')
})

async function renderApp() {
  const utils = render(<App />)
  await act(async () => { await Promise.resolve() })
  return utils
}

// 通用矩形伪造：与 TabBar.test.tsx/Sidebar.test.tsx 的 mockPaneRects 不同，这里要区分
// 四类元素——标签栏本身（.tabbar）、标签栏里每个标签（.tab[data-tab-id]）、某标签的
// 窗格行（.term-wrap[data-tab-id]）、窗格自身（[data-pane-id]）。.tab 和 .term-wrap
// 可能带有同一个 data-tab-id 值，却指代完全不同的两块区域，必须先按元素本身分类，
// 不能只按属性值查表。
function mockRects(rects: Record<string, { left: number; top?: number; width: number; height?: number }>) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    let key: string | undefined
    if (this.classList.contains('tabbar')) key = 'tabbar'
    else if (this.classList.contains('tab') && this.hasAttribute('data-tab-id')) key = `tabstrip:${this.getAttribute('data-tab-id')}`
    else if (this.classList.contains('term-wrap')) key = `row:${this.getAttribute('data-tab-id')}`
    else if (this.hasAttribute('data-pane-id')) key = this.getAttribute('data-pane-id') ?? undefined
    const r = key ? rects[key] : undefined
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

function titlebarFor(title: string): HTMLElement {
  return screen.getByText(title).closest('.pane-titlebar') as HTMLElement
}

describe('TabPanes — 拖出窗格标题栏成为独立标签（设计文档 §5-C，"拖出去"方向）', () => {
  const TAB = {
    id: 'tab-a', kind: 'term' as const, title: '2 个对话',
    panes: [{ id: 'p1', ptyId: 'pty-1', title: 'P1' }, { id: 'p2', ptyId: 'pty-2', title: 'P2' }],
    activePaneId: 'p1',
  }

  it('松手时光标仍在源标签自己的窗格行范围内：视为没有真的拖出去，不产生任何变化', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()
    mockRects({ 'row:tab-a': { left: 0, top: 40, width: 600, height: 300 }, tabbar: { left: 0, top: 0, width: 800, height: 30 } })

    await drag(titlebarFor('P2'), { x: 300, y: 60 }, { x: 200, y: 100 }) // 仍落在 row 矩形内

    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(2) // 没有被拆出
    expect(useTabs.getState().tabs).toHaveLength(2) // 没有新标签产生（home + tab-a）
  })

  it('松手时光标在窗格行之外、也不在标签栏上：拆出成独立标签，追加到标签栏末尾', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()
    mockRects({ 'row:tab-a': { left: 0, top: 40, width: 600, height: 300 }, tabbar: { left: 0, top: 0, width: 800, height: 30 } })

    await drag(titlebarFor('P2'), { x: 300, y: 60 }, { x: 9000, y: 9000 }) // 远在两者之外

    const { tabs, activeId } = useTabs.getState()
    expect(tabs.map((t) => t.id)).toEqual(['home', 'tab-a', tabs[2].id]) // 追加在末尾
    const newTab = tabs[2]
    expect(newTab.panes.map((p) => p.id)).toEqual(['p2'])
    expect(newTab.panes[0].ptyId).toBe('pty-2') // ptyId 原样不变，未重新 spawn
    expect(activeId).toBe(newTab.id) // 新标签成为激活标签
    expect(tabs.find((t) => t.id === 'tab-a')!.panes.map((p) => p.id)).toEqual(['p1'])
  })

  it('松手时光标落在标签栏上：拆出的新标签插在光标对应的位置，而不是末尾', async () => {
    const TAB_OTHER = { id: 'tab-other', kind: 'term' as const, title: 'Other', panes: [{ id: 'po', ptyId: 'pty-o', title: 'Other' }], activePaneId: 'po' }
    useTabs.setState({ tabs: [HOME, TAB, TAB_OTHER], activeId: 'tab-a' })
    await renderApp()
    mockRects({
      'row:tab-a': { left: 0, top: 40, width: 600, height: 300 },
      tabbar: { left: 0, top: 0, width: 800, height: 30 },
      'tabstrip:home': { left: 0, top: 0, width: 50, height: 26 },
      'tabstrip:tab-a': { left: 50, top: 0, width: 100, height: 26 },
      'tabstrip:tab-other': { left: 150, top: 0, width: 100, height: 26 },
    })

    // x=150 恰好在 tab-a 中点(100)之后、tab-other 中点(200)之前——应插在 tab-a 与
    // tab-other 之间（下标 2），而不是追加到最末尾（下标 3）。
    await drag(titlebarFor('P2'), { x: 300, y: 60 }, { x: 150, y: 10 })

    const { tabs } = useTabs.getState()
    expect(tabs.map((t) => t.id)).toEqual(['home', 'tab-a', tabs[2].id, 'tab-other'])
  })
})

// 与 TabBar.test.tsx/Sidebar.test.tsx 同一组回归断言（见 TabBar.test.tsx"只在真正开始
// 拖拽后才 preventDefault"一节注释）：这里格外关键——右键菜单（PaneContextMenu）就
// 渲染在这个标题栏的 DOM 子树里，点击菜单项时 pointerdown 会先冒泡到这里，上一轮在
// 这里无条件 preventDefault 正是"移出为独立标签"点不动这个回归的根源。
describe('TabPanes — 只在真正开始拖拽后才 preventDefault（不在 pointerdown 上）', () => {
  const TAB = {
    id: 'tab-a', kind: 'term' as const, title: '2 个对话',
    panes: [{ id: 'p1', ptyId: 'pty-1', title: 'P1' }, { id: 'p2', ptyId: 'pty-2', title: 'P2' }],
    activePaneId: 'p1',
  }

  it('pointerdown 与低于 4px 阈值的 pointermove 都不 preventDefault；跨过阈值后才 preventDefault', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()
    const titlebar = titlebarFor('P2')

    let downResult = false
    let subThresholdResult = false
    let crossResult = true
    await act(async () => {
      downResult = fireEvent.pointerDown(titlebar, { clientX: 300, clientY: 60, pointerId: 1, cancelable: true })
    })
    await act(async () => {
      subThresholdResult = fireEvent.pointerMove(titlebar, { clientX: 301, clientY: 61, pointerId: 1, cancelable: true }) // ~1.4px
    })
    await act(async () => {
      crossResult = fireEvent.pointerMove(titlebar, { clientX: 300, clientY: 200, pointerId: 1, cancelable: true })
    })
    await act(async () => {
      fireEvent.pointerUp(titlebar, { clientX: 300, clientY: 200, pointerId: 1 })
    })

    expect(downResult).toBe(true)
    expect(subThresholdResult).toBe(true)
    expect(crossResult).toBe(false)
  })
})

// 与 TabBar.test.tsx/Sidebar.test.tsx 同一组断言，验证窗格标题栏这一处拖拽源接线
// 正确；store 本身的行为在 dragGhost.test.ts。
describe('TabPanes — 拖拽窗格标题栏期间屏蔽文本选择并显示跟随光标的拖拽指示', () => {
  const TAB = {
    id: 'tab-a', kind: 'term' as const, title: '2 个对话',
    panes: [{ id: 'p1', ptyId: 'pty-1', title: 'P1' }, { id: 'p2', ptyId: 'pty-2', title: 'P2' }],
    activePaneId: 'p1',
  }

  it('跨过 4px 阈值后：body 加上屏蔽选择的 class，指示显示被拖窗格的标题', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()
    const titlebar = titlebarFor('P2')

    await act(async () => {
      fireEvent.pointerDown(titlebar, { clientX: 300, clientY: 60, pointerId: 1 })
      fireEvent.pointerMove(titlebar, { clientX: 300, clientY: 200, pointerId: 1 }) // 超过 4px 阈值
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(true)
    expect(document.querySelector('.drag-ghost')?.textContent).toBe('P2')

    await act(async () => {
      fireEvent.pointerUp(titlebar, { clientX: 300, clientY: 200, pointerId: 1 })
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
  })

  it('pointercancel 同样移除 body class 与指示', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()
    const titlebar = titlebarFor('P2')

    await act(async () => {
      fireEvent.pointerDown(titlebar, { clientX: 300, clientY: 60, pointerId: 1 })
      fireEvent.pointerMove(titlebar, { clientX: 300, clientY: 200, pointerId: 1 })
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)

    await act(async () => {
      fireEvent.pointerCancel(titlebar, { clientX: 300, clientY: 200, pointerId: 1 })
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
  })

  it('小幅移动（低于 4px 阈值）：既不显示指示也不设置 class，窗格聚焦行为不变', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()
    const titlebar = titlebarFor('P2')

    await act(async () => {
      fireEvent.pointerDown(titlebar, { clientX: 300, clientY: 60, pointerId: 1 })
      fireEvent.pointerMove(titlebar, { clientX: 301, clientY: 60, pointerId: 1 }) // 1px，低于阈值
      fireEvent.pointerUp(titlebar, { clientX: 301, clientY: 60, pointerId: 1 })
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.activePaneId).toBe('p2') // 点击仍正常聚焦该窗格（既有捕获阶段逻辑）
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(2) // 没有被拆出
  })
})

describe('TabPanes — 右键窗格标题栏打开上下文菜单（设计文档 §5-C）', () => {
  const TAB = {
    id: 'tab-a', kind: 'term' as const, title: '2 个对话',
    panes: [{ id: 'p1', ptyId: 'pty-1', title: 'P1' }, { id: 'p2', ptyId: 'pty-2', title: 'P2' }],
    activePaneId: 'p1',
  }

  it('右键打开菜单，列出「移出为独立标签」与「关闭窗格」两项', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()

    await act(async () => { fireEvent.contextMenu(titlebarFor('P2'), { clientX: 100, clientY: 100 }) })

    expect(screen.getByText('移出为独立标签')).toBeTruthy()
    expect(screen.getByText('关闭窗格')).toBeTruthy()
  })

  it('点击「移出为独立标签」：拆出成独立标签（无落点，追加到末尾），菜单随即关闭', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()

    await act(async () => { fireEvent.contextMenu(titlebarFor('P2'), { clientX: 100, clientY: 100 }) })
    await act(async () => { fireEvent.click(screen.getByText('移出为独立标签')) })

    expect(screen.queryByText('移出为独立标签')).toBeNull() // 菜单已关闭
    const { tabs } = useTabs.getState()
    expect(tabs).toHaveLength(3)
    expect(tabs[2].panes.map((p) => p.id)).toEqual(['p2'])
  })

  it('点击「关闭窗格」：走既有的 closePane 路径（无存活 PTY 时直接移除，不弹确认）', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()

    await act(async () => { fireEvent.contextMenu(titlebarFor('P2'), { clientX: 100, clientY: 100 }) })
    await act(async () => { fireEvent.click(screen.getByText('关闭窗格')) })

    await vi.waitFor(() => {
      expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes.map((p) => p.id)).toEqual(['p1'])
    })
  })

  it('点击菜单外部：关闭菜单，不触发任何动作', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()

    await act(async () => { fireEvent.contextMenu(titlebarFor('P2'), { clientX: 100, clientY: 100 }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) // 外部点击监听器延迟一个 tick 才挂载
    await act(async () => { fireEvent.pointerDown(document.body) })

    expect(screen.queryByText('移出为独立标签')).toBeNull()
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(2) // 没有任何变化
  })

  it('按 Escape：关闭菜单', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()

    await act(async () => { fireEvent.contextMenu(titlebarFor('P2'), { clientX: 100, clientY: 100 }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })

    expect(screen.queryByText('移出为独立标签')).toBeNull()
  })

  it('窗口失焦（blur）：关闭菜单', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()

    await act(async () => { fireEvent.contextMenu(titlebarFor('P2'), { clientX: 100, clientY: 100 }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { window.dispatchEvent(new Event('blur')) })

    expect(screen.queryByText('移出为独立标签')).toBeNull()
  })
})

// 指针捕获丢失时的清理（review 发现：三个拖拽源此前只在 pointerup/pointercancel 上
// 清理，元素若在拖拽中途被移出 DOM，浏览器会静默释放指针捕获、只发 lostpointercapture
// 而不补发 pointerup）。PaneTitleBar 是三个拖拽源里唯一"每个手柄都是独立组件实例"的
// 一个（TabBar.tsx/Sidebar.tsx 的手柄都是父组件内联 map 出的 DOM 节点），下面"组件
// 卸载"这条用例因此格外贴合真实场景：这个标题栏所在的标签被（例如别的地方触发的）
// 关闭操作移除时，PaneTitleBar 会随之整棵卸载，浏览器同样不会补发 pointerup。
describe('TabPanes — 指针捕获丢失或组件卸载时同样清理拖拽状态（不会永久卡住 body class）', () => {
  const TAB = {
    id: 'tab-a', kind: 'term' as const, title: '2 个对话',
    panes: [{ id: 'p1', ptyId: 'pty-1', title: 'P1' }, { id: 'p2', ptyId: 'pty-2', title: 'P2' }],
    activePaneId: 'p1',
  }

  it('lostpointercapture：清理 body class、拖拽指示与 useDnd 的 tabBarIndex', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()
    const titlebar = titlebarFor('P2')

    await act(async () => {
      fireEvent.pointerDown(titlebar, { clientX: 300, clientY: 60, pointerId: 1 })
      fireEvent.pointerMove(titlebar, { clientX: 300, clientY: 200, pointerId: 1 }) // 跨过阈值，真正开始拖拽
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)

    await act(async () => {
      fireEvent(titlebar, new Event('lostpointercapture', { bubbles: true, cancelable: false }))
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
    expect(useDnd.getState().tabBarIndex).toBeNull()
    // 没有完成任何动作——lostpointercapture 只清理，不识别落点/拆出新标签。
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(2)
    expect(useTabs.getState().tabs).toHaveLength(2) // home + tab-a，没有多出新标签
  })

  it('窗格标题栏所在的标签在拖拽中途被卸载：同样清理 body class 与拖拽状态', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()
    const titlebar = titlebarFor('P2')

    await act(async () => {
      fireEvent.pointerDown(titlebar, { clientX: 300, clientY: 60, pointerId: 1 })
      fireEvent.pointerMove(titlebar, { clientX: 300, clientY: 200, pointerId: 1 })
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)

    // 模拟"标签在拖拽中途被别的路径关闭"：整个 tab-a（连同正在拖拽的 P2 标题栏）从
    // tabs 数组里消失，TabPanes/PaneTitleBar 随之整棵卸载。
    await act(async () => { useTabs.setState({ tabs: [HOME], activeId: 'home' }) })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(useDnd.getState().tabBarIndex).toBeNull()
  })

  it('清理函数被调用两次是无害的空操作（lostpointercapture 之后又收到一次 pointerup/pointercancel）', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()
    const titlebar = titlebarFor('P2')

    await act(async () => {
      fireEvent.pointerDown(titlebar, { clientX: 300, clientY: 60, pointerId: 1 })
      fireEvent.pointerMove(titlebar, { clientX: 300, clientY: 200, pointerId: 1 })
    })

    await act(async () => {
      fireEvent(titlebar, new Event('lostpointercapture', { bubbles: true, cancelable: false }))
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(false)

    expect(() => {
      fireEvent.pointerCancel(titlebar, { clientX: 300, clientY: 200, pointerId: 1 })
    }).not.toThrow()

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(useDnd.getState().tabBarIndex).toBeNull()
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(2) // 没有意外拆出新标签
  })
})

// 窗口级兜底（本次新增，src/dragSafetyNet.ts）：上面的 lostpointercapture 测试只能
// 证明"收到这个事件名字后处理器本身做了正确的事"——jsdom 完全没实现
// setPointerCapture/releasePointerCapture/隐式释放，无法验证"真实 WKWebView 里，被
// 移出 DOM 的节点是否真的会把 lostpointercapture 送到 React"这一层。这里验证的是比
// 这更差的一种情形：标题栏元素被移出 DOM 之后*完全不触发*任何指针事件，只有原生
// pointerup/blur 落在 window 上——窗口级监听不依赖被拖元素是否还在 DOM 里、也不经过
// React 的合成事件委托，应当仍能兜住。
describe('TabPanes — 窗口级兜底：被拖标题栏在拖拽中途从 DOM 消失、且未收到任何指针事件时仍能清理', () => {
  const TAB = {
    id: 'tab-a', kind: 'term' as const, title: '2 个对话',
    panes: [{ id: 'p1', ptyId: 'pty-1', title: 'P1' }, { id: 'p2', ptyId: 'pty-2', title: 'P2' }],
    activePaneId: 'p1',
  }

  it('标题栏被移出 DOM（不触发任何指针事件）后，window 上的原生 pointerup 仍能清理', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()
    const titlebar = titlebarFor('P2')

    await act(async () => {
      fireEvent.pointerDown(titlebar, { clientX: 300, clientY: 60, pointerId: 1 })
      fireEvent.pointerMove(titlebar, { clientX: 300, clientY: 200, pointerId: 1 }) // 跨过阈值，真正开始拖拽
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)
    expect(document.body.classList.contains('dragging-grab')).toBe(true)

    // 直接把被拖的标题栏节点从 DOM 里摘掉——不经过 lostpointercapture，只留下"节点
    // 已经不在文档树里"这一个既成事实，专门验证不依赖它的窗口级兜底。
    titlebar.remove()

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }))
      await Promise.resolve() // 兜底的 endDrag() 被 queueMicrotask 推迟，见 dragSafetyNet.ts 顶部注释
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDnd.getState().tabBarIndex).toBeNull()
    // 没有完成任何动作——窗口级兜底和 lostpointercapture 一样只清理，不识别落点/拆出新标签。
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(2)
    expect(useTabs.getState().tabs).toHaveLength(2)
  })

  it('标题栏被移出 DOM 后，window 上的原生 blur（例如 ⌘Tab 切到另一个 App）同样能清理', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()
    const titlebar = titlebarFor('P2')

    await act(async () => {
      fireEvent.pointerDown(titlebar, { clientX: 300, clientY: 60, pointerId: 1 })
      fireEvent.pointerMove(titlebar, { clientX: 300, clientY: 200, pointerId: 1 })
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)

    titlebar.remove()

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await Promise.resolve()
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDnd.getState().tabBarIndex).toBeNull()
  })

  it('endDrag() 会摘掉窗口级兜底监听器：清理之后不会残留全局 pointerup/pointercancel/blur 监听', async () => {
    useTabs.setState({ tabs: [HOME, TAB], activeId: 'tab-a' })
    await renderApp()
    // 让松手点始终落在源标签自己的窗格行范围内——走既有的"没有真的拖出去"分支，
    // 不产生拆出新标签的动作，专注验证监听器本身的挂/摘。
    mockRects({ 'row:tab-a': { left: 0, top: 40, width: 600, height: 300 } })
    const titlebar = titlebarFor('P2')
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    await drag(titlebar, { x: 300, y: 60 }, { x: 200, y: 100 }) // 正常路径收尾，走 endDrag()

    const removedCaptureTypes = removeSpy.mock.calls
      .filter(([, , opts]) => typeof opts === 'object' && opts !== null && opts.capture === true)
      .map(([type]) => type)
    expect(removedCaptureTypes).toEqual(expect.arrayContaining(['pointerup', 'pointercancel', 'blur']))

    // 监听器确实摘掉了：清理之后再有一次原生 pointerup 落在 window 上，不会再产生任何
    // 可观察效果（body class 早已是干净状态，不会被重新弄脏，也不会误触发任何动作）。
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(useTabs.getState().tabs.find((t) => t.id === 'tab-a')!.panes).toHaveLength(2)
    expect(useTabs.getState().tabs).toHaveLength(2)
  })
})
