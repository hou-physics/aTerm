import { create } from 'zustand'
import { planPanelCollapse, planPanelExpand, WINDOW_MIN_WIDTH_CSS } from '../panelWindow'

type LayoutState = {
  sidebarCollapsed: boolean
  toggleSidebar(): void
  panelCollapsed: boolean
  togglePanel(): void
  collapsePanelKeepingWindow(): void
  fontSize: number
  setFontSize(n: number): void
  adjustFontSize(delta: number): void
  resetFontSize(): void
  panelWidth: number
  setPanelWidth(n: number): void
  commitPanelWidth(): void
  timelineHeight: number
  setTimelineHeight(n: number): void
  commitTimelineHeight(): void
  timelineCollapsed: boolean
  setTimelineCollapsed(v: boolean): void
  commitTimelineCollapsed(): void
  wheelMultiplier: number
  setWheelMultiplier(n: number): void
}

const SIDEBAR_KEY = 'aterm-sidebar-collapsed'
const PANEL_KEY = 'aterm-panel-collapsed'
// 首次启动（本地尚无持久化偏好）时面板默认收起，不抢占注意力；一旦用户手动收起/展开过，
// 这条默认值就再也不会生效——见 readPersistedPanelCollapsed 里 `v !== null` 的显式区分，
// 已保存的偏好（哪怕存的就是"展开"）永远优先于这个默认值。
const PANEL_COLLAPSED_DEFAULT = true
const FONT_SIZE_KEY = 'aterm-font-size'
const DEFAULT_FONT_SIZE = 13
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32
const PANEL_WIDTH_KEY = 'aterm-panel-width'
export const PANEL_WIDTH_DEFAULT = 400
export const PANEL_WIDTH_MIN = 280
export const PANEL_WIDTH_MAX = 900
const TIMELINE_HEIGHT_KEY = 'aterm-timeline-height'
const TIMELINE_COLLAPSED_KEY = 'aterm-timeline-collapsed'
export const TIMELINE_HEIGHT_DEFAULT = 220
// 时间线区没有一个有意义的静态上限——它由"面板内容区高度的 60%"这个动态量决定
// （容器随窗口/面板尺寸变化）。与 panelWidth 的 windowCap 同一思路：store 层的读取/写入
// 只钳制这个静态下限，真正的 60% 动态上限交给拖拽发生地 ConversationPanel.tsx 现算
// （不装 resize 监听器，只在拖拽/双击这些主动改动的时刻现算），持久化读取路径同样只
// 校验下限，不校验那个它压根不知道的动态上限。
export const TIMELINE_HEIGHT_MIN = 80

function readPersistedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch { /* localStorage 不可用（如隐私模式），忽略 */ }
  return false
}

function persistSidebarCollapsed(v: boolean) {
  try { localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0') } catch { /* 忽略持久化失败 */ }
}

function readPersistedPanelCollapsed(): boolean {
  try {
    // 用 `v !== null` 显式区分"从未存过"与"存过且值为假"（对应 '0'，展开）：
    // 只有前者才允许套用下面的 PANEL_COLLAPSED_DEFAULT，与 readPersistedFontSize /
    // readPersistedPanelWidth 的既有读取模式保持一致，不能像本函数改动前那样直接
    // `=== '1'`——那样会把"没存过"和"存过 false"混为一谈，新默认值就会错误地覆盖
    // 用户已经保存的"展开"偏好。
    const v = localStorage.getItem(PANEL_KEY)
    if (v !== null) return v === '1'
  } catch { /* localStorage 不可用（如隐私模式），忽略 */ }
  return PANEL_COLLAPSED_DEFAULT
}

function persistPanelCollapsed(v: boolean) {
  try { localStorage.setItem(PANEL_KEY, v ? '1' : '0') } catch { /* 忽略持久化失败 */ }
}

function clampFontSize(n: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(n)))
}

function readPersistedFontSize(): number {
  try {
    const v = localStorage.getItem(FONT_SIZE_KEY)
    if (v !== null) {
      const n = Number(v)
      if (Number.isFinite(n)) return clampFontSize(n)
    }
  } catch { /* localStorage 不可用（如隐私模式），忽略 */ }
  return DEFAULT_FONT_SIZE
}

function persistFontSize(n: number) {
  try { localStorage.setItem(FONT_SIZE_KEY, String(n)) } catch { /* 忽略持久化失败 */ }
}

function clampPanelWidth(n: number): number {
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(n)))
}

