// 「这个标签正在移交给另一个窗口」这把锁（V3.3：Task 4 R2/M6 起，Task 5 / Ruling 12 扩用）。
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
