import { useSessions } from '../store/sessions'
import { useTabs } from '../store/tabs'
import { basename, formatRelative } from '../time'

// ⌘D 新建的窗格在选定会话之前显示的选择列表（设计文档 §5-A）：新终端 / 新对话 /
// 最近会话。数据源直接复用 useSessions（HomePage.tsx、Sidebar.tsx 用的同一个 store），
// 不重新发起 IPC 拉取；"最近会话"的排序/截取写法与 Sidebar.tsx 的写法一致
// （按 lastActivityMs 倒序取前 8 条），但这只是数组变换，不是"拉取逻辑"本身。
export function PanePicker({ tabId, paneId }: { tabId: string; paneId: string }) {
  const { projects } = useSessions()
  const recent = projects
    .flatMap((p) => p.threads.map((t) => ({ p, t })))
    .sort((a, b) => b.t.lastActivityMs - a.t.lastActivityMs)
    .slice(0, 8)

  const startZsh = () => void useTabs.getState().startPaneTerminal(tabId, paneId, { title: 'zsh' })
  const startNewConversation = () => void useTabs.getState().startPaneTerminal(tabId, paneId, { title: '新对话', inject: 'claude' })
  const startResume = (p: (typeof recent)[number]['p'], t: (typeof recent)[number]['t']) =>
    void useTabs.getState().startPaneTerminal(tabId, paneId, {
      title: t.title,
      cwd: p.cwd,
      inject: `claude --resume ${t.resumeSessionId}`,
      threadKey: `${p.dirName}:${t.rootKey}`,
      dirName: p.dirName,
      rootKey: t.rootKey,
    })

  return (
    <div className="pane-picker">
      <div className="pane-picker-item" onClick={startZsh}>新终端（zsh）</div>
      <div className="pane-picker-item" onClick={startNewConversation}>新对话</div>
      {recent.length > 0 && (
        <>
          <div className="pane-picker-label">最近会话</div>
          {recent.map(({ p, t }) => (
            <div key={`${p.dirName}:${t.rootKey}`} className="pane-picker-item" onClick={() => startResume(p, t)}>
              <div className="t">{t.title}</div>
              <div className="sub">{basename(p.cwd)} · {formatRelative(t.lastActivityMs)}</div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