function readPersistedPanelWidth(): number {
  try {
    const v = localStorage.getItem(PANEL_WIDTH_KEY)
    if (v !== null) {
      const n = Number(v)
      if (Number.isFinite(n)) return clampPanelWidth(n)
    }
  } catch { /* localStorage 不可用（如隐私模式），忽略 */ }
  return PANEL_WIDTH_DEFAULT
}

function persistPanelWidth(n: number) {
  try { localStorage.setItem(PANEL_WIDTH_KEY, String(n)) } catch { /* 忽略持久化失败 */ }
}

function clampTimelineHeight(n: number): number {
  return Math.max(TIMELINE_HEIGHT_MIN, Math.round(n))
}

function readPersistedTimelineHeight(): number {
  try {
    const v = localStorage.getItem(TIMELINE_HEIGHT_KEY)
    if (v !== null) {
      const n = Number(v)
      if (Number.isFinite(n)) return clampTimelineHeight(n)
    }
  } catch { /* localStorage 不可用（如隐私模式），忽略 */ }
  return TIMELINE_HEIGHT_DEFAULT
}

function persistTimelineHeight(n: number) {
  try { localStorage.setItem(TIMELINE_HEIGHT_KEY, String(n)) } catch { /* 忽略持久化失败 */ }
}

function readPersistedTimelineCollapsed(): boolean {
  try {
    const v = localStorage.getItem(TIMELINE_COLLAPSED_KEY)
    if (v !== null) return v === '1'
  } catch { /* localStorage 不可用（如隐私模式），忽略 */ }
  return false
}

function persistTimelineCollapsed(v: boolean) {
  try { localStorage.setItem(TIMELINE_COLLAPSED_KEY, v ? '1' : '0') } catch { /* 忽略持久化失败 */ }
}

const WHEEL_MULTIPLIER_KEY = 'aterm-wheel-multiplier'
// Claude TUI 自己接管鼠标上报时，每个真实滚轮事件的放大倍数。原为 3，用户反馈过快。
// 滑块 UI 留到 V3.2（届时会有设置入口）；值先进 store 是为了那时的滑块是纯 UI 增量。
export const WHEEL_MULTIPLIER_DEFAULT = 1.5
const WHEEL_MULTIPLIER_MIN = 1
const WHEEL_MULTIPLIER_MAX = 6

function clampWheelMultiplier(n: number): number {
  if (!Number.isFinite(n)) return WHEEL_MULTIPLIER_DEFAULT
  return Math.min(WHEEL_MULTIPLIER_MAX, Math.max(WHEEL_MULTIPLIER_MIN, n))
}

function readPersistedWheelMultiplier(): number {
  try {
    const v = localStorage.getItem(WHEEL_MULTIPLIER_KEY)
    if (v !== null) return clampWheelMultiplier(Number(v))
  } catch { /* localStorage 不可用（如隐私模式），忽略 */ }
  return WHEEL_MULTIPLIER_DEFAULT
}

// 展开/收起对话面板时，让窗口自身宽度联动变化，而不是像现状那样挤窄终端区——用户反馈：
// .main 是 flex:1、.conv-panel-dock 是 flex:none，面板一展开就把 .main 的可用宽度吃掉
// 一块，体感上是"面板向左展开"；真正要的是"窗口向右变宽，终端区宽度不变"。这里只负责
// 物理像素换算与 Tauri 窗口 API 的调用序列，"新窗口该在哪、多宽"这个决策交给
// panelWindow.ts 的纯函数（那部分因为要连真实 Tauri API，没法直接单测；数学关系已经在
// panelWindow.test.ts 里独立验证过）。
//
// 整条链走动态 import('@tauri-apps/api/window')，末尾由 resizeWindowForPanel 统一 catch
// （见其顶部注释）：非 Tauri 环境（vitest/jsdom、浏览器预览）里 getCurrentWindow() 会因为
// 读不到 window.__TAURI_INTERNALS__ 而同步抛错，不 catch 会变成未处理的 promise
// rejection，污染所有渲染真实组件树的测试文件——App.tsx 里文件拖放那段（onDragDropEvent）
// 已经踩过这个坑，这里照抄同一个写法。
//
// expanding=true 表示"刚展开"（窗口变宽）；expanding=false 表示"刚收起"（窗口变窄）。
// panelWidthCss 是调用时刻的 store.panelWidth（CSS 像素）。这里只做真正的一次调整，
// 不管排队——排队由下面 resizeWindowForPanel 的 pendingPanelResize 负责。
async function runPanelResize(expanding: boolean, panelWidthCss: number) {
  const { getCurrentWindow, currentMonitor, PhysicalPosition, PhysicalSize } = await import('@tauri-apps/api/window')
  const win = getCurrentWindow()
  // panelWidth 存的是 CSS 像素，而 outerPosition/outerSize/Monitor.workArea 全部是
  // 物理像素——这一步换算漏了的话，Retina（devicePixelRatio=2）上面板只会长出该有
  // 宽度的一半，非 Retina 屏上又恰好正确，是最难查的那类缺陷（同 fileDrop.ts
  // toLogicalPoint 顶部注释的坑，方向相反）。
  const dpr = window.devicePixelRatio || 1
  const delta = panelWidthCss * dpr
  const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()])
  if (expanding) {
    const monitor = await currentMonitor()
    if (!monitor) return // 拿不到当前显示器信息（极端环境）：放弃联动，保留窗口原状
    const plan = planPanelExpand(
      { x: pos.x, width: size.width },
      { x: monitor.workArea.position.x, width: monitor.workArea.size.width },
      delta,
    )
    await win.setPosition(new PhysicalPosition(plan.x, pos.y))
    await win.setSize(new PhysicalSize(plan.width, size.height))
  } else {
    const plan = planPanelCollapse({ x: pos.x, width: size.width }, delta, WINDOW_MIN_WIDTH_CSS * dpr)
    await win.setPosition(new PhysicalPosition(plan.x, pos.y))
    await win.setSize(new PhysicalSize(plan.width, size.height))
  }
}

