import type { ThreadInfo } from './ipc'
import { useTabs } from './store/tabs'

export const resumeThread = (dirName: string, cwd: string, t: ThreadInfo) => {
  // rootKey 仅在单个项目目录内保证唯一（见 Rust 侧 sessions/scan.rs 按目录分组），
  // 跨项目需以「项目:会话」复合键去重，避免误切到同名会话所在的其他项目终端。
  const threadKey = `${dirName}:${t.rootKey}`
  if (useTabs.getState().focusThread(threadKey)) return
  return useTabs.getState().openTerminal({ title: t.title, cwd, inject: `claude --resume ${t.resumeSessionId}`, threadKey, dirName, rootKey: t.rootKey })
}

export const newConversation = (cwd: string) =>
  useTabs.getState().openTerminal({ title: '新对话', cwd, inject: 'claude' })

export const runCommand = (cmd: string) => {
  const c = cmd.trim()
  return useTabs.getState().openTerminal(c ? { title: c.slice(0, 24), inject: c } : { title: 'zsh' })
}

// 新建一个空白登录 shell 标签（＋ 按钮、⌘T 共用的入口）
export const newTerminal = () => runCommand('')
