import { create } from 'zustand'
import { listProjects, type ProjectInfo } from '../ipc'

type SessionsState = { projects: ProjectInfo[]; loading: boolean; refresh(): Promise<void> }
export const useSessions = create<SessionsState>((set) => ({
  projects: [],
  loading: false,
  refresh: async () => {
    set({ loading: true })
    try { set({ projects: await listProjects() }) } finally { set({ loading: false }) }
  },
}))
