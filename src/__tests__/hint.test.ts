import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHint } from '../store/hint'

beforeEach(() => { useHint.setState({ message: null, action: null }) })

describe('useHint 的动作支持', () => {
  it('不带动作时 action 为 null（既有调用方不受影响）', () => {
    useHint.getState().show('最多支持 3 个窗格')
    expect(useHint.getState().message).toBe('最多支持 3 个窗格')
    expect(useHint.getState().action).toBeNull()
  })
  it('带动作时 action 可读且可调用', () => {
    const onClick = vi.fn()
    useHint.getState().show('已隐藏 aTerm', { label: '撤销', onClick })
    expect(useHint.getState().action?.label).toBe('撤销')
    useHint.getState().action!.onClick()
    expect(onClick).toHaveBeenCalled()
  })
  it('超时后 message 与 action 一起清空——只清一个会留下一个孤零零的按钮', () => {
    vi.useFakeTimers()
    useHint.getState().show('已隐藏 aTerm', { label: '撤销', onClick: vi.fn() })
    vi.advanceTimersByTime(2300)
    expect(useHint.getState().message).toBeNull()
    expect(useHint.getState().action).toBeNull()
    vi.useRealTimers()
  })
})
