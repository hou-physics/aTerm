import { invoke } from '@tauri-apps/api/core'

export interface ThreadInfo {
  rootKey: string; resumeSessionId: string; title: string; cwd: string; lastActivityMs: number; fileCount: number
  // 链上全部文件的 session id（时间升序，与 fileCount 同源）。窗格对账用：见
  // paneReconcile.ts。必填——后端恒会给出，写成可选只会把契约的模糊转嫁给调用方。
  sessionIds: string[]
  // title 是否为真实标题。false 时 title 是 resumeSessionId 前 8 位的回退值，不可采纳。
  titled: boolean
  // 徽章数据：均可缺省（老会话或异常记录取不到时为 null），与 rust 端 ThreadInfo 同源。
  model?: string | null
  contextTokens?: number | null
  preview?: string | null
  effort?: string | null
  permissionMode?: string | null
}
export interface ProjectInfo { dirName: string; cwd: string; lastActivityMs: number; threads: ThreadInfo[] }
export interface Turn { role: string; text: string; tsMs: number; uuid: string }
export interface Conversation { turns: Turn[]; files: string[]; totalBytes: number }

export type SessionStatusValue = 'running' | 'awaitingInput' | 'done'
export interface SessionStatusPayload {
  dirName: string
  rootKey: string
  sessionId: string
  status: SessionStatusValue
  lastActivityMs: number
  updatedAtMs: number
}

// hooks 安装器（spec §6）：三个命令的返回形状与 src-tauri/src/status/installer.rs 的
// HookInstallState/HooksStatus/InstallOutcome/UninstallOutcome 逐字段对应（serde
// rename_all = "camelCase"）。hooksStatus() 只读、后端从不因结构异常报错（缺失/不可解析
// 一律视为"未安装"），installHooks()/uninstallHooks() 对应 Result<_, String>，失败时
// invoke() 的 rejection 就是后端给出的、已经是用户可读中文的错误字符串本身。
export interface HookInstallState { installed: boolean; upToDate: boolean }
export interface HooksStatus { notification: HookInstallState; stop: HookInstallState }
export interface InstallOutcome { backupPath: string }
export interface UninstallOutcome { backupPath: string; removed: boolean }

export const listProjects = () => invoke<ProjectInfo[]>('list_projects')
export const readConversation = (dirName: string, rootKey: string) =>
  invoke<Conversation>('read_conversation', { dirName, rootKey })
export const getSessionStatuses = () => invoke<SessionStatusPayload[]>('get_session_statuses')
export const ptySpawn = (o: { cwd?: string; inject?: string; cols: number; rows: number }) => invoke<string>('pty_spawn', o)
export const ptyWrite = (id: string, data: string) => invoke<void>('pty_write', { id, data })
export const ptyResize = (id: string, cols: number, rows: number) => invoke<void>('pty_resize', { id, cols, rows })
export const ptyKill = (id: string) => invoke<void>('pty_kill', { id })
export const ptyIsAlive = (id: string) => invoke<boolean>('pty_is_alive', { id })
export const confirmExit = () => invoke<void>('confirm_exit')
export const hooksStatus = () => invoke<HooksStatus>('hooks_status')
export const installHooks = () => invoke<InstallOutcome>('install_hooks')
export const uninstallHooks = () => invoke<UninstallOutcome>('uninstall_hooks')
// sub-agent 计数（Task 3 的 count_subagents，逐行流式读完整个 transcript、故意标 async
// 跑在后台线程）。
//
// 第二个参数是 sessionId，传 ThreadInfo.resumeSessionId：Rust 侧不再从 rootKey 反推
// 文件——那要把整个项目目录重扫一遍（每个 .jsonl 都读头 40 行/256KB + 尾 64KB 再各跑
// 一次 parse_meta），只为算出一个前端本来就握在手里的文件名；总览页每个方块都会发一次
// 这个命令，代价是 N×F。详见 src-tauri/src/sessions/subagents.rs 的 count_subagents 注释。
//
// 未知的 dirName/sessionId 组合（含非法 id）按既有约定返回 Ok(0)，与「读取失败」在这一
// 层不可区分——调用方（OverviewPage.tsx）按 spec §5.3 把 0 一律当「不显示徽章」处理，
// 不需要在这里额外分辨。
export const countSubagents = (dirName: string, sessionId: string) =>
  invoke<number>('count_subagents', { dirName, sessionId })
