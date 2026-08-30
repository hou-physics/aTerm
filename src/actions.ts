import type { ThreadInfo } from './ipc'
import { useTabs } from './store/tabs'

export const resumeThread = (dirName: string, cwd: string, t: ThreadInfo) => {
  // rootKey 仅在单个项目目录内保证唯一（见 Rust 侧 sessions/scan.rs 按目录分组），
  // 跨项目需以「项目:会话」复合键去重，避免误切到同名会话所在的其他项目终端。
  const threadKey = `${dirName}:${t.rootKey}`
  if (useTabs.getState().focusThread(threadKey)) return
  return useTabs.getState().openTerminal({ title: t.title, cwd, inject: `claude --resume ${t.resumeSessionId}`, threadKey, dirName, rootKey: t.rootKey })
}

// 新对话的唯一构造点。两个入口（主页的「＋ 新对话」、窗格选择器的「新对话」）都必须
// 走它——PanePicker.tsx 此前自己写死 `inject: 'claude'`，绕过了身份绑定，导致窗格
// 选择器里新建的对话同样认不出自己是谁。
//
// 为什么要自己指定 session id：窗格必须在进程启动前就知道自己的身份，否则一切按
// threadKey 认人的逻辑（focusThread 去重、标签标题、对话面板、底栏模型）全部落空。
// 见 spec §2.1 与 §3.1。
export function newConversationSpec(cwd: string): { title: string; cwd: string; inject: string; sessionId: string } {
  const sessionId = crypto.randomUUID()
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
