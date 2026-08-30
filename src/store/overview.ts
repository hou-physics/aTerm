// 总览页 store：排序快照（spec §5.2）、方块位置。持久化部分（positions）按
// src/store/theme.ts 的既有写法——模块加载时从 localStorage 读一次（try/catch 包住，
// 坏数据回退为默认空值），写入集中在 persist 辅助函数里，不引入持久化库。order 不
// 落盘，纯内存（同 tabs.ts 的 paneWidths、status.ts 的 statuses）：它只需要在"应用
// 这次运行期间、这个项目保持打开"这段时间里不重排，spec §5.2 的"打开时按最后活动
// 时间排序"本身就意味着每次全新启动重新打开都应该按当前最新活跃度重算一次，而不是
// 回放一份可能是几天前的陈旧快照。
//
// 自定义命名已搬到 store/library.ts（三处列表面共用）；readJson/persist 两个持久化
// 辅助函数在这里导出供 library.ts 复用，不要在那边复制第二份。
import { create } from 'zustand'

/** 方块身份键：`${dirName}::${rootKey}`，与 status.ts 的 threadStatusKey 同一拼接
 * 约定（各自独立选用同一个分隔符，不共享实现）。 */
export function blockKey(dirName: string, rootKey: string): string {
  return `${dirName}::${rootKey}`
}

export type ThreadForOrder = { rootKey: string; lastActivityMs: number }
export type Position = { x: number; y: number }

const POSITIONS_KEY = 'aterm.overview.positions'

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as T
    return fallback
  } catch {
    return fallback
  }
}

export function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch { /* 忽略持久化失败（如隐私模式下 localStorage 不可用） */ }
}

type OverviewState = {
  /** 按 dirName 存的方块顺序快照（blockKey 数组）。 */
  order: Record<string, string[]>
  /** 方块在画布上的位置，按 blockKey 存。 */
  positions: Record<string, Position>
  /** 打开某个项目（dirName）的总览时调用：已有快照则保留既有顺序，只做「移除已
   * 消失的 key」+「新出现的 key 按最后活动时间新→旧追加到末尾」；无快照则整体按
   * lastActivityMs 降序建立（spec §5.2「打开时按最后活动时间排序，打开期间不自动
   * 重排」）。 */
  captureOrder(dirName: string, threads: ThreadForOrder[]): void
  /** 拖拽中：只改内存，不落盘（沿用项目既有"两动作"范式，见 tabs.ts setPaneWidths）。 */
  setPosition(key: string, pos: Position): void
  /** 落手：持久化。 */
  commitPosition(key: string, pos: Position): void
  /** 清除某个项目的排序快照（Task 8 ruling：「打开」指总览标签被创建这件事——
   * tabs.ts 的 openOverview 只在真正新建标签时调用这个方法，聚焦已有标签不调用）。
   * 纯内存操作：order 本就不持久化，这里不涉及 localStorage。对没有快照的
   * dirName 也是安全的空操作。 */
  clearOrder(dirName: string): void
}

function buildInitialOrder(threads: ThreadForOrder[], dirName: string): string[] {
  return [...threads]
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
    .map((th) => blockKey(dirName, th.rootKey))
}

const initialPositions = readJson<Record<string, Position>>(POSITIONS_KEY, {})

export const useOverviewStore = create<OverviewState>((set, get) => ({
  order: {},
  positions: initialPositions,
  captureOrder: (dirName, threads) => {
    const existing = get().order[dirName]
    let nextForDir: string[]
    if (!existing) {
      nextForDir = buildInitialOrder(threads, dirName)
    } else {
      const currentKeys = new Set(threads.map((th) => blockKey(dirName, th.rootKey)))
      const kept = existing.filter((k) => currentKeys.has(k))
      const keptSet = new Set(kept)
      const newThreads = threads.filter((th) => !keptSet.has(blockKey(dirName, th.rootKey)))
      nextForDir = [...kept, ...buildInitialOrder(newThreads, dirName)]
    }
    set({ order: { ...get().order, [dirName]: nextForDir } })
  },
  setPosition: (key, pos) => {
    set((s) => ({ positions: { ...s.positions, [key]: pos } }))
  },
  commitPosition: (key, pos) => {
    const nextPositions = { ...get().positions, [key]: pos }
    persist(POSITIONS_KEY, nextPositions)
    set({ positions: nextPositions })
  },
  clearOrder: (dirName) => {
    const next = { ...get().order }
    delete next[dirName]
    set({ order: next })
  },
}))
