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
  it('首次启动、本地无任何持久化偏好时默认收起（panelCollapsed = true）', async () => {
    mockLocalStorage()
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().panelCollapsed).toBe(true)
  })

  it('已持久化的偏好优先于默认值：存过的 false（展开）不会被首次启动的默认收起覆盖', async () => {
    mockLocalStorage({ 'aterm-panel-collapsed': '0' })
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().panelCollapsed).toBe(false)
  })

  it('togglePanel 切换状态并持久化到 localStorage', async () => {
    const ls = mockLocalStorage()
    const { useLayout } = await import('../store/layout')
    // 无持久化偏好，初始即为新默认值 true（收起）
    useLayout.getState().togglePanel()
    expect(useLayout.getState().panelCollapsed).toBe(false)
    expect(ls.setItem).toHaveBeenCalledWith('aterm-panel-collapsed', '0')
    useLayout.getState().togglePanel()
    expect(useLayout.getState().panelCollapsed).toBe(true)
    expect(ls.setItem).toHaveBeenCalledWith('aterm-panel-collapsed', '1')
  })

  it('读取已持久化的折叠状态作为初始值', async () => {
    mockLocalStorage({ 'aterm-panel-collapsed': '1' })
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().panelCollapsed).toBe(true)
  })

  it('localStorage 读取抛异常时降级为默认值（面板收起）', async () => {
    mockThrowingLocalStorage()
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().panelCollapsed).toBe(true)
  })

  it('localStorage 写入抛异常时不影响内存中的状态切换', async () => {
    const ls = mockThrowingLocalStorage()
    const { useLayout } = await import('../store/layout')
    expect(() => useLayout.getState().togglePanel()).not.toThrow()
    expect(useLayout.getState().panelCollapsed).toBe(false)
    expect(ls.setItem).toHaveBeenCalled()
  })
})

describe('layout store — panelWidth', () => {
  it('默认宽度为 400', async () => {
    mockLocalStorage()
    const { useLayout, PANEL_WIDTH_DEFAULT } = await import('../store/layout')
    expect(PANEL_WIDTH_DEFAULT).toBe(400)
    expect(useLayout.getState().panelWidth).toBe(400)
  })

  it('setPanelWidth 只更新内存状态，不写 localStorage；commitPanelWidth 才持久化', async () => {
    const ls = mockLocalStorage()
    const { useLayout } = await import('../store/layout')
    useLayout.getState().setPanelWidth(500)
    expect(useLayout.getState().panelWidth).toBe(500)
    expect(ls.setItem).not.toHaveBeenCalledWith('aterm-panel-width', expect.anything())
    useLayout.getState().commitPanelWidth()
    expect(ls.setItem).toHaveBeenCalledWith('aterm-panel-width', '500')
  })

  it('setPanelWidth 在写入路径上钳制到 [280, 900]', async () => {
    mockLocalStorage()
    const { useLayout } = await import('../store/layout')
    useLayout.getState().setPanelWidth(50)
    expect(useLayout.getState().panelWidth).toBe(280)
    useLayout.getState().setPanelWidth(5000)
    expect(useLayout.getState().panelWidth).toBe(900)
  })

  it('读取已持久化的宽度作为初始值', async () => {
    mockLocalStorage({ 'aterm-panel-width': '620' })
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().panelWidth).toBe(620)
  })

  it('持久化读取路径同样钳制越界的陈旧值，不让其泄漏进状态', async () => {
    mockLocalStorage({ 'aterm-panel-width': '50000' })
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().panelWidth).toBe(900)
  })

  it('localStorage 读取抛异常时降级为默认宽度 400', async () => {
    mockThrowingLocalStorage()
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().panelWidth).toBe(400)
  })
})

describe('layout store — timelineHeight（时间线区域高度，两段式：拖拽期只更新内存，commit 才落盘）', () => {
  it('默认高度为 220', async () => {
    mockLocalStorage()
    const { useLayout, TIMELINE_HEIGHT_DEFAULT } = await import('../store/layout')
    expect(TIMELINE_HEIGHT_DEFAULT).toBe(220)
    expect(useLayout.getState().timelineHeight).toBe(220)
  })

  it('setTimelineHeight 只更新内存状态，不写 localStorage；commitTimelineHeight 才持久化', async () => {
    const ls = mockLocalStorage()
    const { useLayout } = await import('../store/layout')
    useLayout.getState().setTimelineHeight(300)
    expect(useLayout.getState().timelineHeight).toBe(300)
    expect(ls.setItem).not.toHaveBeenCalledWith('aterm-timeline-height', expect.anything())
    useLayout.getState().commitTimelineHeight()
    expect(ls.setItem).toHaveBeenCalledWith('aterm-timeline-height', '300')
  })

  it('setTimelineHeight 在写入路径上钳制到不低于 80（store 层不知道 60% 动态上限，那部分由组件层现算）', async () => {
    mockLocalStorage()
    const { useLayout } = await import('../store/layout')
    useLayout.getState().setTimelineHeight(10)
    expect(useLayout.getState().timelineHeight).toBe(80)
  })

  it('读取已持久化的高度作为初始值', async () => {
    mockLocalStorage({ 'aterm-timeline-height': '260' })
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().timelineHeight).toBe(260)
  })

  it('持久化读取路径同样钳制越界的陈旧值（低于 80），不让其泄漏进状态', async () => {
    mockLocalStorage({ 'aterm-timeline-height': '5' })
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().timelineHeight).toBe(80)
  })

  it('localStorage 读取抛异常时降级为默认高度 220', async () => {
    mockThrowingLocalStorage()
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().timelineHeight).toBe(220)
  })
})

describe('layout store — timelineCollapsed（时间线区域整体折叠，与单个日期分组的折叠彼此独立）', () => {
  it('默认展开（timelineCollapsed = false）', async () => {
    mockLocalStorage()
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().timelineCollapsed).toBe(false)
  })

  it('setTimelineCollapsed 只更新内存状态，不写 localStorage；commitTimelineCollapsed 才持久化', async () => {
    const ls = mockLocalStorage()
    const { useLayout } = await import('../store/layout')
    useLayout.getState().setTimelineCollapsed(true)
    expect(useLayout.getState().timelineCollapsed).toBe(true)
    expect(ls.setItem).not.toHaveBeenCalledWith('aterm-timeline-collapsed', expect.anything())
    useLayout.getState().commitTimelineCollapsed()
    expect(ls.setItem).toHaveBeenCalledWith('aterm-timeline-collapsed', '1')
  })

  it('读取已持久化的折叠状态作为初始值', async () => {
    mockLocalStorage({ 'aterm-timeline-collapsed': '1' })
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().timelineCollapsed).toBe(true)
  })

  it('localStorage 读取抛异常时降级为默认值（展开）', async () => {
    mockThrowingLocalStorage()
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().timelineCollapsed).toBe(false)
  })
})
