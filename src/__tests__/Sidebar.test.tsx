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
import { useDragGhost } from '../store/dragGhost'
import { useHint } from '../store/hint'
import { useLayout } from '../store/layout'
import { useTabs } from '../store/tabs'

const HOME = { id: 'home', kind: 'home' as const, title: '主页', panes: [] }
const TAB_A = { id: 'tab-a', kind: 'term' as const, title: 'A', panes: [{ id: 'pane-a', ptyId: 'pty-a', title: 'A' }], activePaneId: 'pane-a' }

beforeEach(() => {
  useTabs.setState({ tabs: [HOME], activeId: 'home' })
  useHint.setState({ message: null })
  useDnd.setState({ target: null })
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

// 与 TabBar.test.tsx 同一组回归断言（见该文件"只在真正开始拖拽后才 preventDefault"
// 一节的注释）：验证 Sidebar.tsx 这一处拖拽源同样只在跨过阈值后才 preventDefault。
describe('Sidebar — 只在真正开始拖拽后才 preventDefault（不在 pointerdown 上）', () => {
  it('pointerdown 与低于 4px 阈值的 pointermove 都不 preventDefault；跨过阈值后才 preventDefault', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    let downResult = false
    let subThresholdResult = false
    let crossResult = true
    await act(async () => {
      downResult = fireEvent.pointerDown(item, { clientX: 10, clientY: 10, pointerId: 1, cancelable: true })
    })
    await act(async () => {
      subThresholdResult = fireEvent.pointerMove(item, { clientX: 12, clientY: 10, pointerId: 1, cancelable: true }) // 2px
    })
    await act(async () => {
      crossResult = fireEvent.pointerMove(item, { clientX: 300, clientY: 50, pointerId: 1, cancelable: true })
    })
    await act(async () => {
      fireEvent.pointerUp(item, { clientX: 300, clientY: 50, pointerId: 1 })
    })

    expect(downResult).toBe(true)
    expect(subThresholdResult).toBe(true)
    expect(crossResult).toBe(false)
  })
})

// 与 TabBar.test.tsx 同一组断言，验证 Sidebar.tsx 这一处拖拽源接线正确；
// store 本身的行为在 dragGhost.test.ts。
describe('Sidebar — 拖拽期间屏蔽文本选择并显示跟随光标的拖拽指示', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
  })
  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('跨过 4px 阈值后：body 加上屏蔽选择的 class，指示显示被拖会话的标题', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await act(async () => {
      fireEvent.pointerDown(item, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(item, { clientX: 300, clientY: 50, pointerId: 1 })
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(true)
    expect(document.querySelector('.drag-ghost')?.textContent).toBe('修复登录')

    await act(async () => {
      fireEvent.pointerUp(item, { clientX: 300, clientY: 50, pointerId: 1 })
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
  })

  it('pointercancel 同样移除 body class 与指示', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await act(async () => {
      fireEvent.pointerDown(item, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(item, { clientX: 300, clientY: 50, pointerId: 1 })
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)

    await act(async () => {
      fireEvent.pointerCancel(item, { clientX: 300, clientY: 50, pointerId: 1 })
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
  })

  it('小幅移动（低于 4px 阈值）的普通点击：既不显示指示也不设置 class', async () => {
    await renderApp() // activeId 默认 home
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await act(async () => {
      fireEvent.pointerDown(item, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(item, { clientX: 11, clientY: 10, pointerId: 1 }) // 1px，低于阈值
      fireEvent.pointerUp(item, { clientX: 11, clientY: 10, pointerId: 1 })
      fireEvent.click(item)
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
    expect(useTabs.getState().tabs).toHaveLength(2) // 普通点击行为不变，仍正常打开会话
  })
})

// 指针捕获丢失时的清理（review 发现：三个拖拽源此前只在 pointerup/pointercancel 上
// 清理，元素若在拖拽中途被移出 DOM，浏览器会静默释放指针捕获、只发 lostpointercapture
// 而不补发 pointerup）。这里格外贴合真实场景——「最近会话」列表在 window focus 时
// refresh()，可能把正被拖拽的那一条会话挤出前 12 条，使其 DOM 节点消失；侧边栏本身
// 也会在 ⌘B 折叠时整个卸载（见 App.tsx 的 `{!sidebarCollapsed && <Sidebar/>}`），
// 后一种场景直接用于验证下面"组件卸载"那个用例。
describe('Sidebar — 指针捕获丢失或组件卸载时同样清理拖拽状态（不会永久卡住 body class）', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 2000 })
  })
  afterEach(async () => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    document.body.classList.remove('dragging-grab')
    // 其中一条用例会把它设为 true，避免泄漏给后面的用例；包一层 act() 避免"更新未包裹"
    // 的噪音（这一刻仍挂载着上一条用例的 App，reset 会触发它重渲染）。
    await act(async () => { useLayout.setState({ sidebarCollapsed: false }) })
  })

  it('lostpointercapture：清理 body class、拖拽指示与 useDnd 的落点状态', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await act(async () => {
      fireEvent.pointerDown(item, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(item, { clientX: 300, clientY: 50, pointerId: 1 }) // 跨过阈值，真正开始拖拽
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)
    expect(document.body.classList.contains('dragging-grab')).toBe(true)
    expect(useDnd.getState().target).not.toBeNull()

    await act(async () => {
      fireEvent(item, new Event('lostpointercapture', { bubbles: true, cancelable: false }))
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(document.querySelector('.drag-ghost')).toBeNull()
    expect(useDnd.getState().target).toBeNull()
    // 没有完成任何动作——lostpointercapture 只清理，不识别落点。
    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-a')!.panes).toHaveLength(1)
  })

  it('侧边栏在拖拽中途被整个卸载（例如 ⌘B 折叠）：同样清理 body class 与拖拽状态', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await act(async () => {
      fireEvent.pointerDown(item, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(item, { clientX: 300, clientY: 50, pointerId: 1 })
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)

    // 折叠侧边栏：App.tsx 里 `{!sidebarCollapsed && <aside><Sidebar/></aside>}`，
    // Sidebar 连同拖拽中的会话项整个从 DOM 卸载，浏览器不会补发 pointerup。
    await act(async () => { useLayout.setState({ sidebarCollapsed: true }) })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDnd.getState().target).toBeNull()
  })

  it('清理函数被调用两次是无害的空操作（lostpointercapture 之后又收到一次 pointerup/pointercancel）', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await act(async () => {
      fireEvent.pointerDown(item, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(item, { clientX: 300, clientY: 50, pointerId: 1 })
    })

    await act(async () => {
      fireEvent(item, new Event('lostpointercapture', { bubbles: true, cancelable: false }))
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(false)

    expect(() => {
      fireEvent.pointerCancel(item, { clientX: 300, clientY: 50, pointerId: 1 })
    }).not.toThrow()

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDnd.getState().target).toBeNull()
    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-a')!.panes).toHaveLength(1)
  })
})

// 窗口级兜底（本次新增，src/dragSafetyNet.ts）：上面的 lostpointercapture 测试只能
// 证明"收到这个事件名字后处理器本身做了正确的事"——jsdom 完全没实现
// setPointerCapture/releasePointerCapture/隐式释放，无法验证"真实 WKWebView 里，被
// 挤出 top-12 而移出 DOM 的会话项，是否真的会把 lostpointercapture 送到 React"这一层
// （这正是 .superpowers/drag-cleanup-report.md 的"关切点"，Sidebar 是三个拖拽源里
// 这个风险最贴近真实触发场景的一个）。这里验证的是比这更差的一种情形：会话项被移出
// DOM 之后*完全不触发*任何指针事件，只有原生 pointerup/blur 落在 window 上——窗口级
// 监听不依赖被拖元素是否还在 DOM 里、也不经过 React 的合成事件委托，应当仍能兜住。
describe('Sidebar — 窗口级兜底：被拖会话项在拖拽中途从 DOM 消失、且未收到任何指针事件时仍能清理', () => {
  it('会话项被移出 DOM（不触发任何指针事件）后，window 上的原生 pointerup 仍能清理', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await act(async () => {
      fireEvent.pointerDown(item, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(item, { clientX: 300, clientY: 50, pointerId: 1 }) // 跨过阈值，真正开始拖拽
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)
    expect(document.body.classList.contains('dragging-grab')).toBe(true)
    expect(useDnd.getState().target).not.toBeNull()

    // 直接把被拖的会话项从 DOM 里摘掉，模拟「最近会话」列表在 window focus 时
    // refresh() 把它挤出 top-12 的真实场景——不经过 lostpointercapture，只留下"节点
    // 已经不在文档树里"这一个既成事实，专门验证不依赖它的窗口级兜底。
    item.remove()

    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }))
      await Promise.resolve() // 兜底的 endDrag() 被 queueMicrotask 推迟，见 dragSafetyNet.ts 顶部注释
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDnd.getState().target).toBeNull()
    // 没有完成任何动作——窗口级兜底和 lostpointercapture 一样只清理，不识别落点/新建窗格。
    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-a')!.panes).toHaveLength(1)
  })

  it('会话项被移出 DOM 后，window 上的原生 blur（例如另开一个窗口触发 focus）同样能清理', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 400, height: 100 } })
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await act(async () => {
      fireEvent.pointerDown(item, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(item, { clientX: 300, clientY: 50, pointerId: 1 })
    })
    expect(document.body.classList.contains('dragging-no-select')).toBe(true)

    item.remove()

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await Promise.resolve()
    })

    expect(document.body.classList.contains('dragging-no-select')).toBe(false)
    expect(document.body.classList.contains('dragging-grab')).toBe(false)
    expect(useDnd.getState().target).toBeNull()
  })

  it('endDrag() 会摘掉窗口级兜底监听器：清理之后不会残留全局 pointerup/pointercancel/blur 监听', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    await renderApp()
    // 故意不伪造任何窗格矩形——jsdom 默认的 getBoundingClientRect() 恒为全 0，光标
    // 因此落不进任何窗格范围，target 恒为 null，pointerup 走到 endDrag() 但不完成
    // 任何新建窗格动作，专注验证监听器本身的挂/摘。
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    await act(async () => {
      fireEvent.pointerDown(item, { clientX: 10, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(item, { clientX: 300, clientY: 50, pointerId: 1 })
      fireEvent.pointerUp(item, { clientX: 300, clientY: 50, pointerId: 1 }) // 正常路径收尾，走 endDrag()
    })

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
    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-a')!.panes).toHaveLength(1)
  })
})

