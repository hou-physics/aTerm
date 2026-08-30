import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { outerPositionMock, outerSizeMock, setPositionMock, setSizeMock, currentMonitorMock } = vi.hoisted(() => ({
  outerPositionMock: vi.fn(async () => ({ x: 100, y: 50 })),
  outerSizeMock: vi.fn(async () => ({ width: 1200, height: 800 })),
  setPositionMock: vi.fn(async () => {}),
  setSizeMock: vi.fn(async () => {}),
  // workArea 特意给得很宽（3840，4K 显示器量级）：下面几条测试用的 panelWidth 都不大，
  // 宽到不会意外触发 planPanelExpand 的"左移"/"铺满工作区"分支——那两条分支已经在
  // panelWindow.test.ts 里独立覆盖过，这里只关心"resizeWindowForPanel 有没有被触发、
  // 传的数字对不对换算"，不想让分支切换掺进来干扰断言。
  currentMonitorMock: vi.fn(async () => ({
    workArea: { position: { x: 0, y: 0 }, size: { width: 3840, height: 2160 } },
  })),
}))

// store/layout.ts 展开/收起面板时会动态 import('@tauri-apps/api/window') 联动窗口位置/
// 尺寸（见该文件 resizeWindowForPanel）。真实 Tauri 窗口 API 在 jsdom 里不可用，换成桩
// 实现，好让下面几条测试能断言"窗口尺寸调整确实被触发/没有被触发"，不需要真的起一个
// Tauri 运行时。
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    outerPosition: outerPositionMock,
    outerSize: outerSizeMock,
    setPosition: setPositionMock,
    setSize: setSizeMock,
  }),
  currentMonitor: currentMonitorMock,
  PhysicalPosition: class { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y } },
  PhysicalSize: class { width: number; height: number; constructor(w: number, h: number) { this.width = w; this.height = h } },
}))

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

// 排空 resizeWindowForPanel 内部那串 await（动态 import → Promise.all(outerPosition,
// outerSize) → 可能的 currentMonitor → setPosition → setSize）。用真实的宏任务
// （setTimeout）而不是纯 Promise.resolve() 链，是为了不用去猜确切要串多少级微任务——
// 尤其是给"确认没有被触发"的用例用：既要等得够久让"万一真触发了"来得及跑完，又不能
// 用 vi.waitFor 那种"等到条件成立"的写法（这里要等的恰恰是"什么都没发生"）。
async function flushWindowResize() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
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

describe('layout store — wheelMultiplier', () => {
  it('首次启动、本地无偏好时默认 1.5', async () => {
    mockLocalStorage()
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().wheelMultiplier).toBe(1.5)
  })

  it('已持久化的值优先于默认值', async () => {
    mockLocalStorage({ 'aterm-wheel-multiplier': '2.5' })
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().wheelMultiplier).toBe(2.5)
  })

  it('setWheelMultiplier 钳制到 [1, 6] 并持久化', async () => {
    const ls = mockLocalStorage()
    const { useLayout } = await import('../store/layout')
    useLayout.getState().setWheelMultiplier(0.2)
    expect(useLayout.getState().wheelMultiplier).toBe(1)
    expect(ls.setItem).toHaveBeenCalledWith('aterm-wheel-multiplier', '1')
    useLayout.getState().setWheelMultiplier(99)
    expect(useLayout.getState().wheelMultiplier).toBe(6)
    useLayout.getState().setWheelMultiplier(2.5)
    expect(useLayout.getState().wheelMultiplier).toBe(2.5)
  })

  it('持久化的值是坏数据时退回默认值，不产生 NaN 倍率', async () => {
    // NaN 倍率会让 createWheelAmplifier 的 carry 变成 NaN，从此再也不补发任何事件——
    // 表现为"滚轮突然完全失去加速"，且没有任何报错。
    mockLocalStorage({ 'aterm-wheel-multiplier': 'abc' })
    const { useLayout } = await import('../store/layout')
    expect(useLayout.getState().wheelMultiplier).toBe(1.5)
  })
})

