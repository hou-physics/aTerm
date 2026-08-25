import { create } from 'zustand'

export type ThemeMode = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'

type ThemeState = {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode(m: ThemeMode): void
  cycleMode(): void
}

const STORAGE_KEY = 'aterm-theme'
const CYCLE: ThemeMode[] = ['system', 'dark', 'light']

function readPersistedMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'dark' || v === 'light' || v === 'system') return v
  } catch { /* localStorage 不可用（如隐私模式），忽略 */ }
  return 'system'
}

function persistMode(m: ThemeMode) {
  try { localStorage.setItem(STORAGE_KEY, m) } catch { /* 忽略持久化失败 */ }
}

function systemPrefersDark(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return true // jsdom 等无 matchMedia 的环境下默认深色
  }
}

function resolveMode(mode: ThemeMode): ResolvedTheme {
  if (mode === 'dark') return 'dark'
  if (mode === 'light') return 'light'
  return systemPrefersDark() ? 'dark' : 'light'
}

function applyToDocument(resolved: ResolvedTheme) {
  try { document.documentElement.setAttribute('data-theme', resolved) } catch { /* 非 DOM 环境，忽略 */ }
}

const initialMode = readPersistedMode()
const initialResolved = resolveMode(initialMode)
applyToDocument(initialResolved)

export const useTheme = create<ThemeState>((set, get) => ({
  mode: initialMode,
  resolved: initialResolved,
  setMode: (m) => {
    persistMode(m)
    const resolved = resolveMode(m)
    applyToDocument(resolved)
    set({ mode: m, resolved })
  },
  cycleMode: () => {
    const idx = CYCLE.indexOf(get().mode)
    const next = CYCLE[(idx + 1) % CYCLE.length]
    get().setMode(next)
  },
}))

// 系统主题变化时，若处于 'system' 模式则重新解析
try {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (useTheme.getState().mode === 'system') {
        const resolved: ResolvedTheme = systemPrefersDark() ? 'dark' : 'light'
        applyToDocument(resolved)
        useTheme.setState({ resolved })
      }
    }
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
    } else if (typeof (mql as unknown as { addListener?: (cb: () => void) => void }).addListener === 'function') {
      (mql as unknown as { addListener: (cb: () => void) => void }).addListener(onChange)
    }
  }
} catch { /* 忽略监听失败 */ }
