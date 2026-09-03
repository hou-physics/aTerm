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

// window_at_point（V3.4 Task 2）：拖标签到别的窗口标签栏时的落点命中测试。返回形状与
// src-tauri/src/lib.rs 的 WindowHit 逐字段对应（同一份 serde rename_all = "camelCase"
// 约定，见该 struct 注释：local_x/local_y -> localX/localY）。
export interface WindowHit { label: string; localX: number; localY: number }

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
/** 存活 PTY 的**全应用**总数（V3.3 §5.2）。⌘Q 是应用级退出，确认框必须报出所有窗口里
 *  正在跑的会话数，而不是本窗口标签里那几个——只有 Rust 的 PtyManager 掌握全部。
 *  失败时 reject（锁中毒），调用方 src/closeRequest.ts 负责降级并留痕。 */
export const ptyAliveCount = () => invoke<number>('pty_alive_count')
export const confirmExit = () => invoke<void>('confirm_exit')
/** 强行销毁一个拖出来的终端窗口（`term-<n>`），**绕过 CloseRequested**。
 *
 *  两个调用方，都要的是"关掉这个窗口，且不触发它自己那套'杀掉我持有的 PTY'流程"：
 *    - src/windowClose.ts：本窗口已经把自己持有的 PTY 处理完了，这一步只负责真的关掉；
 *      走普通的关窗路径会再触发一次 CloseRequested，那是个关不掉的循环。
 *    - src/windowHandoff.ts 的交接回滚：那个新窗口**可能已经接管成功**（只是 ack 丢
 *      了），走普通的关窗路径会让它把刚接管过来的会话全部 kill 掉（Ruling 7）。
 *
 *  Rust 侧只接受 `term-` 前缀的 label（主窗口不可被这条路径销毁），失败时 reject 的是
 *  可读的中文错误字符串。 */
export const destroyTermWindow = (label: string) => invoke<void>('destroy_term_window', { label })
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

/** 命中测试：给定一个逻辑屏幕坐标点，找出（排除 `exclude` 指定的窗口）第一个包含它
 *  的窗口，连同点在该窗口内的本地逻辑坐标；一个都不命中则 `null`。V3.4 拖标签到别的
 *  窗口标签栏的落点判定，Task 3 消费它。
 *
 *  **`localX`/`localY` 的原点是该窗口的内容区（webview）左上角**，不含原生标题栏：
 *  Rust 侧取的是 `inner_position()`/`inner_size()`（V3.4 修复轮 R1）。调用方拿 `localY`
 *  去比的 `TABBAR_DROP_ZONE_PX`（src/tabTearOut.ts）因此是一个相对标签栏本身定义的数，
 *  不需要在前端补一个标题栏高度的魔数。
 *
 *  坐标契约与 `create_term_window`（`windowHandoff.ts` 的调用点）同一份：x/y 是逻辑
 *  （CSS）像素，直接传 `PointerEvent.screenX`/`screenY`，不做 devicePixelRatio 换算
 *  （见 src-tauri/src/lib.rs 里 window_at_point 顶部注释的坐标契约）。
 *
 *  `exclude` 必传（V3.4 设计 Ruling 1）：源窗口在整个拖拽手势期间持有指针 capture、
 *  通常也是聚焦窗口，不排除它会永远命中它自己——调用方应传自身 label（见
 *  `windowLabel.ts`）。 */
export const windowAtPoint = (x: number, y: number, exclude: string) =>
  invoke<WindowHit | null>('window_at_point', { x, y, exclude })
