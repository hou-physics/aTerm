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

function mockThrowingLocalStorage() {
  const ls = {
    getItem: vi.fn(() => { throw new Error('localStorage 不可用') }),
    setItem: vi.fn(() => { throw new Error('localStorage 不可用') }),
    removeItem: vi.fn(),
    clear: vi.fn(),
  }
  vi.stubGlobal('localStorage', ls)
  return ls
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('layout store — panelCollapsed', () => {
  it('默认展开（panelCollapsed = false）', async () => {
    mockLocalStorage()
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().panelCollapsed).toBe(false)
  })

  it('togglePanel 切换状态并持久化到 localStorage', async () => {
    const ls = mockLocalStorage()
    const { useLayout } = await import('../store/layout')
    useLayout.getState().togglePanel()
    expect(useLayout.getState().panelCollapsed).toBe(true)
    expect(ls.setItem).toHaveBeenCalledWith('aterm-panel-collapsed', '1')
    useLayout.getState().togglePanel()
    expect(useLayout.getState().panelCollapsed).toBe(false)
    expect(ls.setItem).toHaveBeenCalledWith('aterm-panel-collapsed', '0')
  })

  it('读取已持久化的折叠状态作为初始值', async () => {
    mockLocalStorage({ 'aterm-panel-collapsed': '1' })
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().panelCollapsed).toBe(true)
  })

  it('localStorage 读取抛异常时降级为默认值（面板可见）', async () => {
    mockThrowingLocalStorage()
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().panelCollapsed).toBe(false)
  })

  it('localStorage 写入抛异常时不影响内存中的状态切换', async () => {
    const ls = mockThrowingLocalStorage()
    const { useLayout } = await import('../store/layout')
    expect(() => useLayout.getState().togglePanel()).not.toThrow()
    expect(useLayout.getState().panelCollapsed).toBe(true)
    expect(ls.setItem).toHaveBeenCalled()
  })
})
