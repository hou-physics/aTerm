import { create } from 'zustand'

type LayoutState = {
  sidebarCollapsed: boolean
  toggleSidebar(): void
  fontSize: number
  setFontSize(n: number): void
  adjustFontSize(delta: number): void
  resetFontSize(): void
}

const SIDEBAR_KEY = 'aterm-sidebar-collapsed'
const FONT_SIZE_KEY = 'aterm-font-size'
const DEFAULT_FONT_SIZE = 13
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32

function readPersistedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch { /* localStorage 不可用（如隐私模式），忽略 */ }
  return false
}

function persistSidebarCollapsed(v: boolean) {
  try { localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0') } catch { /* 忽略持久化失败 */ }
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

export const useLayout = create<LayoutState>((set, get) => ({
  sidebarCollapsed: readPersistedSidebarCollapsed(),
  toggleSidebar: () => {
    const next = !get().sidebarCollapsed
    persistSidebarCollapsed(next)
    set({ sidebarCollapsed: next })
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
}))
