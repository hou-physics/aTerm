// 三个列表面（侧栏、主页、总览）共用的用户数据：会话别名、主页隐藏的项目、
// 从「最近会话」移除的会话。持久化写法沿用 store/overview.ts（模块加载时读一次，
// 写入集中在 persist 里，不引入持久化库）。
//
// 别名原先住在 store/overview.ts 里（只服务总览方块），现在提升为三处共用。
// 【存储键与键格式一个字都不能改】：用户已经改过的名字就存在 aterm.overview.names
// 下、键是 `${dirName}::${rootKey}`。换成更整齐的新键名、或换成 threadKey 的单冒号
// 格式，都会让这些名字静默作废（读出来是空，不报任何错）。这是搬家，不是重建。
import { create } from 'zustand'
import { persist, readJson } from './overview'

// 三个键都导出，是给 src/userDataSync.ts 路由跨窗口广播用的：那边不该再抄一份字面量。
// 两份字面量迟早会漂移，而漂移的后果是静默的（广播照发，收方不认，谁都不报错）——正是
// 上方注释里说的那种"读出来是空，不报任何错"。
export const ALIASES_KEY = 'aterm.overview.names'   // 历史键名，见上方注释，不要改
export const HIDDEN_KEY = 'aterm.library.hiddenProjects'
export const REMOVED_KEY = 'aterm.library.removedSessions'

type LibraryState = {
  aliases: Record<string, string>
  hiddenProjects: Record<string, true>
  removedSessions: Record<string, number>
  rename(key: string, name: string): void
  clearAlias(key: string): void
  hideProject(dirName: string): void
  unhideProject(dirName: string): void
  removeSession(key: string): void
  restoreSession(key: string): void
  /** 把别的窗口广播过来的整张表换进来（V3.3 §5.5，全分支终审 Ruling 20；唯一调用方
   *  是 src/userDataSync.ts）。三张表各一个入口而不是一个 setState：这样"哪个
   *  localStorage 键对应哪个字段"这件事只存在于本文件里一份。 */
  applyRemoteAliases(next: Record<string, string>): void
  applyRemoteHiddenProjects(next: Record<string, true>): void
  applyRemoteRemovedSessions(next: Record<string, number>): void
}

export const useLibrary = create<LibraryState>((set, get) => ({
  aliases: readJson<Record<string, string>>(ALIASES_KEY, {}),
  hiddenProjects: readJson<Record<string, true>>(HIDDEN_KEY, {}),
  removedSessions: readJson<Record<string, number>>(REMOVED_KEY, {}),

  // 一律先 trim 再判空——空白规则因此只有一条，而不是"全空白清除、两侧填充却原样
  // 落盘"。带着空格落盘后每次渲染都带着那对空格，用户看不出多的是什么、也删不掉。
  rename: (key, name) => {
    const trimmed = name.trim()
    if (trimmed === '') { get().clearAlias(key); return }
    const next = { ...get().aliases, [key]: trimmed }
    persist(ALIASES_KEY, next)
    set({ aliases: next })
  },
  clearAlias: (key) => {
    const next = { ...get().aliases }
    delete next[key]
    persist(ALIASES_KEY, next)
    set({ aliases: next })
  },
  hideProject: (dirName) => {
    const next = { ...get().hiddenProjects, [dirName]: true as const }
    persist(HIDDEN_KEY, next)
    set({ hiddenProjects: next })
  },
  unhideProject: (dirName) => {
    const next = { ...get().hiddenProjects }
    delete next[dirName]
    persist(HIDDEN_KEY, next)
    set({ hiddenProjects: next })
  },
  removeSession: (key) => {
    const next = { ...get().removedSessions, [key]: Date.now() }
    persist(REMOVED_KEY, next)
    set({ removedSessions: next })
  },
  restoreSession: (key) => {
    const next = { ...get().removedSessions }
    delete next[key]
    persist(REMOVED_KEY, next)
    set({ removedSessions: next })
  },

  // ── 跨窗口同步的接收端（V3.3 §5.5）──────────────────────────────────────
  //
  // 为什么必须有这三个入口：上面每个 action 都是"拿**自己内存里**的整张表 + 一处改动
  // → 整份写回"，而 store 只在模块加载时读过一次 localStorage。两个窗口各自改一个
  // 别名，后写的那份会把先写的那次改名整份覆盖掉——**用户的改名凭空消失，无任何报错**。
  // CLAUDE.md 说这几个键"改任何一个都会静默作废用户已保存的数据"，这里结果完全同类，
  // 只是触发方式从"改键名"变成"开两个窗口"。
  //
  // **整份替换**而不是逐条合并：广播方发出的是它那一刻完整的表，而它自己也在跟着别的
  // 窗口同步，所以它手上那份才是最新的；合并会让"某个窗口清掉的别名/取消的隐藏"在另
  // 一个窗口那里复活。
  //
  // 仍然 persist：Tauri 各窗口同源、localStorage 本就共享，发送端已经写过同样的值，
  // 这次是幂等重写（沿用 store/theme.ts applyRemoteThemeState 的同一口径）。这次
  // persist 触发的那条广播由 userDataSync 的 applyingRemoteChange 闸门挡掉，不成环。
  applyRemoteAliases: (next) => {
    persist(ALIASES_KEY, next)
    set({ aliases: next })
  },
  applyRemoteHiddenProjects: (next) => {
    persist(HIDDEN_KEY, next)
    set({ hiddenProjects: next })
  },
  applyRemoteRemovedSessions: (next) => {
    persist(REMOVED_KEY, next)
    set({ removedSessions: next })
  },
}))
