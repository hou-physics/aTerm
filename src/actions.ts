import type { ThreadInfo } from './ipc'
import { useTabs } from './store/tabs'

export const resumeThread = (cwd: string, t: ThreadInfo) => {
  if (useTabs.getState().focusThread(t.rootKey)) return
  return useTabs.getState().openTerminal({ title: t.title, cwd, inject: `claude --resume ${t.resumeSessionId}`, threadKey: t.rootKey })
}

export const newConversation = (cwd: string) =>
  useTabs.getState().openTerminal({ title: '新对话', cwd, inject: 'claude' })

export const runCommand = (cmd: string) => {
  const c = cmd.trim()
  return useTabs.getState().openTerminal(c ? { title: c.slice(0, 24), inject: c } : { title: 'zsh' })
}
