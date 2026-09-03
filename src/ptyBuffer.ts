import { listen } from '@tauri-apps/api/event'
import { b64ToBytes } from './b64'

type Sink = (bytes: Uint8Array) => void

/** 某个 PTY 的待回放缓冲。
 *
 *  `chunks[0, pinned)` 是 seedScrollback 塞进来的**交接滚屏快照**：它不是"等着终端挂载
 *  的实时输出"，而是旧窗口整段历史的唯一副本，丢了就再也拿不回来（旧窗口那边的
 *  xterm 实例随标签一起没了）。因此它不计入上限、也永远不参与淘汰。
 *  `chunks[pinned, …)` 是 pty-output 实时路径攒下的，字节数记在 `liveBytes` 里，受
 *  MAX_BUFFERED_BYTES 约束。 */
type Pending = { chunks: Uint8Array[]; pinned: number; liveBytes: number }

// 单个 PTY 的待回放缓冲上限（只统计实时路径攒下的部分，见 Pending）。
//
// ## 为什么必须有上限（V3.3 全分支终审 Ruling 19 / I1）
//
// pty-output 是 `app.emit` 全应用广播（src-tauri/src/pty.rs），**每个**窗口都会收到
// **所有**窗口的 PTY 输出。在窗口 Y 里，窗口 X 的 ptyId 既不在 sinks（Y 没有那个终端）
// 也不在 ignored（ignorePtyOutput 只对本窗口主动交接出去的 id 调用），于是每一条都落进
// 下面的 else 分支进 buffers——而 Y 永远不会 attachPty 那个 id，没有任何路径会清空它，
// pty-exit 也不清。两个窗口各自把对方每个 PTY 的输出永久攒在 JS 堆里，Claude Code 跑在
// alt-screen、全屏重绘频繁，挂几小时就能堆到几百 MB，最终 WKWebView OOM——**那时才真的
// 丢会话**。
//
// V3.3 之前不存在这个问题：TerminalLayer 对**所有**标签（不只激活的那个）都渲染
// <TerminalView>，单窗口下每个 PTY 恒有 sink，else 分支只在"已 spawn、尚未挂载"这个
// 毫秒级空档里走到。
//
// ## 为什么选"上限 + 丢最旧"而不是"只为本窗口认领过的 id 缓存"
//
// 白名单（在 ptySpawn 成功、adoptTerminalTab 时登记 id）能把外来 PTY 的开销压到零，但
// 它引入第二份"这个 PTY 归谁"的真相，必须与三处以上的认领点保持同步；**漏掉一处的后果
// 是本窗口自己的终端在挂载前的输出被静默丢弃**（用户看不到 claude 启动那几百毫秒的画
// 面，且毫无报错线索）。上限是关于 id 的全函数，不需要知道任何归属信息，漏不掉；它的
// 失败模式只是"外来 id 各占至多上限这么多字节"，有界且不可见。终审也把上限列为**必须
// 做的主安全网**，正是因为它对"将来某条认领路径被漏掉"是健壮的。
//
// ## 上限值的依据：2 MiB
//
// 这个缓冲的正当用途只有一段——从 pty_spawn 返回到 <TerminalView> 的 effect 调用
// attachPty，即一次 React state 更新 + 渲染 + effect，正常是毫秒级。这段时间里 PTY 能
// 吐多少？最坏情况是 Claude Code 的 alt-screen 全屏重绘：一屏 250×80 且每个单元格都带
// SGR 属性，一次全量重绘约 100 KB 量级。2 MiB ≈ 20 次这样的全屏重绘，等于给"主线程被
// 别的事情占满、挂载被拖到好几秒"留足了余量。
// 另一头，它把病态情形钉死在「外来 PTY 数 × 2 MiB」——十几个外来 PTY 也就几十 MB，比
// 会触发 WKWebView OOM 的几百 MB 低一个数量级，而且**不随时间增长**（增长才是缺陷本身）。
export const MAX_BUFFERED_BYTES = 2 * 1024 * 1024

