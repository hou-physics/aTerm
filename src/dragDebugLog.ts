// 临时诊断日志模块（定位「拖 tab 到 ⌘D 空槽窗格，drop 不生效、松手后误切换成源标签」这个
// bug 用——见任务记录，定位后整个模块 + 所有调用点随同一次提交一起 revert 移除，不留任何
// 残余）。写盘的一端是 src-tauri/src/lib.rs 里同样标了"临时"的 `debug_log` 命令，追加写入
// `~/Library/Application Support/aTerm/drag-debug.log`。
//
// 调用方：src/components/TabBar.tsx（拖标签的整条生命周期）与 src/dragSafetyNet.ts（窗口级
// 兜底的三个触发点）共用同一个 debugLog()——序号 seq 因此是跨这两个文件全局单调递增的，
// 日志按时间落盘、天然有序，seq 只是在时间戳可能重复/难以肉眼比较时提供一个无歧义的兜底。
//
// 测试隔离：不走 `../ipc` 那一层（那层是给生产用的、long-lived 的命令用的，这里刻意不
// 污染它，也不需要为此在一堆已有测试文件的 `vi.mock('../ipc', ...)` 里逐个补一项——见任务
// 要求"removing all of this later is a single revert"）。改为在这里自己判断
// `window.__TAURI_INTERNALS__` 是否存在：单测环境（jsdom，无 Tauri backend）下恒为
// false，直接跳过，连一次 invoke() 调用都不会发生，不会有任何 console 噪音或未处理的
// rejection 需要担心。真机/真实 WKWebView 里这个全局对象由 Tauri 注入，恒为 true。
import { invoke } from '@tauri-apps/api/core'

let seq = 0
let dragStartMs: number | null = null

function hasTauriBackend(): boolean {
  try {
    return typeof window !== 'undefined' && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  } catch {
    return false
  }
}

// 每次 pointerdown（一次新拖拽手势的起点）调用一次，重置"+Nms"的计时基准。seq 本身不
// 重置——多次拖拽尝试共用同一份日志文件时，单调递增的 seq 仍能唯一标出"这是第几行"，
// 不会因为每次拖拽都从 +0ms 重新开始而看起来像是发生了乱序。
export function markDragStart(): void {
  dragStartMs = performance.now()
}

// fire-and-forget：调用方从不 await 这个函数、也从不需要处理它的失败——写盘失败（例如
// 磁盘满、权限问题）对定位这次 bug 毫无帮助，反而不该让诊断代码本身成为新的故障点。
export function debugLog(line: string): void {
  seq += 1
  const elapsedMs = dragStartMs === null ? 0 : Math.round(performance.now() - dragStartMs)
  const formatted = `#${seq} +${elapsedMs}ms ${line}`
  if (!hasTauriBackend()) return
  void invoke('debug_log', { line: formatted }).catch(() => {})
}
