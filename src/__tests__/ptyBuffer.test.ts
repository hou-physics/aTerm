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

  it('先缓冲后实时：attach 收到回放之后又收到实时事件，detach 不应恢复缓冲，新 sink 收不到任何数据', async () => {
    const { attachPty } = await freshModule()

    handlers['pty-output']({ payload: { id: 'Z', data: toB64('buffered-chunk') } })

    const s1 = trackedSink()
    const detach1 = attachPty('Z', s1.sink, () => {})
    expect(s1.calls).toHaveLength(1)
    expect(s1.calls[0]).toEqual(bytesOf('buffered-chunk'))

    handlers['pty-output']({ payload: { id: 'Z', data: toB64('live-chunk') } }) // 实时事件到达，live 应被置 true
    expect(s1.calls).toHaveLength(2)
    expect(s1.calls[1]).toEqual(bytesOf('live-chunk'))

    detach1() // live 已为 true：即使 replayed 非空也不应重新入队

    const s2 = trackedSink()
    attachPty('Z', s2.sink, () => {})
    expect(s2.calls).toHaveLength(0) // 若 !live 门控被移除，这里会收到重放的 'buffered-chunk'
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

// 跨窗口交接（V3.3 §4.2 第 5 步，见 src/windowHandoff.ts）：新窗口把旧窗口序列化出来
// 的滚屏交给 seedScrollback，随后 TerminalView 挂载时由既有的 attachPty 回放路径一并
// 写进终端——不需要在受保护的 TerminalView 里另开一个"交接专用"写入口。
describe('ptyBuffer.seedScrollback（跨窗口交接的滚屏落地）', () => {
  it('滚屏排在交接期间已经攒下的实时输出**之前**：attachPty 回放的第一批是历史，不是新输出', async () => {
    const { attachPty, seedScrollback } = await freshModule()

    // 新窗口的 pty-output 监听在交接开始前就已就绪，这一段是交接期间到达的实时输出。
    // 载荷经 base64 传输（b64ToBytes），这里用 ASCII 字面量——btoa 不接受非 Latin-1。
    handlers['pty-output']({ payload: { id: 'H', data: toB64('live-during-handoff') } })
    seedScrollback('H', 'scrollback-history')

    const s = trackedSink()
    attachPty('H', s.sink, () => {})
    const decoder = new TextDecoder()
    expect(s.calls.map((b) => decoder.decode(b))).toEqual(['scrollback-history', 'live-during-handoff'])
  })

  it('空字符串不入队：没有滚屏可搬时不该在缓冲里塞一个零字节块', async () => {
    const { attachPty, seedScrollback } = await freshModule()

    seedScrollback('E', '')

    const s = trackedSink()
    attachPty('E', s.sink, () => {})
    expect(s.calls).toHaveLength(0)
  })

  it('discardBuffered 之后 attachPty 不会重放任何旧内容（R1：那份内容已经在快照里了）', async () => {
    const { attachPty, discardBuffered } = await freshModule()

    handlers['pty-output']({ payload: { id: 'D', data: toB64('buffered-before-handoff') } })
    discardBuffered('D')

    const s = trackedSink()
    attachPty('D', s.sink, () => {})
    expect(s.calls).toHaveLength(0)
  })

  it('discardBuffered 只丢自己那一路：别的 PTY 的缓冲不受影响', async () => {
    const { attachPty, discardBuffered } = await freshModule()

    handlers['pty-output']({ payload: { id: 'D1', data: toB64('one') } })
    handlers['pty-output']({ payload: { id: 'D2', data: toB64('two') } })
    discardBuffered('D1')

    const s = trackedSink()
    attachPty('D2', s.sink, () => {})
    expect(s.calls.map((b) => new TextDecoder().decode(b))).toEqual(['two'])
  })

  it('discardBuffered 不碰已经挂上的接收者：正在显示的终端不会因为一次清缓冲而变哑', async () => {
    const { attachPty, discardBuffered } = await freshModule()

    const s = trackedSink()
    attachPty('D4', s.sink, () => {})
    discardBuffered('D4')
    handlers['pty-output']({ payload: { id: 'D4', data: toB64('still-flowing') } })

    expect(s.calls.map((b) => new TextDecoder().decode(b))).toEqual(['still-flowing'])
  })

  it('discardBuffered 之后仍能收实时输出：清的是缓冲，不是这个 PTY 的其它状态', async () => {
    const { attachPty, discardBuffered } = await freshModule()

    handlers['pty-output']({ payload: { id: 'D3', data: toB64('stale') } })
    discardBuffered('D3')
    handlers['pty-output']({ payload: { id: 'D3', data: toB64('live') } })

    const s = trackedSink()
    attachPty('D3', s.sink, () => {})
    expect(s.calls.map((b) => new TextDecoder().decode(b))).toEqual(['live'])
  })

  it('该 PTY 已经有接收者时直接写给它，不塞进一个再也没人取走的缓冲', async () => {
    const { attachPty, seedScrollback } = await freshModule()

    const s = trackedSink()
    attachPty('L', s.sink, () => {})
    seedScrollback('L', 'scrollback-history')

    const decoder = new TextDecoder()
    expect(s.calls.map((b) => decoder.decode(b))).toEqual(['scrollback-history'])
  })
})

// V3.3 Task 4 R2/I3：标签交接给别的窗口之后，本窗口既不该再投递、也不该再缓存这个 PTY
// 的输出——pty-output 是全应用广播，而本窗口的 TerminalView 已经卸载、且再也不会
// attachPty 这个 id，没有任何路径会清空 buffers。只清一次不够，广播不会停。
describe('ptyBuffer.ignorePtyOutput（已交接出去的 PTY）', () => {
  it('登记之后到达的输出既不缓存也不投递：attachPty 什么都收不到', async () => {
    const { attachPty, ignorePtyOutput } = await freshModule()

    ignorePtyOutput('G1')
    for (let i = 0; i < 100; i++) handlers['pty-output']({ payload: { id: 'G1', data: toB64('spam') } })

    const s = trackedSink()
    attachPty('G1', s.sink, () => {})
    expect(s.calls).toHaveLength(0)
  })

  it('登记时把已经攒下的那份也一并清掉（不是只挡住后来的）', async () => {
    const { attachPty, ignorePtyOutput } = await freshModule()

    handlers['pty-output']({ payload: { id: 'G2', data: toB64('buffered-before') } })
    ignorePtyOutput('G2')

    const s = trackedSink()
    attachPty('G2', s.sink, () => {})
    expect(s.calls).toHaveLength(0)
  })

  it('只影响被登记的那一个 id：别的 PTY 照常缓存与投递', async () => {
    const { attachPty, ignorePtyOutput } = await freshModule()

    ignorePtyOutput('G3')
    handlers['pty-output']({ payload: { id: 'G3', data: toB64('dropped') } })
    handlers['pty-output']({ payload: { id: 'G4', data: toB64('kept') } })

    const s = trackedSink()
    attachPty('G4', s.sink, () => {})
    expect(s.calls.map((b) => new TextDecoder().decode(b))).toEqual(['kept'])
  })

  it('"已忽略"不是终态：本窗口再次为该 id 挂上终端后，输出恢复', async () => {
    const { attachPty, ignorePtyOutput } = await freshModule()

    ignorePtyOutput('G5')
    const s = trackedSink()
    attachPty('G5', s.sink, () => {})
    handlers['pty-output']({ payload: { id: 'G5', data: toB64('back-again') } })

    expect(s.calls.map((b) => new TextDecoder().decode(b))).toEqual(['back-again'])
  })
})
