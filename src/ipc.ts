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
// 本窗口最近一次为每个 PTY 请求过的终端尺寸。
//
// 用途（V3.3 Task 4 R2/I4）：标签拖出的交接一旦在"新窗口已经接管过"之后回滚，新窗口
// 那个 TerminalView 挂载时已经 fit() 并把 PTY 拧成了**它自己**的几何；新窗口关掉之后
// 旧窗口的 xterm 尺寸没变、ResizeObserver 不触发、active 也没变，于是 PTY 永远停在错误
// 的列宽上，旧窗口里的会话一直折行错乱，直到用户手动改窗口大小。回滚时要把尺寸拧回来，
// 就需要知道"旧窗口自己的几何是多少"。
//
// 为什么记在这里就是对的：每个窗口是**独立的 JS 上下文**，这张表只会记下**本窗口**
// 发出过的 pty_resize，新窗口的那次调用发生在它自己的上下文里，不会污染这张表。而
// TerminalView（受保护文件，本任务不得改动）每次 fit 之后都会调用 ptyResize，所以这里
// 拿到的恒是本窗口最后一次自己算出来的真实 cols/rows——不需要去读 xterm 实例，也不需要
// 在受保护文件里新开一个尺寸注册表。
const lastPtySizes = new Map<string, { cols: number; rows: number }>()

export const ptyResize = (id: string, cols: number, rows: number) => {
  lastPtySizes.set(id, { cols, rows })
  return invoke<void>('pty_resize', { id, cols, rows })
}

/** 本窗口最近一次为该 PTY 请求过的尺寸；本窗口从未请求过（终端还没挂载/fit 过）时
 *  返回 undefined。 */
export const lastPtySize = (id: string): { cols: number; rows: number } | undefined => lastPtySizes.get(id)
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

/** 在访达中打开一个文件夹。后端只接受已存在的目录，失败时 reject 的是可直接展示给
 *  用户的中文错误字符串（与 installHooks 等命令同一约定）。 */
export const revealInFinder = (path: string) => invoke<void>('reveal_in_finder', { path })
