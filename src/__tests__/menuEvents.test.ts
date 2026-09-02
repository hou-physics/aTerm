import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, listenMock } = vi.hoisted(() => {
  const handlers: Record<string, () => void> = {}
  const listenMock = vi.fn(async (event: string, handler: () => void) => {
    handlers[event] = handler
    return () => {}
  })
  return { handlers, listenMock }
})

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { handleOpenSettingsMenuItem, menuEventsReady } from '../menuEvents'
import { useSettings } from '../store/settings'

beforeEach(() => {
  // 初始值特意设为 false（与下面测试要断言的目标值 true 不同）——如果这里不重置、
  // 或者初始值恰好也是 true，"触发后变 true"这条断言就会在实现完全不生效时也通过。
  useSettings.setState({ open: false })
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