describe('layout store — 面板展开/收起联动窗口尺寸（用户诉求：窗口向右变宽，终端区不被挤）', () => {
  it('togglePanel 展开面板：读取窗口当前位置/尺寸与显示器 workArea，联动调用 setPosition/setSize', async () => {
    mockLocalStorage() // 初始 panelCollapsed=true（默认收起），这次 toggle 是"展开"
    const { useLayout } = await import('../store/layout')
    useLayout.getState().togglePanel()
    expect(useLayout.getState().panelCollapsed).toBe(false)
    await vi.waitFor(() => {
      expect(outerPositionMock).toHaveBeenCalled()
      expect(outerSizeMock).toHaveBeenCalled()
      expect(currentMonitorMock).toHaveBeenCalled()
      expect(setPositionMock).toHaveBeenCalled()
      expect(setSizeMock).toHaveBeenCalled()
    })
  })

  it('togglePanel 收起面板：同样联动调用 setPosition/setSize（窗口跟着变窄）', async () => {
    mockLocalStorage({ 'aterm-panel-collapsed': '0' }) // 初始展开，这次 toggle 是"收起"
    const { useLayout } = await import('../store/layout')
    useLayout.getState().togglePanel()
    expect(useLayout.getState().panelCollapsed).toBe(true)
    await vi.waitFor(() => {
      expect(setPositionMock).toHaveBeenCalled()
      expect(setSizeMock).toHaveBeenCalled()
    })
  })

  // 回归保护：⌘D 新建窗格时"窄窗口先收起面板腾出空间"那一档（App.tsx）改调用这个方法，
  // 就是因为它绝不能触发窗口尺寸联动——一旦联动，窗口会变窄但 .main 的终端内容区宽度
  // 纹丝不动，腾不出任何空间，⌘D 却以为自己已经腾出来了（详见 store/layout.ts 里
  // collapsePanelKeepingWindow 顶部注释）。这条测试如果把 collapsePanelKeepingWindow
  // 误实现成 togglePanel 的同义词，必须变红。
  it('collapsePanelKeepingWindow 只改状态，绝不触发窗口 setPosition/setSize', async () => {
    mockLocalStorage({ 'aterm-panel-collapsed': '0' }) // 初始展开
    const { useLayout } = await import('../store/layout')
    useLayout.getState().collapsePanelKeepingWindow()
    expect(useLayout.getState().panelCollapsed).toBe(true)
    await flushWindowResize()
    expect(outerPositionMock).not.toHaveBeenCalled()
    expect(setPositionMock).not.toHaveBeenCalled()
    expect(setSizeMock).not.toHaveBeenCalled()
  })

  it('collapsePanelKeepingWindow 也会持久化折叠状态（与 togglePanel 共用同一条持久化路径）', async () => {
    const ls = mockLocalStorage({ 'aterm-panel-collapsed': '0' })
    const { useLayout } = await import('../store/layout')
    useLayout.getState().collapsePanelKeepingWindow()
    expect(ls.setItem).toHaveBeenCalledWith('aterm-panel-collapsed', '1')
  })

  it('devicePixelRatio=2 时，panelWidth（CSS 像素）在传给窗口尺寸前会先换算成物理像素', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    mockLocalStorage({ 'aterm-panel-width': '400' }) // CSS 400px
    const { useLayout } = await import('../store/layout')
    useLayout.getState().togglePanel() // 初始收起 → 这次是展开
    await vi.waitFor(() => { expect(setSizeMock).toHaveBeenCalled() })
    // outerSize 桩返回 width:1200；delta 应为 400 * dpr(2) = 800 物理像素，而不是
    // 400——漏了 dpr 换算的话，这里会算出 1600 而不是期望的 2000，在 Retina
    // （devicePixelRatio=2）上面板会只长出该有宽度的一半，这正是本模块唯一"在 Retina
    // 上错、在普通屏上对"的失效模式。workArea 给得足够宽（3840），不会触发
    // planPanelExpand 的左移/铺满分支，新宽度就是 outerSize.width + delta。
    expect(setSizeMock).toHaveBeenCalledWith(expect.objectContaining({ width: 1200 + 800, height: 800 }))
    // x 不变（右边够，走"只变宽"分支）；y 不变（面板联动从不改变窗口的垂直位置）。
    expect(setPositionMock).toHaveBeenCalledWith(expect.objectContaining({ x: 100, y: 50 }))
  })
})