// 排队队列：见 resizeWindowForPanel 顶部注释——快速连续触发时，后一次调整必须等前一次
// 完全落地之后才开始读取窗口几何，这个模块级变量就是那条队列本身。
let pendingPanelResize: Promise<void> = Promise.resolve()

// 用户快速连续触发面板开关（手抖连按 ⌘J，或点了按钮又马上按快捷键）时，如果每次调用都
// 各自起一条独立、互不等待的调整链，后一条链的 outerPosition()/outerSize() 可能在前一条
// 链的 setPosition()/setSize() 落地之前就已经读到了窗口的旧坐标/旧尺寸——基于这份过期
// 几何算出的目标位置和宽度自然是错的，表现为"窗口莫名其妙变成了奇怪的宽度"，且只能手动
// 拖回来。这正是这整个模块想避免的那类问题，只是触发条件从"单次开合"变成了"连击"。
//
// 用一个模块级的 pendingPanelResize 把所有调整串成一条队列：新的调整接在上一条 *完全*
// 落地（包括它自己的 setPosition/setSize 都 await 完）之后才开始，而不是在排队的这一刻
// 就先把窗口几何读好——那样等于没有串行化，读到的仍然是"发起时"而不是"轮到自己执行时"
// 的窗口状态。`.catch(...)` 直接挂在重新赋值给 pendingPanelResize 的这个 promise
// 上（而不是只挂在 runPanelResize 内部）：这样任何一次调整失败（非 Tauri 环境、或真实
// Tauri 调用出错）都不会让 pendingPanelResize 变成一个永久 rejected 的 promise——后面
// 排队的调整仍然能正常执行，不会被前一次的失败卡死整条队列。
//
// 这里必须吞掉 rejection（不能让它逃逸）：vitest/jsdom 下 getCurrentWindow() 会同步抛错
// （见上面 runPanelResize 顶部注释），不吞会变成未处理的 promise rejection，污染所有渲染
// 真实组件树的测试文件。但吞掉不等于装作没发生——真实 Tauri 环境里这条链也会失败，起因
// 往往是 capabilities 权限没给全（例如本模块曾经缺过 core:window:allow-set-size /
// allow-set-position，导致这整套面板变宽/变窄的功能在打包版里完全不生效，而 748 个测试
// 全绿、构建也干净，因为 jsdom 里根本不会触达真实的权限系统）。所以吞归吞，必须把错误
// console.warn 出来：下次再出现"功能没生效但测试全绿"，打开 devtools 就能立刻看到线索，
// 而不必再像这次一样去翻 acl-manifests.json 逐条核对权限。
function resizeWindowForPanel(expanding: boolean, panelWidthCss: number) {
  pendingPanelResize = pendingPanelResize
    .then(() => runPanelResize(expanding, panelWidthCss))
    .catch((e) => { console.warn('[panel] 窗口尺寸联动失败', e) })
}

