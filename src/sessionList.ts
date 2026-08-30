// 三个列表面（侧栏「最近会话」、主页项目卡片、总览方块）共用的派生查询。
// 与 store 分开放，是为了能当纯函数单测——store 里只放状态与写操作。
//
// 命名注意：本文件叫 sessionList.ts，store 叫 store/library.ts。两者刻意不同名，
// 只差一层目录的同名文件在 import 时极易看错。
import { blockKey } from './store/overview'

/** 列表里该显示的标题。优先级：用户别名 > 真实标题 > 「新对话」。
 *  最后一档是必需的：后端在会话尚无标题时把 title 填成 session_id 前 8 位
 *  （见 src-tauri/src/sessions/scan.rs 的 title 回退），titled 就是这个情况的标记。
 *  直接渲染 title 会让列表里出现一串十六进制。 */
export function displayTitle(
  thread: { rootKey: string; title: string; titled: boolean },
  dirName: string,
  aliases: Record<string, string>,
): string {
  const alias = aliases[blockKey(dirName, thread.rootKey)]
  if (alias) return alias
  return thread.titled ? thread.title : '新对话'
}

/** 该会话此刻是否应从「最近会话」里隐去。移除之后只要又有新活动就自动回归——
 *  这实现了「下次再用它的时候默认可以出现」，不需要任何额外 UI，也不需要用户
 *  记得去哪里恢复。等号取「仍隐去」：同一毫秒不算「又用了一次」。 */
export function isSessionRemoved(removedAtMs: number | undefined, lastActivityMs: number): boolean {
  if (removedAtMs === undefined) return false
  return lastActivityMs <= removedAtMs
}

const DAY_LABELS = ['今天', '昨天', '更早'] as const

/** 按本地日历日分「今天/昨天/更早」。不排序——调用方已按活跃时间降序排好，
 *  这里只做分桶，保持传入顺序。空桶不产出，避免出现一个下面什么都没有的标题。 */
export function groupRecentByDate<T extends { lastActivityMs: number }>(
  items: T[],
  now: number,
): { label: (typeof DAY_LABELS)[number]; items: T[] }[] {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()
  const yesterdayMs = todayMs - 24 * 60 * 60 * 1000

  const buckets: T[][] = [[], [], []]
  for (const it of items) {
    if (it.lastActivityMs >= todayMs) buckets[0].push(it)
    else if (it.lastActivityMs >= yesterdayMs) buckets[1].push(it)
    else buckets[2].push(it)
  }
  return DAY_LABELS
    .map((label, i) => ({ label, items: buckets[i] }))
    .filter((g) => g.items.length > 0)
}
