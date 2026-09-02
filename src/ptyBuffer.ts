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

// 标签被从别的窗口拖过来时（V3.3 设计文档 §4.2 第 5 步，见 src/windowHandoff.ts）：
// 旧窗口序列化出来的滚屏要排在这个 PTY 待回放缓冲的**最前面**，而不是直接写进终端。
// 理由是时序：新窗口这边此刻还没有任何 <TerminalView> 挂载（标签是紧接着这一步才进
// store 的），拿不到 term 实例可写；而 pty-output 是 app.emit 全应用广播（pty.rs:28），
// 本窗口的监听从 ptyEventsReady 就绪那一刻起就已经在往 buffers 里攒交接期间的实时
// 输出了。把滚屏 unshift 到队首，随后 TerminalView 挂载时 attachPty 的既有回放逻辑
// （上面那一行 replayed.forEach(sink)）就会先写历史、再写这期间的新输出，顺序天然
// 正确——不需要在 TerminalView（受保护文件）里加任何"交接专用"的写入口。
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
