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
