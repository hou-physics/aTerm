import { useState } from 'react'
import { newConversation, resumeThread, runCommand } from '../actions'
import { useSessions } from '../store/sessions'
import { basename, formatRelative } from '../time'

export function HomePage() {
  const { projects } = useSessions()
  const [cmd, setCmd] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <div className="home">
      <input
        className="cmd-input"
        placeholder="输入命令，回车在新标签页运行…（留空回车 = 新终端）"
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { void runCommand(cmd); setCmd('') } }}
      />
      <div className="section-label">最近项目</div>
      <div className="cards">
        {projects.map((p) => (
          <div key={p.dirName} className="card" onClick={() => setExpanded(expanded === p.dirName ? null : p.dirName)}>
            <div className="name">📁 {basename(p.cwd)}</div>
            <div className="sub">{p.threads.length} 个会话 · {formatRelative(p.lastActivityMs)}</div>
            {expanded === p.dirName && (
              <div className="thread-list" onClick={(e) => e.stopPropagation()}>
                {p.threads.slice(0, 8).map((t) => (
                  <div key={t.rootKey} className="thread-row" onClick={() => void resumeThread(p.cwd, t)}>
                    <span className="t">{t.title}</span>
                    <span className="time">{formatRelative(t.lastActivityMs)}</span>
                  </div>
                ))}
                <div className="thread-row new-conv" onClick={() => void newConversation(p.cwd)}>＋ 新对话</div>
              </div>
            )}
          </div>
        ))}
        {projects.length === 0 && <div className="sub">尚未发现 Claude Code 会话（~/.claude/projects 为空）</div>}
      </div>
    </div>
  )
}
