import { create } from 'zustand'
import { ptyIsAlive, ptyKill, ptySpawn } from '../ipc'
import { ptyEventsReady } from '../ptyBuffer'

export type Tab = { id: string; kind: 'home' | 'term'; title: string; ptyId?: string }
let nextTab = 1

type ConfirmFn = (msg: string) => Promise<boolean>
async function dialogConfirm(msg: string): Promise<boolean> {
  const { confirm } = await import('@tauri-apps/plugin-dialog')
  return confirm(msg, { title: 'aTerm' })
}

type TabsState = {
  tabs: Tab[]
  activeId: string
  setActive(id: string): void
  openTerminal(o: { title: string; cwd?: string; inject?: string }): Promise<void>
  closeTab(id: string, confirmFn?: ConfirmFn): Promise<void>
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [{ id: 'home', kind: 'home', title: '主页' }],
  activeId: 'home',
  setActive: (id) => set({ activeId: id }),
  openTerminal: async ({ title, cwd, inject }) => {
    await ptyEventsReady
    const ptyId = await ptySpawn({ cwd, inject, cols: 80, rows: 24 })
    const id = `tab-${nextTab++}`
    set((s) => ({ tabs: [...s.tabs, { id, kind: 'term', title, ptyId }], activeId: id }))
  },
  closeTab: async (id, confirmFn = dialogConfirm) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || tab.kind === 'home') return
    if (tab.ptyId && (await ptyIsAlive(tab.ptyId))) {
      const ok = await confirmFn('进程仍在运行，关闭标签将终止它。确认关闭？')
      if (!ok) return
      await ptyKill(tab.ptyId)
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeId = s.activeId === id ? tabs[tabs.length - 1].id : s.activeId
      return { tabs, activeId }
    })
  },
}))
