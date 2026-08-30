import { useState } from 'react'
import type { ProjectInfo, ThreadInfo } from '../ipc'
import { matchesQuery, filterProjectsByQuery } from '../sessionSearch'
import { useSessions } from '../store/sessions'
import { basename, formatRelative } from '../time'

const RECENT_LIMIT = 8

export type SessionPick =
  | { kind: 'shell' }
  | { kind: 'newConversation'; project: ProjectInfo }
  | { kind: 'resume'; project: ProjectInfo; thread: ThreadInfo }

// 会话选择界面（设计文档 §5-A），四段：
//   1) 新终端（zsh）
//   2) 新对话——若调用方能提供 defaultProject（比如 PanePicker 靠来源窗格推断出的
//      项目）则直接用它启动，免去用户再选一次；没有则退化为列出全部项目供选择
//   3) 最近会话——useSessions 数据源里按最近活跃时间取前 8 条
//   4) 全部项目——每个项目可展开出其会话列表，与 HomePage.tsx 的卡片是同一份
//      useSessions 数据（不发起第二条 IPC 拉取），只是窄窗格下改用纵向列表而非
//      卡片网格（HomePage 的 CSS Grid 在 320px 宽度下也会退化成单列，但两处的
//      交互细节——是否分页展示、悬停态——足够不同，这里选择保留一小段并行 JSX，
//      而不是抽一个"两种密度都要兼顾"的共享组件出来增加两边的耦合，见
//      .superpowers/pane-picker-report.md 的取舍说明）。
// 顶部搜索框按子串（大小写不敏感）同时过滤"最近会话"与"全部项目"两段，命中
// 项目名或会话标题即保留。
//
// 这是纯粹的选择界面：不认识调用方是窗格还是标签，选中结果一律经 onPick 交回，
// 由调用方决定终点动作（填充窗格 / 新建标签……）。
export function SessionPicker({
  defaultProject,
  onPick,
}: {
  defaultProject?: ProjectInfo
  onPick: (pick: SessionPick) => void
}) {
  const { projects } = useSessions()
  const [query, setQuery] = useState('')
  const [expandedProject, setExpandedProject] = useState<string | null>(null)
  const [pickingProject, setPickingProject] = useState(false)
  const q = query.trim().toLowerCase()

  const recent = projects
    .flatMap((p) => p.threads.map((t) => ({ p, t })))
    .sort((a, b) => b.t.lastActivityMs - a.t.lastActivityMs)
    .filter(({ p, t }) => matchesQuery(q, t.title, basename(p.cwd)))
    .slice(0, RECENT_LIMIT)

  // 全部项目：项目名本身命中时保留该项目下全部会话；否则只保留会话标题命中的那些，
  // 一个会话都没命中的项目整个隐去（见 ../sessionSearch.ts，与 HomePage.tsx 的主页
  // 搜索框共用同一份实现）。
  const allProjects = filterProjectsByQuery(projects, q)

  const noMatches = q !== '' && recent.length === 0 && allProjects.length === 0

  const pickShell = () => onPick({ kind: 'shell' })

  const pickNewConversationIn = (p: ProjectInfo) => {
    setPickingProject(false)
    onPick({ kind: 'newConversation', project: p })
  }
  const pickNewConversation = () => {
    if (defaultProject) pickNewConversationIn(defaultProject)
    else setPickingProject(true)
  }
  const pickResume = (p: ProjectInfo, t: ThreadInfo) => onPick({ kind: 'resume', project: p, thread: t })

  return (
    <div className="pane-picker">
      <input
        className="pane-picker-search"
        placeholder="搜索会话或项目…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="pane-picker-item" onClick={pickShell}>新终端（zsh）</div>
      <div className="pane-picker-item" onClick={pickNewConversation}>新对话</div>
      {pickingProject && (
        <div className="pane-picker-subpick">
          <div className="pane-picker-label">选择项目</div>
          {projects.map((p) => (
            <div key={p.dirName} className="pane-picker-item" onClick={() => pickNewConversationIn(p)}>
              {basename(p.cwd)}
            </div>
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <>
          <div className="pane-picker-label">最近会话</div>
          {recent.map(({ p, t }) => (
            <div key={`recent:${p.dirName}:${t.rootKey}`} className="pane-picker-item" onClick={() => pickResume(p, t)}>
              <div className="t">{t.title}</div>
              <div className="sub">{basename(p.cwd)} · {formatRelative(t.lastActivityMs)}</div>
            </div>
          ))}
        </>
      )}

      {allProjects.length > 0 && (
        <>
          <div className="pane-picker-label">全部项目</div>
          {allProjects.map((p) => (
            <div key={p.dirName} className="pane-picker-project">
              <div
                className="pane-picker-project-head"
                onClick={() => setExpandedProject(expandedProject === p.dirName ? null : p.dirName)}
              >
                <span className="name">📁 {basename(p.cwd)}</span>
                <span className="sub">{p.threads.length} 个会话</span>
              </div>
              {expandedProject === p.dirName && (
                <div className="pane-picker-thread-list">
                  {p.threads.map((t) => (
                    <div key={`all:${p.dirName}:${t.rootKey}`} className="pane-picker-item" onClick={() => pickResume(p, t)}>
                      <div className="t">{t.title}</div>
                      <div className="sub">{formatRelative(t.lastActivityMs)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {noMatches && <div className="pane-picker-empty">没有匹配的会话或项目</div>}
      {q === '' && projects.length === 0 && <div className="pane-picker-empty">尚未发现 Claude Code 会话（~/.claude/projects 为空）</div>}
    </div>
  )
}
