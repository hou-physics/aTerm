import { invoke } from '@tauri-apps/api/core'

export interface ThreadInfo { rootKey: string; resumeSessionId: string; title: string; cwd: string; lastActivityMs: number; fileCount: number }
export interface ProjectInfo { dirName: string; cwd: string; lastActivityMs: number; threads: ThreadInfo[] }

export const listProjects = () => invoke<ProjectInfo[]>('list_projects')
export const ptySpawn = (o: { cwd?: string; inject?: string; cols: number; rows: number }) => invoke<string>('pty_spawn', o)
export const ptyWrite = (id: string, data: string) => invoke<void>('pty_write', { id, data })
export const ptyResize = (id: string, cols: number, rows: number) => invoke<void>('pty_resize', { id, cols, rows })
export const ptyKill = (id: string) => invoke<void>('pty_kill', { id })
export const ptyIsAlive = (id: string) => invoke<boolean>('pty_is_alive', { id })
