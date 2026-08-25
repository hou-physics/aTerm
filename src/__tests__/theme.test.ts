import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function mockLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  const ls = {
    getItem: vi.fn((k: string) => (store.has(k) ? store.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => { store.set(k, v) }),
    removeItem: vi.fn((k: string) => { store.delete(k) }),
    clear: vi.fn(() => store.clear()),
  }
  vi.stubGlobal('localStorage', ls)
  return ls
}

function mockMatchMedia(matches: boolean) {
  type Listener = (e: { matches: boolean }) => void
  const listeners: Listener[] = []
  const mql = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: vi.fn((_event: string, cb: Listener) => listeners.push(cb)),
    removeEventListener: vi.fn(),
  }
  vi.stubGlobal('matchMedia', vi.fn(() => mql))
  return { mql, fire: (m: boolean) => { mql.matches = m; listeners.forEach((cb) => cb({ matches: m })) } }
}

beforeEach(() => {
  vi.resetModules()
  document.documentElement.removeAttribute('data-theme')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('theme store', () => {
  it('默认 mode 为 system，通过 matchMedia 解析 resolved', async () => {
    mockLocalStorage()
    mockMatchMedia(true)
    const { useTheme } = await import('../store/theme')
    expect(useTheme.getState().mode).toBe('system')
    expect(useTheme.getState().resolved).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('setMode(light) 持久化到 localStorage 并设置 data-theme', async () => {
    const ls = mockLocalStorage()
    mockMatchMedia(true)
    const { useTheme } = await import('../store/theme')
    useTheme.getState().setMode('light')
    expect(ls.setItem).toHaveBeenCalledWith('aterm-theme', 'light')
    expect(useTheme.getState().resolved).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('cycleMode 循环顺序 system → dark → light → system', async () => {
    mockLocalStorage()
    mockMatchMedia(true)
    const { useTheme } = await import('../store/theme')
    expect(useTheme.getState().mode).toBe('system')
    useTheme.getState().cycleMode()
    expect(useTheme.getState().mode).toBe('dark')
    useTheme.getState().cycleMode()
    expect(useTheme.getState().mode).toBe('light')
    useTheme.getState().cycleMode()
    expect(useTheme.getState().mode).toBe('system')
  })

  it('system 模式下响应 matchMedia change 事件重新解析', async () => {
    mockLocalStorage()
    const { fire } = mockMatchMedia(true)
    const { useTheme } = await import('../store/theme')
    expect(useTheme.getState().resolved).toBe('dark')
    fire(false)
    expect(useTheme.getState().resolved).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('读取已持久化的 mode 作为初始值', async () => {
    mockLocalStorage({ 'aterm-theme': 'light' })
    mockMatchMedia(true)
    const { useTheme } = await import('../store/theme')
    expect(useTheme.getState().mode).toBe('light')
    expect(useTheme.getState().resolved).toBe('light')
  })
})
