// 关闭一个**拖出来的终端窗口**（V3.3 设计文档 §5.3）。
//
// ## PTY 的所有权模型（这个文件存在的全部理由）
//
// 一个 PTY 由 Rust 的 PtyManager 持有——那是一张**全应用扁平表**，没有窗口归属信息。
// 「哪个窗口持有哪个 PTY」这件事的唯一真相在**各窗口自己的 useTabs store** 里：某个
// 窗格引用了这个 ptyId，这个 PTY 就归它那个窗口。
//
// 不变式：**每个存活的 PTY 恰好被一个窗口的 store 引用**，唯一的例外是标签交接期间——
// 新窗口 adoptTerminalTab 在前、旧窗口 removeTabKeepingPty 在后，这段重叠是**刻意**的
// （宁可短暂地两边都有，也绝不允许出现两边都没有）。
//
// 于是「谁有权 kill 一个 PTY」只有四条路径，每一条都必须与上面这条不变式自洽：
//
//   1. ⌘W / × 关标签或窗格（store/tabs.ts 的 closeTab/closePane）
//      → 持有它的那个窗口，只杀这个窗格自己的 PTY；
//      → **交接中的标签除外**：那一刻新窗口可能已经接管，见 handoffLock.ts。
//   2. 关闭一个非主窗口（本文件）
//      → 那个窗口自己，只杀**它的 store 里**的存活 PTY，且同样跳过交接中的标签；
//      → 别的窗口的 PTY 一个都不碰——这正是 §5.3 要修的那条单窗口假设。
//   3. 关闭主窗口 / ⌘Q / Quit 菜单（src/closeRequest.ts）
//      → 等于退出整个应用，全部 PTY 随进程一起终止；确认框的数字因此必须是**全应用**
//        的（pty_alive_count），不能只数本窗口。
//   4. 标签交接回滚（src/windowHandoff.ts 的 closeSpawnedWindow）
//      → **谁都不杀**。它用 destroy_term_window 绕过整条关窗流程，理由见那里：回滚方
//        无法知道新窗口到底接管成功没有（ack 就是那条丢掉的信息），而"销毁窗口但一个
//        PTY 都不动"在两个分支下都正确。
//
// ## 为什么关窗要绕一趟前端
//
// 因为归属只有前端知道（见上）。Rust 侧的 on_window_event 对非主窗口 prevent_close 之后
// 把决定权交给这个模块，与主窗口走 prevent_close → src/closeRequest.ts → confirm_exit
// 是**同一套**既有模式，不是新引入的机制。代价是"前端卡死则窗口关不掉"，与主窗口那条
// 路径同样的代价，且用户仍可用 ⌘Q（主窗口那条路径）退出应用。
import { listen } from '@tauri-apps/api/event'
import { isHandoffInFlight } from './handoffLock'
import { destroyTermWindow, ptyIsAlive, ptyKill } from './ipc'
import { useTabs } from './store/tabs'
import { currentWindowLabel, isTornOutWindow } from './windowLabel'

/** Rust 侧 emit_window_close_requested 用的事件名：**只发给要关的那个窗口**。 */
export const WINDOW_CLOSE_EVENT = 'window-close-requested'

/** 纯函数：关闭一个终端窗口前的确认文案。与 buildExitConfirmMessage（关闭整个应用）
 *  刻意用不同措辞——这两件事的后果差着一整个应用，文案必须让用户一眼看出自己在关的是
 *  哪个。0 个存活会话时根本不弹确认（见 handleWindowCloseRequested），所以这里不需要
 *  "没有会话"那一档文案。 */
export function buildWindowCloseConfirmMessage(liveCount: number): string {
  return `还有 ${liveCount} 个会话在运行，关闭这个窗口会终止它们。确定关闭？`
}

/** 本窗口**自己持有**的 PTY id（可能已经死了，存活与否由调用方再查一次）。
 *
 *  跳过交接中的标签：那些标签的 PTY 此刻**可能已经属于另一个窗口**（新窗口 adopt 在前、
 *  本窗口 removeTabKeepingPty 在后）。把它们算进来就会在关窗时杀掉别人刚接管的会话——
 *  与 closeTab 那道闸门挡的是同一件事，只是入口不同。跳过的代价：交接正好进行到一半时
 *  关掉发起方窗口，那个 PTY 不会被 kill；但它要么已被新窗口接管（本就不该杀），要么
 *  交接随即失败、成为后台孤儿——用 ⌘Q 退出应用即可清理，比误杀一个正在跑的会话轻得多。 */
