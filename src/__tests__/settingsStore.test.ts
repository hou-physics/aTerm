import { describe, expect, it, beforeEach } from 'vitest'
import { useSettings } from '../store/settings'

describe('settings store', () => {
  beforeEach(() => { useSettings.setState({ open: false }) })

  it('默认关闭', () => {
    expect(useSettings.getState().open).toBe(false)
  })

  it('openSettings 打开，closeSettings 关闭', () => {
    useSettings.getState().openSettings()
    expect(useSettings.getState().open).toBe(true)
    useSettings.getState().closeSettings()
    expect(useSettings.getState().open).toBe(false)
  })

  it('重复调用是幂等的', () => {
    useSettings.getState().openSettings()
    useSettings.getState().openSettings()
    expect(useSettings.getState().open).toBe(true)
  })
})
