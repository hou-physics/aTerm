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
