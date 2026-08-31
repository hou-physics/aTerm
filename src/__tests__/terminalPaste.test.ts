import { describe, expect, it, vi } from 'vitest'
import { pasteTo, registerPaste } from '../terminalPaste'

describe('terminalPaste', () => {
  it('已注册的 ptyId：pasteTo 命中，把文本交给注册的回调，返回 true', () => {
    const paste = vi.fn()
    registerPaste('pty-1', paste)

    const hit = pasteTo('pty-1', 'hello')

    expect(hit).toBe(true)
    expect(paste).toHaveBeenCalledWith('hello')
  })

  it('未注册的 ptyId：pasteTo 返回 false，不调用任何回调', () => {
    const hit = pasteTo('pty-never-registered', 'hello')

    expect(hit).toBe(false)
  })

  it('注销后：pasteTo 返回 false，且不再调用已注销的回调', () => {
    const paste = vi.fn()
    const unregister = registerPaste('pty-2', paste)

    unregister()
    const hit = pasteTo('pty-2', 'hello')

    expect(hit).toBe(false)
    expect(paste).not.toHaveBeenCalled()
  })

  it('两个 ptyId 互不串扰：向一个粘贴不会触发另一个的回调', () => {
    const pasteA = vi.fn()
    const pasteB = vi.fn()
    registerPaste('pty-a', pasteA)
    registerPaste('pty-b', pasteB)

    const hit = pasteTo('pty-a', 'text-a')

    expect(hit).toBe(true)
    expect(pasteA).toHaveBeenCalledWith('text-a')
    expect(pasteB).not.toHaveBeenCalled()
  })
})
