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

// V3.3 全分支终审 Ruling 19 / I1：pty-output 是全应用广播，**每个**窗口都会收到
// **所有**窗口的 PTY 输出。在窗口 Y 里，窗口 X 的 ptyId 既没有 sink 也不在 ignored，
// 于是每一条都进 buffers，而 Y 永远不会 attachPty 那个 id——没有任何路径清空它。
// 两个窗口各自把对方每个 PTY 的输出永久攒在 JS 堆里，几小时后 WKWebView OOM。
//
// 下面这组用例钉的是「有界」这条性质本身，不是某个具体上限值。
describe('ptyBuffer：待回放缓冲的字节上限（多窗口下别的窗口的 PTY 永远不会被认领）', () => {
  const CHUNK_BYTES = 64 * 1024
  /** 每块 64 KiB 的可区分内容：前 16 字节是序号标签，其余填充。 */
  const chunkLabel = (i: number) => `chunk-${String(i).padStart(9, '0')}`
  const chunkText = (i: number) => chunkLabel(i) + 'x'.repeat(CHUNK_BYTES - chunkLabel(i).length)
  const decode = (b: Uint8Array) => new TextDecoder().decode(b)

  /** 灌到超过上限：上限 / 每块 + 8 块余量。返回实际灌进去的块数与总字节数。 */
  function floodOverCap(handler: (e: { payload: unknown }) => void, id: string, cap: number) {
    const count = Math.ceil(cap / CHUNK_BYTES) + 8
    for (let i = 0; i < count; i += 1) {
      handler({ payload: { id, data: toB64(chunkText(i)) } })
    }
    return { count, pushedBytes: count * CHUNK_BYTES }
  }

  it('灌进去的量超过上限时，总量被压在上限之内、且不再随灌入量增长', async () => {
    const { attachPty, MAX_BUFFERED_BYTES } = await freshModule()

    const { pushedBytes } = floodOverCap(handlers['pty-output'], 'CAP1', MAX_BUFFERED_BYTES)

    const s = trackedSink()
    attachPty('CAP1', s.sink, () => {})
    const replayedBytes = s.calls.reduce((n, b) => n + b.length, 0)
    // 两条断言各挡一类实现错误，顺序刻意如此（前一条先跑，才能各自被单独变异出来）：
    //   1. `< pushedBytes` 挡"根本没有淘汰"——那时 replayed 恰好等于 pushed；
    //   2. `<= MAX_BUFFERED_BYTES` 挡"淘汰有但阈值被放宽"——总量仍随灌入量走高，
    //      而第 1 条此时是成立的（确实丢了一些），单靠它抓不到。
    expect(replayedBytes).toBeLessThan(pushedBytes)
    expect(replayedBytes).toBeLessThanOrEqual(MAX_BUFFERED_BYTES)
  })

  it('丢的是**最旧**的：最新到达的那一块一定还在，最早那几块已经不在了', async () => {
    const { attachPty, MAX_BUFFERED_BYTES } = await freshModule()

    const { count } = floodOverCap(handlers['pty-output'], 'CAP2', MAX_BUFFERED_BYTES)

    const s = trackedSink()
    attachPty('CAP2', s.sink, () => {})
    const labels = s.calls.map((b) => decode(b).slice(0, chunkLabel(0).length))
    // 终端要的是"接上最近的画面"。两条断言顺序刻意如此，才能各自被单独变异出来：
    //   1. "最新的还在"抓淘汰方向写反（改成丢最新的）——那时最旧的当然也还在，
    //      第 2 条反而是成立的；
    //   2. "最旧的不在了"抓根本没有淘汰。
    expect(labels[labels.length - 1]).toBe(chunkLabel(count - 1))
    expect(labels).not.toContain(chunkLabel(0))
  })

  it('上限内的正常回放完全不受影响：全部内容按原顺序一条不少地回放', async () => {
    const { attachPty, MAX_BUFFERED_BYTES } = await freshModule()

    // 这一组的总量远低于上限——它代表 buffers 的**正当用途**：PTY 已 spawn、
    // <TerminalView> 尚未挂载的那个空档。上限绝不能把这段路径也一起砍了。
    const count = 5
    expect(count * CHUNK_BYTES).toBeLessThan(MAX_BUFFERED_BYTES)
    for (let i = 0; i < count; i += 1) {
      handlers['pty-output']({ payload: { id: 'CAP3', data: toB64(chunkText(i)) } })
    }

    const s = trackedSink()
    attachPty('CAP3', s.sink, () => {})
    expect(s.calls).toHaveLength(count)
    expect(s.calls.map((b) => decode(b).slice(0, chunkLabel(0).length)))
      .toEqual([chunkLabel(0), chunkLabel(1), chunkLabel(2), chunkLabel(3), chunkLabel(4)])
  })

  it('交接滚屏不会被实时输出挤掉：灌爆上限之后，回放的第一块仍是那份快照', async () => {
    const { attachPty, seedScrollback, MAX_BUFFERED_BYTES } = await freshModule()

    // 硬约束：buffers 存在的本意之一就是承载交接时 seedScrollback 的那份快照，它是
    // 旧窗口整段历史的唯一副本（旧窗口的 xterm 实例随标签一起没了）。若把它当普通
    // 实时块参与淘汰，交接期间紧随其后的实时输出会立刻把它挤出去——接管方拿到一个
    // 没有任何历史的终端，而这正是 seedScrollback 存在的目的。
    seedScrollback('CAP4', 'scrollback-history')
    floodOverCap(handlers['pty-output'], 'CAP4', MAX_BUFFERED_BYTES)

    const s = trackedSink()
    attachPty('CAP4', s.sink, () => {})
    expect(decode(s.calls[0])).toBe('scrollback-history')
  })

  it('上限是**每个 id 各自**的：一个 PTY 灌爆不会连累另一个', async () => {
    const { attachPty, MAX_BUFFERED_BYTES } = await freshModule()

    handlers['pty-output']({ payload: { id: 'CAP6', data: toB64('quiet-neighbour') } })
    floodOverCap(handlers['pty-output'], 'CAP5', MAX_BUFFERED_BYTES)

    const s = trackedSink()
    attachPty('CAP6', s.sink, () => {})
    expect(s.calls.map(decode)).toEqual(['quiet-neighbour'])
  })

  // M-2（终审定向复审补）：detach 恢复走的是「整个 Pending 记录原样放回」，而不是重新
  // 包一个 { chunks, pinned: 0, liveBytes: 0 }。复审把它改成后者时，本文件当时的 21 条
  // 断言**全部照常通过**——因为没有任何一条同时用到「seed 过的滚屏」+「detach 恢复」+
  // 「恢复之后再淘汰」这三件事。pinned 一旦被归零，恢复后的第一次淘汰就会把交接滚屏
  // 当成普通实时块删掉，而那正是这块缓冲存在的目的。
  it('detach 恢复不会丢掉 pinned 标记：seed 过滚屏、detach 之后再灌爆上限，滚屏仍在', async () => {
    const { attachPty, seedScrollback, MAX_BUFFERED_BYTES } = await freshModule()

    seedScrollback('P', 'scrollback-history')

    // 挂上又立刻 detach（未收到任何实时事件）——Pending 应被原样放回，pinned 不得归零
    const s1 = trackedSink()
    attachPty('P', s1.sink, () => {})()

    // 恢复之后灌爆上限：淘汰只应吃掉实时块，pinned 的滚屏必须留住
    const block = 'x'.repeat(64 * 1024)
    for (let i = 0; i < Math.ceil(MAX_BUFFERED_BYTES / block.length) + 4; i++) {
      handlers['pty-output']({ payload: { id: 'P', data: toB64(block) } })
    }

    const s2 = trackedSink()
    attachPty('P', s2.sink, () => {})
    expect(s2.calls[0]).toEqual(new TextEncoder().encode('scrollback-history'))
  })

  it('单独一块就超过上限时也至少保留它，不会退化成空回放', async () => {
    const { attachPty, MAX_BUFFERED_BYTES } = await freshModule()

    // 一次超大 paste 的回显就可能是这样。宁可越限，也不要给用户一个完全空白的终端。
    // 先来一块小的再来那块超大的：正确行为是小的被淘汰、超大的这块**独自**留下。
    const small = 's'.repeat(1024)
    const huge = 'H'.repeat(MAX_BUFFERED_BYTES + 1024)
    handlers['pty-output']({ payload: { id: 'CAP7', data: toB64(small) } })
    handlers['pty-output']({ payload: { id: 'CAP7', data: toB64(huge) } })

    const s = trackedSink()
    attachPty('CAP7', s.sink, () => {})
    // 两条各自可变异：删掉"至少留一块"的下界守卫 → 连超大那块也被淘汰，第 1 条红；
    // 淘汰方向写反 → 留下的是那块小的，第 1 条仍为 1、第 2 条红。
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0].length).toBe(huge.length)
  })
})
