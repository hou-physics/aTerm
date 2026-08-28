import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTrailingThrottle } from '../refreshThrottle'

describe('createTrailingThrottle', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('密集触发只跑一次（这正是不能每条 session-status 都刷新的原因）', () => {
    const fn = vi.fn()
    const t = createTrailingThrottle(fn, 1000)
    for (let i = 0; i < 50; i++) t.trigger()
    expect(fn).not.toHaveBeenCalled() // 尾沿：还没到点，一次都没跑
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('首次触发不被拖延（lastRun 初值为 -Infinity，等待算作 0）', () => {
    const fn = vi.fn()
    const t = createTrailingThrottle(fn, 1000)
    t.trigger()
    vi.advanceTimersByTime(0)
    expect(fn).toHaveBeenCalledTimes(1) // 启动后第一次刷新不该白等一个间隔
  })

  it('跑过之后，下一次触发要等满一个间隔才跑', () => {
    const fn = vi.fn()
    const t = createTrailingThrottle(fn, 1000)
    t.trigger()
    vi.advanceTimersByTime(0) // 首次立即跑，此时 lastRun = 当前时刻
    expect(fn).toHaveBeenCalledTimes(1)

    t.trigger()
    vi.advanceTimersByTime(999)
    expect(fn).toHaveBeenCalledTimes(1) // 间隔未满，不跑
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('距上次已超过一个间隔时，触发后立刻就能跑（不额外多等）', () => {
    const fn = vi.fn()
    const t = createTrailingThrottle(fn, 1000)
    t.trigger()
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5000) // 长时间无事件
    t.trigger()
    vi.advanceTimersByTime(0) // 等待时间被算成 0
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('cancel 后待跑的那次不再发生（组件卸载后不得再刷新）', () => {
    const fn = vi.fn()
    const t = createTrailingThrottle(fn, 1000)
    t.trigger()
    t.cancel()
    vi.advanceTimersByTime(10_000)
    expect(fn).not.toHaveBeenCalled()
  })

  it('cancel 之后仍可重新触发', () => {
    const fn = vi.fn()
    const t = createTrailingThrottle(fn, 1000)
    t.trigger()
    t.cancel()
    t.trigger()
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
