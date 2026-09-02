import { listen } from '@tauri-apps/api/event'
import { confirmExit, ptyAliveCount } from './ipc'
import { currentWindowLabel } from './windowLabel'

// 纯函数，不依赖 Tauri：给定"仍存活的会话数"，拼出确认弹窗的文案。抽出来单独导出
// 就是为了不必启动整套 Tauri/事件监听也能测这段文案逻辑。
export function buildExitConfirmMessage(liveCount: number): string {
  return liveCount > 0
    ? `还有 ${liveCount} 个会话在运行，关闭 aTerm 会终止它们。确定关闭？`
    : '确定关闭 aTerm？'
}

// 数一数**整个应用**里还有多少个存活的会话（V3.3 设计文档 §5.2）。
//
// 改动前这里叫 countLiveTerminalTabs()，遍历的是 useTabs 里**本窗口**的标签、对每个
// ptyId 查一次 ptyIsAlive。多窗口之后那只是全部会话的一个子集：⌘Q 是**应用级**退出，
// 会把别的窗口里正在跑的 claude 一起终止，而确认框只报本窗口那几个——用户据此点"确定"
// 就等于在不知情的情况下杀掉了另一个窗口的会话，甚至在本窗口一个终端都没开时看到
// "确定关闭 aTerm？"这条完全不含警告的文案。
//
// 现在改问 Rust 的 pty_alive_count：PtyManager 是全应用唯一那张 PTY 表，每个窗口的
// pty_spawn 都落进它，天然跨窗口，且不需要前端做任何跨窗口状态同步。顺带把 N 次 IPC
// 往返压成 1 次。
//
// 失败（锁中毒，实际上只可能在 Rust 侧 panic 过之后发生）时保守按 0 处理并留痕：
// console.warn 是为了不让这条路径像 core:window:allow-set-size 那次事故一样"静默吞掉、
// 运行期零信号"。按 0 处理意味着确认框退化成不含警告的简单文案——这是这里唯一能做的
// 降级：报一个编造的数字更糟，而因为数不出来就不让用户退出应用最糟。
async function countLiveSessions(): Promise<number> {
  try {
    return await ptyAliveCount()
  } catch (err) {
    console.warn('统计存活会话数失败，按 0 处理', err)
    return 0
  }
}

// Rust 侧（主窗口 CloseRequested、应用级 ExitRequested、macOS 上替换过的 Quit 菜单项）
// 三条路径目前都会 prevent_close/prevent_exit 之后重新 emit 这同一个事件，把决定权
// 转交这里——但它们不会互相协调"是不是已经弹过一次了"：例如确认框还开着的时候用户又
// 按了一次 ⌘Q，或者又点了一次标题栏红色关闭按钮，Rust 侧都会老老实实再 emit 一次。
// 没有这个模块级"确认进行中"标志位的话，这里会对同一次"用户想关闭"的意图重复发起
// 统计 + confirm 弹窗，堆出第二个对话框。用一个简单的布尔值挡掉
// 重入：确认流程进行中收到的新请求直接丢弃，等这一轮跑完（无论确认还是取消）
// 在 finally 里复位，下一次关闭请求才会重新触发一轮全新的确认。
let confirmationInFlight = false

// 导出便于测试直接 await 完整流程（统计存活会话 → 弹确认 → 视结果决定是否调用
// confirm_exit）；下面注册监听时直接把这个函数本身传给 listen，不用一个丢弃返回值的
// 包装闭包——那样会让 listen 的回调同步返回 undefined、内部这条 async 链变成"发射后不管"，
// 调用方（包括测试）就没法可靠地等到它真正跑完。
export async function handleCloseRequested() {
  if (confirmationInFlight) return
  confirmationInFlight = true
  try {
    const liveCount = await countLiveSessions()
    const { confirm } = await import('@tauri-apps/plugin-dialog')
    const ok = await confirm(buildExitConfirmMessage(liveCount), { title: 'aTerm' })
    if (ok) await confirmExit()
  } finally {
    confirmationInFlight = false
  }
}

// 与 ptyBuffer.ts 的 ptyEventsReady 同一个注册模式：模块顶层立即发起监听注册（而不是
// 等某个组件挂载时才注册），确保它在用户有机会点击关闭按钮之前就已经就绪；导出这个
// Promise 只是为了让调用方（App.tsx）能在需要时等它就绪，日常不必 await。
//
// **target 必须限定成本窗口**（V3.3）：Rust 侧的 emit_close_requested 现在是
// `emit_to("main", …)` 而不是广播——退出是应用级的一件事，只该问一次。但定向只在监听侧
// 也限定 target 时才真的生效：不传 options 的 listen 会落成 `{ kind: 'Any' }`，而 Any
// 目标的监听器对 emit_to 的 label 过滤**无条件命中**（tauri 2.11.5 event/listener.rs
// 的 match_any_or_filter，完整考据见 src/windowHandoff.ts 顶部）。少了这一行，每个拖
// 出来的 term-* 窗口都会各弹一个"确定关闭 aTerm？"，同一次 ⌘Q 堆出 N 个对话框。
//
// 主窗口自己传的 target 恰是 'main'，与 Rust 那侧的目标一致，因此照收不误；
// currentWindowLabel() 在 jsdom/浏览器预览里兜底也返回 'main'（见 windowLabel.ts）。
export const closeRequestReady: Promise<void> = (async () => {
  await listen('app-close-requested', handleCloseRequested, { target: await currentWindowLabel() })
})()
  .then(() => undefined)
  .catch((err) => { console.error('关闭确认监听注册失败', err) })
