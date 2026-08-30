import { newConversationSpec } from '../actions'
import { useSessions } from '../store/sessions'
import { type Tab, useTabs } from '../store/tabs'
import { type SessionPick, SessionPicker } from './SessionPicker'

// ⌘D 新建的窗格在选定会话之前显示的选择列表：界面本体见 SessionPicker.tsx，这里
// 只负责窗格侧的两件事——推断「新对话」的默认项目、把选中结果落地为
// startPaneTerminal 调用。
export function PanePicker({ tab, paneId }: { tab: Tab; paneId: string }) {
  const { projects } = useSessions()
  const tabId = tab.id

  // 「新对话」默认目录：找到拆分出本窗格的来源窗格——addPane 总是把新窗格插在
  // 被拆分窗格右侧紧邻的一位（见 store/tabs.ts 的 insertAt = idx + 1），所以本窗格
  // 在 panes 数组里的前一个就是那个来源窗格。它若带 dirName（说明是一个对话窗格）
  // 就直接复用其项目，不需要用户再选一次；否则（比如来源是普通 zsh 终端，或本
  // 窗格是标签的第一个窗格）就没有"当前聚焦窗格所属项目"可言，退化为列出全部
  // 项目供选择。
  const ownIndex = tab.panes.findIndex((p) => p.id === paneId)
  const sourcePane = ownIndex > 0 ? tab.panes[ownIndex - 1] : undefined
  const defaultProject = sourcePane?.dirName ? projects.find((p) => p.dirName === sourcePane.dirName) : undefined

  const onPick = (pick: SessionPick) => {
    const start = useTabs.getState().startPaneTerminal
    if (pick.kind === 'shell') {
      void start(tabId, paneId, { title: 'zsh' })
      return
    }
    if (pick.kind === 'newConversation') {
      void start(tabId, paneId, newConversationSpec(pick.project.cwd))
      return
    }
    const { project: p, thread: t } = pick
    void start(tabId, paneId, {
      title: t.title,
      cwd: p.cwd,
      inject: `claude --resume ${t.resumeSessionId}`,
      threadKey: `${p.dirName}:${t.rootKey}`,
      dirName: p.dirName,
      rootKey: t.rootKey,
      sessionId: t.resumeSessionId,
    })
  }

  return <SessionPicker defaultProject={defaultProject} onPick={onPick} />
}