export function ownedPtyIds(): string[] {
  return useTabs
    .getState()
    .tabs.filter((t) => t.kind === 'term' && !isHandoffInFlight(t.id))
    .flatMap((t) => t.panes.map((p) => p.ptyId))
    .filter((id): id is string => Boolean(id))
}

// 与 closeRequest.ts 的 confirmationInFlight 同一个理由：确认框还开着时用户又点了一次
// 关闭按钮，Rust 侧会老老实实再 emit 一次 window-close-requested，没有这个标志位就会
// 堆出第二个对话框。
let closeInFlight = false

/** 收到"这个窗口被请求关闭"之后的完整流程：清点自己持有的存活会话 → 有的话弹确认 →
 *  终止它们 → 真正关掉窗口。
 *
 *  导出是为了让测试直接 await 完整流程（与 handleCloseRequested 同一惯例）。
 *
 *  顺序是硬要求：**先 kill，再 destroy**。反过来的话窗口一销毁，这段 JS 上下文连同还
 *  没发出去的 ptyKill 一起没了，会话变成没有任何窗口能看到、也关不掉的后台孤儿。
 *
 *  用户在确认框上点"取消"：直接返回，窗口留着（Rust 侧已经 prevent_close 过了，不做
 *  任何事就等于取消这次关闭）。 */
export async function handleWindowCloseRequested(): Promise<void> {
  if (closeInFlight) return
  closeInFlight = true
  try {
    const label = await currentWindowLabel()
    // 主窗口不走这条路：它的关闭 = 退出应用，归 closeRequest.ts 那条既有路径管。Rust
    // 侧也不会给主窗口发这个事件——这里再挡一次是因为定向投递本身不可靠（不传 target
    // 的 listen 是 Any 目标，对 emit_to 的 label 过滤无条件命中，考据见 windowHandoff.ts
    // 顶部）。漏掉这一层，主窗口会在别的窗口关闭时把**自己**的会话全 kill 掉再自毁。
    if (!isTornOutWindow(label)) return
    const owned = ownedPtyIds()
    const alive = await Promise.all(owned.map((id) => ptyIsAlive(id).catch(() => false)))
    const liveIds = owned.filter((_, i) => alive[i])
    if (liveIds.length > 0) {
      const { confirm } = await import('@tauri-apps/plugin-dialog')
      const ok = await confirm(buildWindowCloseConfirmMessage(liveIds.length), { title: 'aTerm' })
      if (!ok) return
      // 并发终止：互相独立的 kill 没有理由排队（与 closeTab 里同一写法）。单个失败不该
      // 拖垮其余的，也不该让窗口关不掉——已经死掉的 PTY 会让 pty_kill 返回 Err。
      await Promise.all(liveIds.map((id) => ptyKill(id).catch((err) => { console.warn('关窗终止会话失败', id, err) })))
    }
    await destroyTermWindow(label)
  } catch (err) {
    console.error('关闭窗口失败', err)
  } finally {
    closeInFlight = false
  }
}

/** 模块顶层注册（App.tsx 顶层 side-effect 导入触发），与 closeRequest.ts /
 *  windowHandoff.ts 同一模式：在用户有机会点关闭按钮之前就得挂好。
 *
 *  主窗口不注册：它压根收不到这个事件，也不该处理它。
 *  target 必须限定成本窗口，理由同 closeRequest.ts 里那一段——不限定的话每个终端窗口
 *  都会对**别的**窗口的关闭请求做出反应，各自杀掉自己的会话再自毁。 */
export const windowCloseReady: Promise<void> = (async () => {
  const label = await currentWindowLabel()
  if (!isTornOutWindow(label)) return
  await listen(WINDOW_CLOSE_EVENT, handleWindowCloseRequested, { target: label })
})()
  .then(() => undefined)
  .catch((err) => { console.error('窗口关闭监听注册失败', err) })
