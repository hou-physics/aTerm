import { describe, expect, it, vi } from 'vitest'
import { b64ToBytes } from '../b64'

const { handlers, listenMock } = vi.hoisted(() => {
  const handlers: Record<string, (e: { payload: unknown }) => void> = {}
  const listenMock = vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    handlers[event] = handler
    return () => {}
  })
  return { handlers, listenMock }
})

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

const toB64 = (s: string) => btoa(s)
const bytesOf = (s: string) => b64ToBytes(toB64(s))

async function freshModule() {
  vi.resetModules()
  const mod = await import('../ptyBuffer')
  await mod.ptyEventsReady
  return mod
}

// 用普通闭包记录收到的字节，而不是直接把 vi.fn() 当 sink 传给 attachPty：
// 缓冲回放走的是 Array.prototype.forEach(sink)，会把 (item, index, array) 三个参数
// 都传给回调，若 sink 本身是 vi.fn()，记录的调用参数会混入多余的 index/array。
function trackedSink() {
  const calls: Uint8Array[] = []
  const sink = (bytes: Uint8Array) => { calls.push(bytes) }
  return { sink, calls }
}

describe('ptyBuffer.attachPty', () => {
  it('StrictMode 间隙回归：首次 attach 回放后立即 detach（未收到实时事件）——缓冲应恢复，二次 attach 仍能收到该数据', async () => {
    const { attachPty } = await freshModule()

    handlers['pty-output']({ payload: { id: 'X', data: toB64('hello') } })

    const s1 = trackedSink()
    const detach1 = attachPty('X', s1.sink, () => {})
    expect(s1.calls).toHaveLength(1)
    expect(s1.calls[0]).toEqual(bytesOf('hello'))

    detach1() // 未收到任何实时事件就被 detach（对应 StrictMode 同步 mount→cleanup→remount 间隙）

    const s2 = trackedSink()
    attachPty('X', s2.sink, () => {})
    expect(s2.calls).toHaveLength(1)
    expect(s2.calls[0]).toEqual(bytesOf('hello'))
  })

  it('实时路径：收到过实时事件后 detach，缓冲不应被恢复，二次 attach 不重复回放', async () => {
    const { attachPty } = await freshModule()

    const s1 = trackedSink()
    const detach1 = attachPty('Y', s1.sink, () => {})
    handlers['pty-output']({ payload: { id: 'Y', data: toB64('live-chunk') } })
    expect(s1.calls).toHaveLength(1)
    expect(s1.calls[0]).toEqual(bytesOf('live-chunk'))

    detach1() // 已经收到过实时事件，不应把它当缓冲恢复

    const s2 = trackedSink()
    attachPty('Y', s2.sink, () => {})
    expect(s2.calls).toHaveLength(0)
  })

  it('退出语义：先退出后 attach 立即触发 onExit；未知 id 的事件不抛错', async () => {
    const { attachPty } = await freshModule()

    handlers['pty-exit']({ payload: { id: 'Z', code: 0 } })

    const onExit = vi.fn()
    attachPty('Z', () => {}, onExit)
    expect(onExit).toHaveBeenCalledTimes(1)

    expect(() => handlers['pty-output']({ payload: { id: 'ghost', data: toB64('x') } })).not.toThrow()
    expect(() => handlers['pty-exit']({ payload: { id: 'ghost-2', code: 1 } })).not.toThrow()
  })
})
