import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, listenMock, invokeMock } = vi.hoisted(() => {
  const handlers: Record<string, (event: unknown) => void> = {}
  const listenMock = vi.fn(async (event: string, handler: (event: unknown) => void) => {
    handlers[event] = handler
    return () => {}
  })
  const invokeMock = vi.fn(async () => undefined)
  return { handlers, listenMock, invokeMock }
})

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { handleOpenSettingsMenuItem, handleThemeModeMenuEvent, menuEventsReady } from '../menuEvents'
import { useSettings } from '../store/settings'
import { useTheme } from '../store/theme'

beforeEach(() => {
  // 初始值特意设为 false（与下面测试要断言的目标值 true 不同）——如果这里不重置、
  // 或者初始值恰好也是 true，"触发后变 true"这条断言就会在实现完全不生效时也通过。
  useSettings.setState({ open: false })
  invokeMock.mockClear()
})

describe('menuEvents：收到 menu-open-settings 后打开设置浮层', () => {
  it('模块加载时已向 menu-open-settings 注册监听（在任何用户交互之前）', async () => {
    // 与 closeRequest.test.ts 同一理由：注册发生在模块顶层导入时，早于这里的任何
    // 断言——直接比对 handlers 里挂的是不是 handleOpenSettingsMenuItem 本身，而不是
    // 断言 listenMock 的调用历史（模块只导入一次，调用历史在多用例间不可靠）。
    await menuEventsReady
    expect(handlers['menu-open-settings']).toBe(handleOpenSettingsMenuItem)
  })

  it('handleOpenSettingsMenuItem 打开设置浮层', async () => {
    await menuEventsReady
    expect(useSettings.getState().open).toBe(false) // 初始值，与下面断言的目标值不同

    handleOpenSettingsMenuItem()

    expect(useSettings.getState().open).toBe(true)
  })
})

describe('menuEvents：菜单栏「主题」三项与 store 双向同步', () => {
  it('模块加载时已向 menu-theme-mode 注册监听（在任何用户交互之前）', async () => {
    await menuEventsReady
    expect(handlers['menu-theme-mode']).toBe(handleThemeModeMenuEvent)
  })

  it('handleThemeModeMenuEvent 收到合法 payload 时调用 setMode', async () => {
    await menuEventsReady
    useTheme.setState({ mode: 'default' }) // 初始值，与下面断言的目标值 'dual' 不同
    expect(useTheme.getState().mode).toBe('default')

    handleThemeModeMenuEvent({ payload: 'dual' } as never)

    expect(useTheme.getState().mode).toBe('dual')
  })

  it('handleThemeModeMenuEvent 收到非法 payload 时忽略，不透传给 setMode', async () => {
    await menuEventsReady
    useTheme.setState({ mode: 'default' }) // 初始值，若被误透传会变成非法字符串本身

    handleThemeModeMenuEvent({ payload: 'not-a-real-mode' } as never)

    // 未发生变化：如果实现直接把 payload 透传给 setMode 而不做校验，mode 会变成
    // 'not-a-real-mode'（store/theme.ts 的 setMode 本身不校验合法性），与这里断言的
    // 'default' 不同，能真实抓到"忘记校验、直接透传"这个错误实现。
    expect(useTheme.getState().mode).toBe('default')
  })

  it('点击当前已勾选的那一项（mode 未变）也无条件补一次同步', async () => {
    // R2 修复（终审 Critical C1）：muda 在 macOS 上点击任何 CheckMenuItem 都会无条件
    // 翻转该项的原生勾选态、然后才发事件——即使点的是当前已勾选的那一项，原生勾选态
    // 也已经被扰动成"未勾选"。如果 handleThemeModeMenuEvent 只依赖 useTheme.subscribe
    // 的"mode 真变化才同步"守卫，mode 没变（点的就是当前已选中的那项）就会跳过同步，
    // 菜单停在零勾选、永不自愈，直到用户选了一个不同的模式才恢复——直接违反规格
    // §4.3「任意时刻恰好一个处于勾选态」。handleThemeModeMenuEvent 必须在 setMode
    // 之后无条件补一次同步，不能依赖/绕不开 subscribe 那条守卫。
    await menuEventsReady
    useTheme.setState({ mode: 'dual' }) // 模拟"当前已经是 dual"
    invokeMock.mockClear() // 清掉上一行 setState 触发的订阅回调可能产生的调用

    handleThemeModeMenuEvent({ payload: 'dual' } as never) // 点击当前已勾选的同一项

    expect(invokeMock).toHaveBeenCalledWith('set_theme_mode_checked', { mode: 'dual' })
  })

  it('调用 setMode 之后，同步函数被调用且传的是新模式', async () => {
    await menuEventsReady
    useTheme.setState({ mode: 'default' }) // 初始值，与下面目标值 'single' 不同
    invokeMock.mockClear() // 清掉上一行 setState 触发的订阅回调可能产生的调用

    useTheme.getState().setMode('single')

    expect(invokeMock).toHaveBeenCalledWith('set_theme_mode_checked', { mode: 'single' })
  })

  it('setMode 传入与当前相同的模式时不重复同步', async () => {
    await menuEventsReady
    useTheme.setState({ mode: 'dual' })
    invokeMock.mockClear()

    useTheme.getState().setMode('dual')

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('setLightThemeId（mode 未变）不触发 invoke', async () => {
    // R1 修复（评审要求）：src/menuEvents.ts 的 useTheme.subscribe 守卫
    // `if (state.mode !== prevState.mode)` 只应在 mode 字段真的变化时才同步——
    // zustand 的 setState 对每次 set() 都无条件通知订阅者、不做深比较，setLightThemeId/
    // setDarkThemeId/setSingleThemeId（以及系统深色模式监听器）都会触发订阅回调本身，
    // 但它们都不改 mode，守卫必须把这些场景过滤掉，不能让 mode 之外的字段变化也
    // 触发一次多余的 IPC。
    await menuEventsReady
    useTheme.setState({ mode: 'dual' })
    invokeMock.mockClear() // 清掉上一行 setState 触发的订阅回调可能产生的调用

    useTheme.getState().setLightThemeId('catppuccin-latte')

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('直接 setState 只改 activeTheme（mode 未变）不触发 invoke', async () => {
    // 模拟系统深色模式监听器那条路径（store/theme.ts 里 matchMedia 的 onChange
    // 只在 dual 模式下重新解析 activeTheme，最终 setState({ systemPrefersDark,
    // activeTheme })，同样不碰 mode）——这里直接用 setState 复现"mode 字段之外的
    // 任意字段变化"这个更一般的场景，不依赖某个具体 setter 的实现细节。
    await menuEventsReady
    useTheme.setState({ mode: 'dual' })
    invokeMock.mockClear()
    const current = useTheme.getState().activeTheme

    useTheme.setState({ activeTheme: { ...current, id: `${current.id}-mutated` } })

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('同步调用失败只 console.warn，不静默吞掉', async () => {
    await menuEventsReady
    useTheme.setState({ mode: 'default' }) // 初始值，与下面目标值 'single' 不同
    invokeMock.mockClear()
    invokeMock.mockRejectedValueOnce(new Error('ACL 拒绝'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    useTheme.getState().setMode('single')
    // invoke 是 async，让微任务队列走完，rejection 才有机会被 .catch 处理。
    await Promise.resolve()
    await Promise.resolve()

    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