const sinks = new Map<string, Sink>()
const buffers = new Map<string, Pending>()
const exited = new Set<string>()
const exitSinks = new Map<string, () => void>()
// 已经交接给别的窗口、本窗口不再关心其输出的 PTY（V3.3 Task 4 R2/I3）。
//
// pty-output 是 app.emit 全应用广播（pty.rs:28），交接之后这个 PTY 的输出仍然会源源不断
// 送到旧窗口；而旧窗口的标签已经移除、TerminalView 已卸载（sinks 里没有它了），于是每
// 一条都被 else 分支塞进 buffers——而旧窗口**再也不会** attachPty 这个 id，没有任何路径
// 会清空它。把一个持续刷屏的会话拖出去，原窗口的内存就随该会话的输出量无限增长。
//
// 这是"移除标签但不 kill PTY"这条新路径独有的问题：此前唯一移除终端标签的路径是
// closeTab，它会 kill 掉 PTY，输出自然就停了。
//
// 只丢弃、不 unlisten：监听是所有 PTY 共用的一个全局监听器，不能为某一个 id 摘掉。
const ignored = new Set<string>()

/** 把一块实时输出排进待回放缓冲，并把该 id 的实时部分维持在 MAX_BUFFERED_BYTES 以内。
 *
 *  超出时**从最旧的实时块开始丢**：终端要的是"接上最近的画面"，而不是几小时前的一段
 *  历史；alt-screen 应用更是只有最新那几帧有意义。
 *
 *  淘汰起点是下标 `pinned`，跳过交接滚屏那几块（见 Pending）；`chunks.length > pinned + 1`
 *  保证**至少留下最新的一块**——一块就超过上限时（比如一次超大 paste 的回显）宁可越限
 *  也不要把它变成空回放，否则用户看到的是一个完全空白的终端。 */
function pushBuffered(id: string, bytes: Uint8Array): void {
  const p = buffers.get(id) ?? { chunks: [], pinned: 0, liveBytes: 0 }
  p.chunks.push(bytes)
  p.liveBytes += bytes.length
  while (p.liveBytes > MAX_BUFFERED_BYTES && p.chunks.length > p.pinned + 1) {
    const [dropped] = p.chunks.splice(p.pinned, 1)
    p.liveBytes -= dropped.length
  }
  buffers.set(id, p)
}

export const ptyEventsReady: Promise<void> = (async () => {
  await listen<{ id: string; data: string }>('pty-output', (e) => {
    if (ignored.has(e.payload.id)) return // 已交接出去：直接丢弃，既不投递也不缓存
    const bytes = b64ToBytes(e.payload.data)
    const sink = sinks.get(e.payload.id)
    if (sink) sink(bytes)
    else pushBuffered(e.payload.id, bytes)
  })
  await listen<{ id: string; code: number }>('pty-exit', (e) => {
    exited.add(e.payload.id)
    exitSinks.get(e.payload.id)?.()
  })
})().then(() => undefined).catch((err) => { console.error('pty 事件监听注册失败', err) })

// 跨窗口交接（V3.3 设计文档 §4.2，见 src/windowHandoff.ts）的第一步：丢弃该 PTY 已经
// 攒下的待回放缓冲。
//
// R1 之前的顺序是「建窗前序列化」，空档是整个建窗时间（数百毫秒）；R1 改成「收到新窗口
// 的就绪事件之后才序列化」，空档缩到一次 IPC 往返，但代价是这段时间新窗口的 ptyBuffer
// 已经在攒实时输出了——那部分内容同时也在快照里，直接回放会**重复**。Claude Code 跑在
// alt-screen，重复的转义序列会把画面搞乱，比丢一小段更糟。
//
// 所以接管端必须：先 discardBuffered、再 seedScrollback、再让 TerminalView 去 attachPty。
// 三步之间不留可插入的时机（都在 handleHandoff 的同一个同步块里），缓冲被清空之后
// attachPty 的既有回放逻辑自然不会重放任何旧内容，此后的实时输出照常流入。
//
// 只丢缓冲，不碰 sinks/exited/exitSinks：这里要抹掉的是"交接期间攒下的、快照里已经
// 有的那份重复"，不是这个 PTY 的其它任何状态。
export function discardBuffered(id: string): void {
  buffers.delete(id)
}

