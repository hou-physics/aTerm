import type { Turn } from './ipc'

// 面板首行摘要的默认截断长度（时间线条目一行放不下太多字）。
const DEFAULT_SUMMARY_LEN = 32

export interface DateGroup {
  /** 本地日期键，形如 2026-08-27，用于分组与排序，不用于展示 */
  key: string
  /** 展示用标题，形如 8月27日 */
  label: string
  turns: Turn[]
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地日期分组键，跨年也不会与其他年份的同月同日碰撞 */
export function dateKey(tsMs: number): string {
  const d = new Date(tsMs)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 展示用日期标题，如「8月27日」 */
export function formatDateLabel(tsMs: number): string {
  const d = new Date(tsMs)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 时间线条目的 HH:MM（本地时间） */
export function formatTimeHM(tsMs: number): string {
  const d = new Date(tsMs)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * 把用户发起的轮次按本地日期分组，供时间线目录渲染。
 * 展示顺序为最新在前：日期分组本身新的在前，组内轮次也新的在前
 * （对应设计稿 §6 的目录示意：8月27日在上、组内 14:32 早于 12:19）。
 */
export function groupUserTurnsByDate(turns: Turn[]): DateGroup[] {
  const byKey = new Map<string, DateGroup>()
  for (const t of turns) {
    if (t.role !== 'user') continue
    const key = dateKey(t.tsMs)
    let g = byKey.get(key)
    if (!g) {
      g = { key, label: formatDateLabel(t.tsMs), turns: [] }
      byKey.set(key, g)
    }
    g.turns.push(t)
  }
  const groups = Array.from(byKey.values())
  groups.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
  for (const g of groups) g.turns.sort((a, b) => b.tsMs - a.tsMs)
  return groups
}

/** 取正文首行并截断，用作时间线条目的摘要 */
export function firstLineSummary(text: string, maxLen: number = DEFAULT_SUMMARY_LEN): string {
  const firstLine = (text.split('\n')[0] ?? '').trim()
  if (firstLine.length <= maxLen) return firstLine
  return `${firstLine.slice(0, maxLen)}…`
}
