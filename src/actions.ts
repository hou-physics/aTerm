import type { ThreadInfo } from './ipc'
import { useTabs } from './store/tabs'

// `crypto.randomUUID()` 在 WebCrypto 规范里标注 `[SecureContext]`：不在安全上下文里，
// 这个方法根本不存在（`crypto.randomUUID` 读出来是 `undefined`），调用会直接抛
// TypeError。`tauri dev` 走 http://localhost:1420，是安全上下文，本地开发完全看不出
// 问题；但打包版走 tauri://localhost，而 wry 只在 webkitgtk（Linux）那条路上调用了
// `register_uri_scheme_as_secure` 把这个自定义 scheme 登记为安全的——wkwebview
// （macOS）目录下没有对应调用。于是打包版在 macOS 上 `crypto.randomUUID` 是
// undefined，下面 newConversationSpec 里的调用直接抛异常，主页「＋ 新对话」和窗格
// 选择器里的「新对话」两个入口点了都没反应，且现象只在打包版出现、`tauri dev` 里
// 永远复现不了。
// `crypto.getRandomValues()` 不受安全上下文限制，因此在 randomUUID 缺失时退回用它
// 手工拼一个 RFC 4122 v4 uuid（版本位固定为 4，变体位固定为 10xx）。
// 如果你在读这段注释是因为想把 fallback 分支删掉当作"死代码"——请先在打包版
// （非 `tauri dev`）里实测 macOS，而不是只跑一遍本地开发模式；这正是这段代码最容易
// 被"简化"掉、然后在发布后才炸的地方。
export function randomUuidV4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // 版本位：0100
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // 变体位：10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const resumeThread = (dirName: string, cwd: string, t: ThreadInfo) => {
  // rootKey 仅在单个项目目录内保证唯一（见 Rust 侧 sessions/scan.rs 按目录分组），
  // 跨项目需以「项目:会话」复合键去重，避免误切到同名会话所在的其他项目终端。
  const threadKey = `${dirName}:${t.rootKey}`
  if (useTabs.getState().focusThread(threadKey)) return
  return useTabs.getState().openTerminal({
    // titled 为 false 时 t.title 是 session_id 前 8 位的回退值（scan.rs）——直接拿它
    // 当标签标题会让用户看到一串十六进制。对账（reconcilePanes，store/tabs.ts）要等
    // 到下一次刷新或改名才会追上，不能指望它兜底修正窗格创建这一刻的标题，所以必须
    // 在这个唯一的写入点就把标题定对。
    title: t.titled ? t.title : '新对话', cwd, inject: `claude --resume ${t.resumeSessionId}`,
    threadKey, dirName, rootKey: t.rootKey,
    // resumeSessionId 必在该链的 sessionIds 里，所以带上它之后，--resume 起的窗格
    // 也能被 reconcilePanes 对账——修掉「被 resume 的链此前无用户消息、发第一句话
    // 后 rootKey 翻转导致该窗格永久失联」这个缺口（V3.0 终审留账）。
    sessionId: t.resumeSessionId,
  })
}

// 新对话的唯一构造点。两个入口（主页的「＋ 新对话」、窗格选择器的「新对话」）都必须
// 走它——PanePicker.tsx 此前自己写死 `inject: 'claude'`，绕过了身份绑定，导致窗格
// 选择器里新建的对话同样认不出自己是谁。
//
// 为什么要自己指定 session id：窗格必须在进程启动前就知道自己的身份，否则一切按
// threadKey 认人的逻辑（focusThread 去重、标签标题、对话面板、底栏模型）全部落空。
// 见 spec §2.1 与 §3.1。
export function newConversationSpec(cwd: string): { title: string; cwd: string; inject: string; sessionId: string } {
  const sessionId = randomUuidV4()
  return { title: '新对话', cwd, inject: `claude --session-id ${sessionId}`, sessionId }
}

export const newConversation = (cwd: string) =>
  useTabs.getState().openTerminal(newConversationSpec(cwd))

// 主页项目卡片的「总览」入口（Task 12）：Task 1–11 建好了总览页的全部能力，但没有
// 任何一处 UI 调用 openOverview——功能存在却无法抵达。与上面几个 action 同一惯例，
// 薄薄包一层 useTabs.getState()，组件只管调用、不直接碰 store。
export const openProjectOverview = (dirName: string, projectName: string) =>
  useTabs.getState().openOverview(dirName, projectName)

export const runCommand = (cmd: string) => {
  const c = cmd.trim()
  return useTabs.getState().openTerminal(c ? { title: c.slice(0, 24), inject: c } : { title: 'zsh' })
}

// 新建一个空白登录 shell 标签（＋ 按钮、⌘T 共用的入口）
export const newTerminal = () => runCommand('')