/** 登记"这个 PTY 已经交接给别的窗口了，本窗口此后收到它的输出一律丢弃"。
 *
 *  与 discardBuffered 成对使用（见 windowHandoff.ts 交接成功那一步）：前者清掉已经攒下
 *  的，后者挡住此后还会不断到来的。只清一次是不够的——广播不会停。 */
export function ignorePtyOutput(id: string): void {
  ignored.add(id)
  buffers.delete(id)
}

// 交接的第二步：把旧窗口序列化出来的滚屏排进这个 PTY 待回放缓冲的**最前面**，而不是
// 直接写进终端。理由是时序：新窗口这边此刻还没有任何 <TerminalView> 挂载（标签是紧接着
// 这一步才进 store 的），拿不到 term 实例可写。unshift 而不是 push：紧随其后到达的实时
// 输出必须排在快照之后，随后 TerminalView 挂载时 attachPty 的既有回放逻辑（上面那一行
// replayed.forEach(sink)）就会先写历史、再写新输出，顺序天然正确——不需要在
// TerminalView（受保护文件）里加任何"交接专用"的写入口。
//
// （按 R1 的顺序，调用它之前刚刚 discardBuffered 过，队列本应是空的；unshift 仍然是对的
// 语义，它不依赖"队列一定为空"这个前提。）
//
// sinks 里已经有该 id 的接收者时直接写给它：这在正常交接流程里不会发生（seed 恒在
// 建标签之前），但如果真发生了，塞进 buffers 的内容会永远没人取走（attachPty 只在
// 挂载那一刻取一次），滚屏就凭空丢了——宁可顺序退化，也不要丢内容。
export function seedScrollback(id: string, text: string): void {
  if (!text) return
  const bytes = new TextEncoder().encode(text)
  const sink = sinks.get(id)
  if (sink) { sink(bytes); return }
  const p = buffers.get(id) ?? { chunks: [], pinned: 0, liveBytes: 0 }
  p.chunks.unshift(bytes)
  // 记进 pinned：这一块**不计入** MAX_BUFFERED_BYTES、也永不被 pushBuffered 淘汰。
  // 它是旧窗口整段滚屏的唯一副本（可以有好几 MB——xterm 的 scrollback 是 10000 行），
  // 若按普通实时块对待，交接期间紧随其后到达的实时输出会立刻把它挤出去，接管方得到
  // 一个没有任何历史的终端——正是这个函数存在的目的被反过来抵消掉。
  p.pinned += 1
  buffers.set(id, p)
}

export function attachPty(id: string, sink: Sink, onExit: () => void): () => void {
  // 本窗口重新为这个 id 挂上终端 ⇒ 它显然又关心这个 PTY 的输出了，撤销 ignorePtyOutput
  // 的登记。当前版本（V3.3）不支持把标签从别的窗口拖回来，正常不会走到这里；写上是为了
  // 让"已忽略"不是一个此进程内再也无法恢复的终态——否则以后真做了"拖回来"，会得到一个
  // 静默不刷新的死终端，而且完全没有报错线索。
  ignored.delete(id)
  const pending = buffers.get(id)
  const replayed = pending?.chunks ?? []
  buffers.delete(id)
  replayed.forEach(sink)
  let live = false
  sinks.set(id, (bytes) => { live = true; sink(bytes) })
  exitSinks.set(id, onExit)
  if (exited.has(id)) onExit()
  return () => {
    // 整个 Pending 记录原样放回（不是重新包一个）：pinned / liveBytes 与 chunks 必须
    // 保持一致，否则恢复之后的第一次淘汰会按错误的起点和计数去删。
    if (!live && pending && replayed.length > 0) buffers.set(id, pending)
    sinks.delete(id)
    exitSinks.delete(id)
  }
}