export const useLayout = create<LayoutState>((set, get) => ({
  sidebarCollapsed: readPersistedSidebarCollapsed(),
  toggleSidebar: () => {
    const next = !get().sidebarCollapsed
    persistSidebarCollapsed(next)
    set({ sidebarCollapsed: next })
  },
  panelCollapsed: readPersistedPanelCollapsed(),
  // togglePanel 有三个调用方（App.tsx 的 ⌘J、TabBar.tsx 的面板按钮、以及将来面板自己的
  // 顶栏按钮），且这套"窗口跟着联动变宽/变窄"的副作用特意放在这里、而不是留给每个调用方
  // 自己去触发：放在调用方就要求每一处都记得同时做"切状态"和"调窗口尺寸"两件事，漏一处
  // 就是"某个入口开面板、窗口却纹丝不动"这种难查的诡异 bug；放在 store 里能保证所有入口
  // 行为一致。
  togglePanel: () => {
    const next = !get().panelCollapsed
    persistPanelCollapsed(next)
    const panelWidthCss = get().panelWidth
    set({ panelCollapsed: next })
    resizeWindowForPanel(!next, panelWidthCss) // next=true(收起)→expanding=false；next=false(展开)→expanding=true
  },
  // ⌘D 新建窗格时"窄窗口先收起对话面板腾出宽度"那一档（App.tsx，设计文档 §8）专用，
  // TabBar.tsx/Sidebar.tsx 的拖放落点判断走的是同一套 decidePaneFit/previewPaneDrop
  // 'collapse-panel' 决策，也用这个方法。那几处依赖的是收起面板前的旧语义——"收起面板 →
  // .conv-panel-dock 让出空间 → .main 的 flex:1 终端内容区跟着变宽，腾出的宽度装得下
  // 新窗格/新落点"。togglePanel 现在的语义已经变成"收起面板 → 窗口自己变窄、终端区宽度
  // 不变"，如果这几处改调 togglePanel，窗口会缩小但终端内容区宽度纹丝不动，什么空间都
  // 没腾出来，调用方却以为自己已经腾出来了——因此单独留一个"只改状态、绝不触碰窗口尺寸"
  // 的收起方法，专供这类"要靠收起面板换宽度"的场景；日常的面板开关（⌘J/顶栏按钮）继续
  // 走 togglePanel。
  collapsePanelKeepingWindow: () => {
    persistPanelCollapsed(true)
    set({ panelCollapsed: true })
  },
  fontSize: readPersistedFontSize(),
  setFontSize: (n) => {
    const clamped = clampFontSize(n)
    persistFontSize(clamped)
    set({ fontSize: clamped })
  },
  adjustFontSize: (delta) => {
    get().setFontSize(get().fontSize + delta)
  },
  resetFontSize: () => {
    get().setFontSize(DEFAULT_FONT_SIZE)
  },
  panelWidth: readPersistedPanelWidth(),
  // 只更新内存状态，不写 localStorage——拖拽期间 pointermove 高频触发，
  // 每次都落盘会既拖慢交互又刷爆磁盘 I/O。落盘统一交给 commitPanelWidth。
  setPanelWidth: (n) => {
    set({ panelWidth: clampPanelWidth(n) })
  },
  commitPanelWidth: () => {
    persistPanelWidth(get().panelWidth)
  },
  timelineHeight: readPersistedTimelineHeight(),
  // 与 setPanelWidth 同一套两段式：拖拽期间（pointermove）只更新内存，commit 才落盘，
  // 由 ConversationPanel.tsx 的分隔条在 pointerup 时调用。
  setTimelineHeight: (n) => {
    set({ timelineHeight: clampTimelineHeight(n) })
  },
  commitTimelineHeight: () => {
    persistTimelineHeight(get().timelineHeight)
  },
  timelineCollapsed: readPersistedTimelineCollapsed(),
  // 同样是"内存先行、commit 落盘"的两段式，供双击分隔条时紧接着成对调用
  // （镜像 onResizeDoubleClick 里 setPanelWidth 紧跟 commitPanelWidth 的写法）。
  setTimelineCollapsed: (v) => {
    set({ timelineCollapsed: v })
  },
  commitTimelineCollapsed: () => {
    persistTimelineCollapsed(get().timelineCollapsed)
  },
  wheelMultiplier: readPersistedWheelMultiplier(),
  setWheelMultiplier: (n) => {
    const v = clampWheelMultiplier(n)
    try { localStorage.setItem(WHEEL_MULTIPLIER_KEY, String(v)) } catch { /* 忽略持久化失败 */ }
    set({ wheelMultiplier: v })
  },
}))
