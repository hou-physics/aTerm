import { create } from 'zustand'

type LayoutState = {
  sidebarCollapsed: boolean
  toggleSidebar(): void
  panelCollapsed: boolean
  togglePanel(): void
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

export const useLayout = create<LayoutState>((set, get) => ({
  sidebarCollapsed: readPersistedSidebarCollapsed(),
  toggleSidebar: () => {
    const next = !get().sidebarCollapsed
    persistSidebarCollapsed(next)
    set({ sidebarCollapsed: next })
  },
  panelCollapsed: readPersistedPanelCollapsed(),
  togglePanel: () => {
    const next = !get().panelCollapsed
    persistPanelCollapsed(next)
    set({ panelCollapsed: next })
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
