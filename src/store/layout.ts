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
}

const SIDEBAR_KEY = 'aterm-sidebar-collapsed'
const PANEL_KEY = 'aterm-panel-collapsed'
const FONT_SIZE_KEY = 'aterm-font-size'
const DEFAULT_FONT_SIZE = 13
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32
const PANEL_WIDTH_KEY = 'aterm-panel-width'
export const PANEL_WIDTH_DEFAULT = 400
export const PANEL_WIDTH_MIN = 280
export const PANEL_WIDTH_MAX = 900

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
    return localStorage.getItem(PANEL_KEY) === '1'
  } catch { /* localStorage 不可用（如隐私模式），忽略 */ }
  return false
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
}))
