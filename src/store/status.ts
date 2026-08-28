// 会话状态 store：订阅 Rust 状态引擎的 `session-status` Tauri 事件（见
// docs/superpowers/specs/2026-08-27-status-engine-design.md §7、
// .superpowers/status-engine-rust-report.md）。模块级注册时机与写法完全照抄
// ptyBuffer.ts 的既有模式——在 import 时就调用 listen()（早于任何用户交互/组件挂载），
// 导出一个 ready Promise 供测试 await，事件监听逻辑本身不放进 ipc.ts（ipc.ts 只做
// 纯 invoke 包装，见该文件顶部约定）。
import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'
import { getSessionStatuses, type SessionStatusPayload, type SessionStatusValue } from '../ipc'

export type SessionStatus = SessionStatusValue
/** 项目卡片的聚合状态；'unknown' 表示"该项目下没有任何已知状态"，UI 应渲染为空白
 * 而不是猜一个颜色（后端初始扫描是异步的，见 rust 报告"关注点 1"，启动瞬间大概率是这个值）。 */
export type AggregateStatus = SessionStatus | 'unknown'

/** 会话身份键：与后端 `"{dirName}::{rootKey}"` 的内部拼接一致（并非强制要求，
 * 只是两侧独立选用同一个分隔符更方便对照日志），前端始终通过这个函数生成/查询，
 * 不在别处手写字符串拼接。 */
export function threadStatusKey(dirName: string, rootKey: string): string {
  return `${dirName}::${rootKey}`
}

/**
 * 项目聚合规则（spec §7）：任一 running → running；否则任一 awaitingInput →
 * awaitingInput；否则若所有"已知"状态都是 done（且至少有一个已知）→ done；
 * 否则 unknown（未知的会话——包括后端还没扫描到、或压根没有状态——一律不参与
 * "全部 done" 的判定，也不会被当成任何一种已知状态误显示）。
 */
export function aggregateStatus(statuses: Array<SessionStatus | undefined>): AggregateStatus {
  const known = statuses.filter((s): s is SessionStatus => s !== undefined)
  if (known.some((s) => s === 'running')) return 'running'
  if (known.some((s) => s === 'awaitingInput')) return 'awaitingInput'
  if (known.length > 0 && known.every((s) => s === 'done')) return 'done'
  return 'unknown'
}

/**
 * 合并单条 entry 到 map：按 updatedAtMs 取较新者。这不是为了处理乱序的 session-status
 * 事件本身（后端同一事件数组内没有乱序问题），而是为了让"启动时的 get_session_statuses()
 * 快照"与"随后到达的增量事件"可以以任意顺序调用 applyEntries 而不互相覆盖出错误结果——
 * 见下方 statusEventsReady 的注册顺序注释。返回是否真的发生了写入（用于避免无意义的
 * set() 触发多余的 re-render）。
 */
function upsert(map: Map<string, SessionStatusPayload>, entry: SessionStatusPayload): boolean {
  const key = threadStatusKey(entry.dirName, entry.rootKey)
  const existing = map.get(key)
  if (existing && existing.updatedAtMs > entry.updatedAtMs) return false
  map.set(key, entry)
  return true
}

type StatusStoreState = {
  statuses: Map<string, SessionStatusPayload>
  /** 单调递增的变更计数。存在的意义是给 React 一个**标量**依赖：`statuses` 是每次
   *  更新都换新引用的 Map，直接当依赖会让消费方难以区分"真的变了"与"重渲染了"，
   *  而计数器只在确有条目被更新时才加一。App.tsx 用它触发会话元数据的节流刷新。 */
  version: number
  applyEntries(entries: SessionStatusPayload[]): void
}

export const useStatusStore = create<StatusStoreState>((set) => ({
  statuses: new Map(),
  version: 0,
  applyEntries: (entries) => {
    if (entries.length === 0) return
    set((state) => {
      const next = new Map(state.statuses)
      let changed = false
      for (const e of entries) {
        if (upsert(next, e)) changed = true
      }
      return changed ? { statuses: next, version: state.version + 1 } : state
    })
  },
}))

/** 单个会话（线程）当前状态；未知/尚无数据时返回 undefined——调用方（StatusDot）据此
 * 渲染"什么都不画"而不是猜一个默认色。 */
export function useThreadStatus(dirName: string, rootKey: string): SessionStatus | undefined {
  return useStatusStore((s) => s.statuses.get(threadStatusKey(dirName, rootKey))?.status)
}

/** 项目卡片的聚合状态，见 aggregateStatus 规则。 */
export function useProjectStatus(dirName: string, rootKeys: string[]): AggregateStatus {
  return useStatusStore((s) =>
    aggregateStatus(rootKeys.map((rk) => s.statuses.get(threadStatusKey(dirName, rk))?.status)),
  )
}

// 模块级注册：与 ptyBuffer.ts 的 ptyEventsReady 同一写法——在 import 时立即调用
// listen()，早于任何组件挂载/用户交互；导出的 Promise 只供测试 await（真实运行时
// 没人需要等它，事件到达前 UI 只是"还没有状态"，是正常状态而非错误，见 rust
// 报告"关注点 1"与本文件顶部的 spec §7 引用）。
//
// 顺序：先注册事件监听，再拉取一次快照。这不是为了"确保监听已就绪才不丢事件"
// （listen() 内部已经把注册做成了 await 出去之前就完成，两次调用之间理论上有一个
// 极窄的窗口可能有事件先于快照到达），而是让二者的相对顺序完全不重要——upsert()
// 按 updatedAtMs 取较新者，无论先应用快照后应用事件、还是反过来，最终收敛到同一个
// 结果。
export const statusEventsReady: Promise<void> = (async () => {
  await listen<SessionStatusPayload[]>('session-status', (e) => {
    useStatusStore.getState().applyEntries(e.payload)
  })
  const snapshot = await getSessionStatuses()
  useStatusStore.getState().applyEntries(snapshot)
})().then(() => undefined).catch((err) => { console.error('会话状态事件监听注册失败', err) })