// 拖放路径也使用修正后的可用宽度（review 发现：⌘D 的拒绝阈值已经用 usablePaneAreaWidth
// 扣掉了容器内边距/分隔条/窗格边框开销，但 Sidebar.tsx 的拖入落点仍在用原始
// clientWidth）。数字与 TabBar.test.tsx/App.test.tsx 的同名边界用例完全对应：原始
// 测量值 640px，2 个窗格所需的开销是 12+9+4=25px，修正后可用宽度只有 615px，装不下
// 2×320=640px。
describe('Sidebar — 拖放创建窗格也按修正后的可用宽度判定，与 ⌘D 不会互相矛盾', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('原始测量值 640px：⌘D 与「最近会话」拖入对同一个 nextCount=2 的窗口几何给出同一个"拒绝"结论', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    useLayout.setState({ panelCollapsed: true, panelWidth: 0 })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 640 })
    const { getByText } = await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 640, height: 100 } })

    // 先用 ⌘D 在 tab-a 自己身上新建第二个窗格（nextCount=2），钉住这个几何下 ⌘D
    // 本身确实拒绝。
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true, cancelable: true }))
    })
    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-a')!.panes).toHaveLength(1)
    expect(getByText('窗口太窄，放不下新窗格')).toBeTruthy()
    await act(async () => { useHint.setState({ message: null }) }) // 清掉这次提示，不干扰下面对同一条提示的断言

    // 从「最近会话」拖入同样是 nextCount=2，理应给出同一个结论——修正前这里会因为用
    // 原始 clientWidth 而误判"刚好装得下"，与 ⌘D 的判断相矛盾。
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement
    await drag(item, { x: 10, y: 10 }, { x: 500, y: 50 }) // 落在 pane-a 矩形 [0,640) 的右半侧

    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-a')!.panes).toHaveLength(1) // 没有被误判成装得下而新建
    expect(getByText('窗口太窄，放不下新窗格')).toBeTruthy()
  })

  it('原始测量值 665px（640+25px 开销）：⌘D 与「最近会话」拖入对同一个几何给出同一个"装得下"结论', async () => {
    useTabs.setState({ tabs: [HOME, TAB_A], activeId: 'tab-a' })
    useLayout.setState({ panelCollapsed: true, panelWidth: 0 })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 665 })
    await renderApp()
    mockPaneRects({ 'pane-a': { left: 0, width: 665, height: 100 } })
    const item = screen.getByText('修复登录').closest('.side-item') as HTMLElement

    await drag(item, { x: 10, y: 10 }, { x: 655, y: 50 }) // 落在 pane-a 矩形右半侧

    expect(useTabs.getState().tabs.find((x) => x.id === 'tab-a')!.panes).toHaveLength(2) // 新建成功
  })
})
