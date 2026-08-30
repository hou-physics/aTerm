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

const ALIASES_KEY = 'aterm.overview.names'          // 历史键名，见上方注释，不要改
const HIDDEN_KEY = 'aterm.library.hiddenProjects'
const REMOVED_KEY = 'aterm.library.removedSessions'

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
}))
