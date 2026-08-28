// hooks 安装状态 + 安装/卸载操作的 store（spec §6 前端接线，绑定
// docs/superpowers/specs/2026-08-27-status-engine-design.md §6、
// .superpowers/hooks-installer-report.md 描述的三个 Tauri 命令）。
//
// 与 store/status.ts 的 statusEventsReady 同一套"模块级挂载即发起一次初始查询"写法
// （导出 ready Promise 供测试 await），但这里没有 Tauri 事件订阅——hooks_status()/
// install_hooks()/uninstall_hooks() 都是纯请求/响应式命令，后端不会为它们推送任何
// session-status 那样的事件（见 hooks-installer-report.md：只有三个薄封装命令）。
// 「查询一次、装完/卸完各自再查询一次、绝不轮询」（任务约束）因此天然成立：refresh()
// 只在模块加载时被调用一次，此后只会被 install()/uninstall() 成功后的显式调用触发。
import { create } from 'zustand'
import { hooksStatus, installHooks, uninstallHooks, type HooksStatus } from '../ipc'

export type HooksPhase = 'notInstalled' | 'outdated' | 'upToDate'

/** 汇总 notification/stop 两个 hook 各自的 installed/upToDate 成单一阶段：任一未装 →
 * notInstalled（哪怕另一个已装且最新——install_hooks() 是幂等的，点「安装」会把缺的那个
 * 补上，不会重复已有的）；都装了但任一不是最新 → outdated；都装了且都最新 → upToDate。
 * status 为 null（尚未查询到，或查询失败）时返回 null——提示条/设置区手动入口据此渲染
 * "还不知道"而不是猜一个状态，与 store/status.ts 里 AggregateStatus 的 'unknown' 是
 * 同一处理哲学。 */
export function hooksPhase(status: HooksStatus | null): HooksPhase | null {
  if (!status) return null
  if (!status.notification.installed || !status.stop.installed) return 'notInstalled'
  if (!status.notification.upToDate || !status.stop.upToDate) return 'outdated'
  return 'upToDate'
}

function errorMessage(err: unknown): string {
  // 与 ConversationPanel.tsx 的 load() 同一处理：Tauri 的 Result<_, String> 命令失败时，
  // invoke() 的 rejection 就是后端返回的字符串本身（不是 Error 实例）；这里同时兜住
  // Error 实例这一种理论上可能的情况（例如 IPC 层自身抛出），保证任何形状的 err 都能
  // 转成可展示的字符串，不会把 "[object Object]" 之类的东西糊给用户。
  return err instanceof Error ? err.message : String(err)
}

const DISMISS_KEY = 'aterm-hooks-prompt-dismissed'

function readPersistedDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch { /* localStorage 不可用（如隐私模式），忽略 */ }
  return false
}

function persistDismissed() {
  try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* 忽略持久化失败 */ }
}

type HooksInstallState = {
  status: HooksStatus | null
  dismissed: boolean
  pending: boolean
  error: string | null
  refresh(): Promise<void>
  install(): Promise<void>
  uninstall(): Promise<void>
  dismiss(): void
}

export const useHooksInstall = create<HooksInstallState>((set, get) => ({
  status: null,
  dismissed: readPersistedDismissed(),
  pending: false,
  error: null,
  refresh: async () => {
    try {
      const status = await hooksStatus()
      set({ status })
    } catch (err) {
      // hooks_status() 在后端从不返回 Err（结构异常/文件缺失一律视为"未安装"，见
      // installer.rs），这里的 catch 只兜底真正的 IPC 传输层失败（例如开发期命令名
      // 拼错）；不把这种情况当用户可见错误展示，控制台留痕即可，UI 侧保持"未知"
      // （phase 为 null）比强行展示一条与安装本身无关的错误更合适。
      console.error('查询 hooks 安装状态失败', err)
    }
  },
  install: async () => {
    set({ pending: true, error: null })
    try {
      await installHooks()
      await get().refresh()
      set({ pending: false })
    } catch (err) {
      set({ pending: false, error: errorMessage(err) })
    }
  },
  uninstall: async () => {
    set({ pending: true, error: null })
    try {
      await uninstallHooks()
      await get().refresh()
      set({ pending: false })
    } catch (err) {
      set({ pending: false, error: errorMessage(err) })
    }
  },
  dismiss: () => {
    persistDismissed()
    set({ dismissed: true })
  },
}))

// 模块级触发：与 store/status.ts 的 statusEventsReady 同一写法，在 import 时立即发起
// 一次查询（对应任务约束"Query hooks_status() once on mount"——应用启动即是这里说的
// "mount"）。refresh() 内部已经吞掉了自己的异常，这里的 .catch 只是保证这个 Promise
// 本身绝不 reject（万一 refresh() 的实现将来改动出现遗漏），不会产生未处理的 rejection。
export const hooksInstallReady: Promise<void> = useHooksInstall
  .getState()
  .refresh()
  .catch((err) => { console.error('hooks 安装状态初始查询失败', err) })
