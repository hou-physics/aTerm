import { create } from 'zustand'
import { ptyIsAlive, ptyKill, ptySpawn } from '../ipc'
import { ptyEventsReady } from '../ptyBuffer'

// Pane：标签内的单个终端会话。当前版本每个 term 标签恒持有且仅持有一个 pane——
// 这是分屏功能的第一步（纯等价重构），为后续多 pane 铺路，见
// docs/superpowers/specs/2026-08-27-split-view-design.md §2、§10。
export type Pane = { id: string; ptyId: string; title: string; threadKey?: string; dirName?: string; rootKey?: string }
export type Tab = { id: string; kind: 'home' | 'term'; title: string; panes: Pane[]; activePaneId?: string; paneWidths?: number[] }
let nextTab = 1
let nextPane = 1

type ConfirmFn = (msg: string) => Promise<boolean>
async function dialogConfirm(msg: string): Promise<boolean> {
  const { confirm } = await import('@tauri-apps/plugin-dialog')
  return confirm(msg, { title: 'aTerm' })
}

type TabsState = {
  tabs: Tab[]
  activeId: string
  setActive(id: string): void
  openTerminal(o: { title: string; cwd?: string; inject?: string; threadKey?: string; dirName?: string; rootKey?: string }): Promise<void>
  focusThread(threadKey: string): boolean
  closeTab(id: string, confirmFn?: ConfirmFn): Promise<void>
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }],
  activeId: 'home',
  setActive: (id) => set({ activeId: id }),
  openTerminal: async ({ title, cwd, inject, threadKey, dirName, rootKey }) => {
    await ptyEventsReady
    const ptyId = await ptySpawn({ cwd, inject, cols: 80, rows: 24 })
    const id = `tab-${nextTab++}`
    const pane: Pane = { id: `pane-${nextPane++}`, ptyId, title, threadKey, dirName, rootKey }
    set((s) => ({ tabs: [...s.tabs, { id, kind: 'term', title, panes: [pane], activePaneId: pane.id }], activeId: id }))
  },
  focusThread: (threadKey) => {
    for (const tab of get().tabs) {
      const pane = tab.panes.find((p) => p.threadKey === threadKey)
      if (pane) {
        set((s) => ({
          activeId: tab.id,
          tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, activePaneId: pane.id } : t)),
        }))
        return true
      }
    }
    return false
  },
  closeTab: async (id, confirmFn = dialogConfirm) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || tab.kind === 'home') return
    const alivePanes: Pane[] = []
    for (const pane of tab.panes) {
      if (await ptyIsAlive(pane.ptyId)) alivePanes.push(pane)
    }
    if (alivePanes.length > 0) {
      const ok = await confirmFn('进程仍在运行，关闭标签将终止它。确认关闭？')
      if (!ok) return
      for (const pane of alivePanes) await ptyKill(pane.ptyId)
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeId = s.activeId === id ? tabs[tabs.length - 1].id : s.activeId
      return { tabs, activeId }
    })
  },
}))
