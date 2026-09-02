import { listen } from '@tauri-apps/api/event'
import { b64ToBytes } from './b64'

type Sink = (bytes: Uint8Array) => void
const sinks = new Map<string, Sink>()
const buffers = new Map<string, Uint8Array[]>()
const exited = new Set<string>()
const exitSinks = new Map<string, () => void>()

export const ptyEventsReady: Promise<void> = (async () => {
  await listen<{ id: string; data: string }>('pty-output', (e) => {
    const bytes = b64ToBytes(e.payload.data)
    const sink = sinks.get(e.payload.id)
    if (sink) sink(bytes)
    else {
      const arr = buffers.get(e.payload.id) ?? []
      arr.push(bytes)
      buffers.set(e.payload.id, arr)
    }
  })
  await listen<{ id: string; code: number }>('pty-exit', (e) => {
    exited.add(e.payload.id)
    exitSinks.get(e.payload.id)?.()
  })
})().then(() => undefined).catch((err) => { console.error('pty 事件监听注册失败', err) })

// 跨窗口交接（V3.3 设计文档 §4.2，见 src/windowHandoff.ts）的第一步：丢弃该 PTY 已经
// 攒下的待回放缓冲。
//
// R1 之前的顺序是「建窗前序列化」，空档是整个建窗时间（数百毫秒）；R1 改成「收到新窗口
// 的就绪事件之后才序列化」，空档缩到一次 IPC 往返，但代价是这段时间新窗口的 ptyBuffer
// 已经在攒实时输出了——那部分内容同时也在快照里，直接回放会**重复**。Claude Code 跑在
// alt-screen，重复的转义序列会把画面搞乱，比丢一小段更糟。
//
// 所以接管端必须：先 discardBuffered、再 seedScrollback、再让 TerminalView 去 attachPty。
// 三步之间不留可插入的时机（都在 handleHandoff 的同一个同步块里），缓冲被清空之后
// attachPty 的既有回放逻辑自然不会重放任何旧内容，此后的实时输出照常流入。
//
// 只丢缓冲，不碰 sinks/exited/exitSinks：这里要抹掉的是"交接期间攒下的、快照里已经
// 有的那份重复"，不是这个 PTY 的其它任何状态。
export function discardBuffered(id: string): void {
  buffers.delete(id)
}

// 交接的第二步：把旧窗口序列化出来的滚屏排进这个 PTY 待回放缓冲的**最前面**，而不是
// 直接写进终端。理由是时序：新窗口这边此刻还没有任何 <TerminalView> 挂载（标签是紧接着
// 这一步才进 store 的），拿不到 term 实例可写。unshift 而不是 push：紧随其后到达的实时
// 输出必须排在快照之后，随后 TerminalView 挂载时 attachPty 的既有回放逻辑（上面那一行
// replayed.forEach(sink)）就会先写历史、再写新输出，顺序天然正确——不需要在
// TerminalView（受保护文件）里加任何"交接专用"的写入口。
//
// （按 R1 的顺序，调用它之前刚刚 discardBuffered 过，队列本应是空的；unshift 仍然是对的
// 语义，它不依赖"队列一定为空"这个前提。）
//
// sinks 里已经有该 id 的接收者时直接写给它：这在正常交接流程里不会发生（seed 恒在
// 建标签之前），但如果真发生了，塞进 buffers 的内容会永远没人取走（attachPty 只在
// 挂载那一刻取一次），滚屏就凭空丢了——宁可顺序退化，也不要丢内容。
export function seedScrollback(id: string, text: string): void {
  if (!text) return
  const bytes = new TextEncoder().encode(text)
  const sink = sinks.get(id)
  if (sink) { sink(bytes); return }
  const arr = buffers.get(id) ?? []
  arr.unshift(bytes)
  buffers.set(id, arr)
}

export function attachPty(id: string, sink: Sink, onExit: () => void): () => void {
  const replayed = buffers.get(id) ?? []
  buffers.delete(id)
  replayed.forEach(sink)
  let live = false
  sinks.set(id, (bytes) => { live = true; sink(bytes) })
  exitSinks.set(id, onExit)
  if (exited.has(id)) onExit()
  return () => {
    if (!live && replayed.length > 0) buffers.set(id, replayed)
    sinks.delete(id)
    exitSinks.delete(id)
  }
}
