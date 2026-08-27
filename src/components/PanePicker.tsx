import { useState } from 'react'
import type { ProjectInfo, ThreadInfo } from '../ipc'
import { useSessions } from '../store/sessions'
import { type Tab, useTabs } from '../store/tabs'
import { basename, formatRelative } from '../time'

const RECENT_LIMIT = 8

// 子串匹配：不区分大小写，命中任一候选文本即算匹配；query 为空串时视为全部匹配
// （即未输入过滤词时不做任何过滤）。
function matches(query: string, ...candidates: string[]): boolean {
  if (!query) return true
  return candidates.some((c) => c.toLowerCase().includes(query))
}

// ⌘D 新建的窗格在选定会话之前显示的选择列表（设计文档 §5-A），现扩展为四段
// （用户反馈"最近会话不够，要能像主页一样浏览全部项目"）：
//   1) 新终端（zsh）
//   2) 新对话——尽量免去再选一次项目：优先复用"拆分出本窗格的那个窗格"所在项目
//      （见 sourcePane 注释），没有则退化为列出全部项目供选择
//   3) 最近会话——不变，仍是 useSessions 数据源里按最近活跃时间取前 8 条
//   4) 全部项目——每个项目可展开出其会话列表，与 HomePage.tsx 的卡片是同一份
//      useSessions 数据（不发起第二条 IPC 拉取），只是窄窗格下改用纵向列表而非
//      卡片网格（HomePage 的 CSS Grid 在 320px 宽度下也会退化成单列，但两处的
//      交互细节——是否分页展示、悬停态——足够不同，这里选择保留一小段并行 JSX，
//      而不是抽一个"两种密度都要兼顾"的共享组件出来增加两边的耦合，见
//      .superpowers/pane-picker-report.md 的取舍说明）。
// 顶部搜索框按子串（大小写不敏感）同时过滤"最近会话"与"全部项目"两段，命中
// 项目名或会话标题即保留。
export function PanePicker({ tab, paneId }: { tab: Tab; paneId: string }) {
  const { projects } = useSessions()
  const tabId = tab.id
  const [query, setQuery] = useState('')
  const [expandedProject, setExpandedProject] = useState<string | null>(null)
  const [pickingProject, setPickingProject] = useState(false)
  const q = query.trim().toLowerCase()

  const recent = projects
    .flatMap((p) => p.threads.map((t) => ({ p, t })))
    .sort((a, b) => b.t.lastActivityMs - a.t.lastActivityMs)
    .filter(({ p, t }) => matches(q, t.title, basename(p.cwd)))
    .slice(0, RECENT_LIMIT)

  // 全部项目：项目名本身命中时保留该项目下全部会话；否则只保留会话标题命中的那些，
  // 一个会话都没命中的项目整个隐去。
  const allProjects = projects
    .map((p) => {
      const projectMatches = matches(q, basename(p.cwd))
      const threads = projectMatches ? p.threads : p.threads.filter((t) => matches(q, t.title))
      return { ...p, threads, projectMatches }
    })
    .filter((p) => p.projectMatches || p.threads.length > 0)

  const noMatches = q !== '' && recent.length === 0 && allProjects.length === 0

  // 「新对话」默认目录：找到拆分出本窗格的来源窗格——addPane 总是把新窗格插在
  // 被拆分窗格右侧紧邻的一位（见 store/tabs.ts 的 insertAt = idx + 1），所以本窗格
  // 在 panes 数组里的前一个就是那个来源窗格。它若带 dirName（说明是一个对话窗格）
  // 就直接复用其项目，不需要用户再选一次；否则（比如来源是普通 zsh 终端，或本
  // 窗格是标签的第一个窗格）就没有"当前聚焦窗格所属项目"可言，退化为列出全部
  // 项目供选择。
  const ownIndex = tab.panes.findIndex((p) => p.id === paneId)
  const sourcePane = ownIndex > 0 ? tab.panes[ownIndex - 1] : undefined
  const defaultProject = sourcePane?.dirName ? projects.find((p) => p.dirName === sourcePane.dirName) : undefined

  const startZsh = () => void useTabs.getState().startPaneTerminal(tabId, paneId, { title: 'zsh' })

  const startNewConversationIn = (p: ProjectInfo) => {
    setPickingProject(false)
    void useTabs.getState().startPaneTerminal(tabId, paneId, { title: '新对话', cwd: p.cwd, inject: 'claude' })
  }
  const startNewConversation = () => {
    if (defaultProject) startNewConversationIn(defaultProject)
    else setPickingProject(true)
  }
  const startResume = (p: ProjectInfo, t: ThreadInfo) =>
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
      <input
        className="pane-picker-search"
        placeholder="搜索会话或项目…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="pane-picker-item" onClick={startZsh}>新终端（zsh）</div>
      <div className="pane-picker-item" onClick={startNewConversation}>新对话</div>
      {pickingProject && (
        <div className="pane-picker-subpick">
          <div className="pane-picker-label">选择项目</div>
          {projects.map((p) => (
            <div key={p.dirName} className="pane-picker-item" onClick={() => startNewConversationIn(p)}>
              {basename(p.cwd)}
            </div>
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <>
          <div className="pane-picker-label">最近会话</div>
          {recent.map(({ p, t }) => (
            <div key={`recent:${p.dirName}:${t.rootKey}`} className="pane-picker-item" onClick={() => startResume(p, t)}>
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
                    <div key={`all:${p.dirName}:${t.rootKey}`} className="pane-picker-item" onClick={() => startResume(p, t)}>
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
