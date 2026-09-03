// 交接期间的进程内状态：「这个标签正在移交给另一个窗口」这把锁（V3.3：Task 4 R2/M6 起，
// Task 5 / Ruling 12 扩用），以及「本窗口已经决定自毁」这面旗（V3.4 修复轮 R2 / M1）。
//
// 两件状态放同一个模块是同一条理由（见下一节）：都不依赖任何东西、都被 windowHandoff 与
// 别的模块共用、都必须能在单测里独立驱动和复位。
//
// ## 为什么它必须是一个独立模块
//
// 锁原本是 windowHandoff.ts 里的一个模块级 Set。Task 5 之后读它的还有 store/tabs.ts
// （closeTab/closePane 要在交接期间拒绝关闭）与 windowClose.ts（关窗清点自己持有的 PTY
// 时要跳过交接中的标签）。而 windowHandoff.ts 自己 import 了 store/tabs——让 tabs.ts 反
// 过来 import windowHandoff 就是一个 import 环，且 windowHandoff 的模块顶层有副作用
// （注册接管监听、广播就绪事件），那样每一个只想用 store 的入口/测试都会顺带发起一次
// 握手注册。锁本身没有任何依赖，摘出来是最省事、也最容易单测的做法。
//
// ## 它挡的是什么（Ruling 12 / 原 M7）
//
// 整个握手是异步的：建窗 + 等就绪（最长 10s）+ 等接管确认（最长 5s）。这段时间里标签
// **仍然留在旧窗口的标签栏里、照样可见可点**，于是：
//   - 用户可以再拖它一次 → 并发建出第二个窗口、发第二份载荷，两次交接争同一个标签
//     （Task 4 R2/M6 加锁的原因）；
//   - 用户可以按 ⌘W / 点 × 关掉它 → closeTab 走 ptyKill，而新窗口此刻**可能已经接管
//     成功**（ack 还在路上），杀掉的就是用户正在跑的 claude 会话（Ruling 12）。
//
// ## 释放是硬要求
//
// 锁没释放 = 那个标签**永久关不掉**（closeTab 会一直早退），比它挡的问题更糟。因此
// tearOutTab 里从 begin 到 end 之间的全部代码——包括两次 listen()、建窗、两次带超时的
// 等待、以及全部回滚分支——都必须在同一个 try/finally 内。src/__tests__/handoffLock.test.ts
// 与 windowHandoff.test.ts 里"锁在每一条路径上都释放"那一组用例专门钉这一条。

const inFlight = new Set<string>()

/** 尝试为 tabId 上锁。返回 false 表示这个标签已经在交接中——调用方应当整个放弃这次
 *  发起，**且不要去调 endHandoff**（那会把正在进行的那一次的锁误放掉）。 */
export function beginHandoff(tabId: string): boolean {
  if (inFlight.has(tabId)) return false
  inFlight.add(tabId)
  return true
}

/** 释放 tabId 的锁。对没上过锁的 id 是安全的空操作（Set.delete 本就如此），因此可以
 *  无条件放在 finally 里。 */
export function endHandoff(tabId: string): void {
  inFlight.delete(tabId)
}

/** 这个标签此刻是否正在交接。store/tabs.ts 的 closeTab/closePane 与 windowClose.ts
 *  用它决定"这个标签的 PTY 现在不归我一个人说了算"。 */
export function isHandoffInFlight(tabId: string): boolean {
  return inFlight.has(tabId)
}

// ── 「本窗口已经决定自毁」（V3.4 修复轮 R2 / M1）────────────────────────────────
//
// `destroy_term_window` 是一次 IPC：命令发出到 Rust 真的销毁窗口之间隔着至少一次让出。
// 别的窗口的交接载荷若恰好落在这个空档里（A→B 与 B→A 同时发生就是自然触发器），
// windowHandoff 的 handleHandoff 会照常建出标签、回 ack，发起方据此删掉自己那份——而这个
// 窗口紧接着就没了。destroy **绕过 CloseRequested、一个 PTY 都不杀**，那个会话于是变成谁
// 都看不到、也关不掉的孤儿，标签两边都没有。
//
// 为什么必须是一面旗、而不是"destroy 之前再查一次还有没有终端标签"：那次检查与
// `await destroyTermWindow(label)` 在同一个同步块里，中间没有任何让出点，第二次查到的必然
// 与第一次一模一样（实测加上它，windowHandoff.test.ts 那条探针用例仍然是红的）。真正的空
// 档在 await **之后**、销毁生效**之前**，那时已经没有地方可查，唯一能落在这个区间里的动作
// 就是"从现在起拒收"。
//
// 放在这里而不是 windowHandoff.ts 的一个模块级 let：那样它跨用例不可复位，一条成功自毁的
// 用例会把旗子永久留成 true，后面所有接管用例都在一个被污染的前提下跑——而且**变异会因此
// 测不出来**（把置位挪到 destroy 之后，探针仍然绿，因为它读到的是上一条用例留下的 true）。
// 这里导出的复位函数本身就是生产代码要用的那一个（自毁失败时调用），不是测试后门。

let selfDestructing = false

/** 本窗口从此刻起拒收交接载荷。在**发出** destroy 命令之前调用——空档就在它后面。 */
export function beginSelfDestruct(): void {
  selfDestructing = true
}

/** 撤销上面那个决定。destroy 失败 = 窗口还活着，必须放下旗子，否则这个窗口从此永远收不了
 *  任何交接，一次失败的自毁会把它变成黑洞。**只在失败分支调用**：成功分支里窗口马上就没
 *  了，复位反而会把那个空档重新打开。 */
export function abortSelfDestruct(): void {
  selfDestructing = false
}

/** 本窗口是否已经决定自毁。windowHandoff 的 handleHandoff 用它决定要不要拒收载荷
 *  （拒收 = 不建标签、也不回 ack，让发起方走它自己的超时回滚，标签留在原处）。 */
export function isSelfDestructing(): boolean {
  return selfDestructing
}
