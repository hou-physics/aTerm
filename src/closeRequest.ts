import { listen } from '@tauri-apps/api/event'
import { confirmExit, ptyIsAlive } from './ipc'
import { useTabs } from './store/tabs'

// 纯函数，不依赖 Tauri：给定"仍存活的会话数"，拼出确认弹窗的文案。抽出来单独导出
// 就是为了不必启动整套 Tauri/事件监听也能测这段文案逻辑。
export function buildExitConfirmMessage(liveCount: number): string {
  return liveCount > 0
    ? `还有 ${liveCount} 个会话在运行，关闭 aTerm 会终止它们。确定关闭？`
    : '确定关闭 aTerm？'
}

// 数一数当前还挂着终端标签、且其 PTY 确实存活的有多少个。任意一次 ptyIsAlive 查询失败
// （例如那个 pty 记录已经被并发清理）都保守地当作"已不存活"处理，不让单次查询失败
// 拖垮整个统计。
async function countLiveTerminalTabs(): Promise<number> {
  const ptyIds = useTabs
    .getState()
    .tabs.filter((t): t is typeof t & { ptyId: string } => t.kind === 'term' && Boolean(t.ptyId))
    .map((t) => t.ptyId)
  const alive = await Promise.all(ptyIds.map((id) => ptyIsAlive(id).catch(() => false)))
  return alive.filter(Boolean).length
}

// 导出便于测试直接 await 完整流程（统计存活会话 → 弹确认 → 视结果决定是否调用
// confirm_exit）；下面注册监听时直接把这个函数本身传给 listen，不用一个丢弃返回值的
// 包装闭包——那样会让 listen 的回调同步返回 undefined、内部这条 async 链变成"发射后不管"，
// 调用方（包括测试）就没法可靠地等到它真正跑完。
export async function handleCloseRequested() {
  const liveCount = await countLiveTerminalTabs()
  const { confirm } = await import('@tauri-apps/plugin-dialog')
  const ok = await confirm(buildExitConfirmMessage(liveCount), { title: 'aTerm' })
  if (ok) await confirmExit()
}

// 与 ptyBuffer.ts 的 ptyEventsReady 同一个注册模式：模块顶层立即发起监听注册（而不是
// 等某个组件挂载时才注册），确保它在用户有机会点击关闭按钮之前就已经就绪；导出这个
// Promise 只是为了让调用方（App.tsx）能在需要时等它就绪，日常不必 await。
export const closeRequestReady: Promise<void> = listen('app-close-requested', handleCloseRequested)
  .then(() => undefined)
  .catch((err) => { console.error('关闭确认监听注册失败', err) })
