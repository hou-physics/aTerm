import { useState } from 'react'
import { newConversation, resumeThread, runCommand } from '../actions'
import type { ProjectInfo, ThreadInfo } from '../ipc'
import { useSessions } from '../store/sessions'
import { useProjectStatus, useThreadStatus } from '../store/status'
import { basename, formatRelative } from '../time'
import { StatusDot } from './StatusDot'

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
          <ProjectCard
            key={p.dirName}
            project={p}
            expanded={expanded === p.dirName}
            onToggle={() => setExpanded(expanded === p.dirName ? null : p.dirName)}
          />
        ))}
        {projects.length === 0 && <div className="sub">尚未发现 Claude Code 会话（~/.claude/projects 为空）</div>}
      </div>
    </div>
  )
}

// 拆成独立组件只是为了让 useProjectStatus/useThreadStatus 这两个 hook 能合法地按
// project/thread 分别调用一次——不能直接在 HomePage 的 .map() 循环体内调用 hook
// （Rules of Hooks：同一个组件每次渲染调用的 hook 数量/顺序必须固定，而 projects
// 数组长度是运行时可变的）。
function ProjectCard({ project: p, expanded, onToggle }: { project: ProjectInfo; expanded: boolean; onToggle: () => void }) {
  const aggregate = useProjectStatus(p.dirName, p.threads.map((t) => t.rootKey))
  return (
    <div className="card" onClick={onToggle}>
      <div className="name"><StatusDot status={aggregate} /> 📁 {basename(p.cwd)}</div>
      <div className="sub">{p.threads.length} 个会话 · {formatRelative(p.lastActivityMs)}</div>
      {expanded && (
        <div className="thread-list" onClick={(e) => e.stopPropagation()}>
          {p.threads.slice(0, 8).map((t) => (
            <ThreadRow key={t.rootKey} project={p} thread={t} />
          ))}
          <div className="thread-row new-conv" onClick={() => void newConversation(p.cwd)}>＋ 新对话</div>
        </div>
      )}
    </div>
  )
}

function ThreadRow({ project: p, thread: t }: { project: ProjectInfo; thread: ThreadInfo }) {
  const status = useThreadStatus(p.dirName, t.rootKey)
  return (
    <div className="thread-row" onClick={() => void resumeThread(p.dirName, p.cwd, t)}>
      <span className="thread-row-main">
        <StatusDot status={status} />
        <span className="t">{t.title}</span>
      </span>
      <span className="time">{formatRelative(t.lastActivityMs)}</span>
    </div>
  )
}
