import { Fragment, useMemo, useState, type KeyboardEvent } from 'react'
import { newConversation, resumeThread, runCommand } from '../actions'
import type { ProjectInfo, ThreadInfo } from '../ipc'
import { filterProjectsByQuery, type ProjectSearchMatch } from '../sessionSearch'
import { useSessions } from '../store/sessions'
import { useProjectStatus, useThreadStatus } from '../store/status'
import { basename, formatRelative } from '../time'
import { HooksPromptBar } from './HooksInstall'
import { StatusDot } from './StatusDot'

// 主页顶部输入框：从"命令运行器"改为"过往对话搜索框"（用户反馈：真正想要的是能
// 快速找到某个之前的会话，而不是记住/敲一遍命令）。输入为空时完全不受影响——今天
// 已有的"最近项目"卡片视图原样渲染（下面的 ProjectCard/ThreadRow 两个组件本身
// 一个字节都没改）；一旦输入非空，就切到按项目分组的搜索结果，复用与 PanePicker.tsx
// 完全相同的匹配规则（../sessionSearch.ts，大小写不敏感子串，命中项目名或会话标题）
// ——不重新发明第二套过滤逻辑。
//
// 没有拿掉"运行命令"这个能力：搜索无匹配时，末尾多一行「在新标签中运行 "<text>"」，
// 点击/回车走的就是原来 Enter 键触发的同一个 runCommand。
export function HomePage() {
  const { projects } = useSessions()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const q = query.trim()

  // 只在有匹配的会话时才展示这个项目分组——项目名命中但项目下没有会话（理论上
  // 可能发生：项目名匹配、但会话列表本就为空）时，filterProjectsByQuery 仍会保留
  // 这个项目条目（供 PanePicker.tsx 的可展开视图使用），但主页搜索结果不是可展开
  // 列表，一个空分组标题下面什么都没有会显得像是渲染坏了，这里直接不展示它。
  const matched = useMemo<ProjectSearchMatch[]>(() => {
    if (!q) return []
    return filterProjectsByQuery(projects, q).filter((p) => p.threads.length > 0)
  }, [projects, q])

  const searching = q !== ''
  const hasResults = matched.length > 0
  const showRunFallback = searching && !hasResults
  const firstResult = hasResults ? { p: matched[0], t: matched[0].threads[0] } : null

  const openResult = (p: ProjectInfo, t: ThreadInfo) => {
    void resumeThread(p.dirName, p.cwd, t)
    setQuery('')
  }
  const runFallback = () => {
    void runCommand(q)
    setQuery('')
  }

  // 回车键的语义按当前是否有结果分叉：有结果——等同点击第一条结果（"选中并打开"）；
  // 没有结果——如果输入非空，等同点击末尾那一行「在新标签中运行」（此时它是唯一的
  // 一行，"选中"它就是执行它）；输入本就是空——原样保留旧行为（留空回车＝新终端）。
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    if (!searching) { void runCommand(''); return }
    if (firstResult) { openResult(firstResult.p, firstResult.t); return }
    runFallback()
  }

  return (
    <div className="home">
      <HooksPromptBar />
      <input
        className="cmd-input"
        placeholder="搜索过往对话…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {!searching ? (
        <>
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
        </>
      ) : (
        <div className="search-results">
          {matched.map((p) => (
            <Fragment key={p.dirName}>
              <div className="section-label">📁 {basename(p.cwd)}</div>
              {p.threads.map((t) => (
                <SearchResultRow key={`${p.dirName}:${t.rootKey}`} project={p} thread={t} onOpen={openResult} />
              ))}
            </Fragment>
          ))}
          {showRunFallback && (
            <div className="thread-row new-conv" onClick={runFallback}>
              在新标签中运行 “{q}”
            </div>
          )}
        </div>
      )}
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

// 搜索结果行：与 ThreadRow 同一套外观基调（同一个 .thread-row），多展示一项——所属
// 项目名（用户要求"每行显示会话标题、所属项目、相对时间与状态点"；分组标题
// （上面的 "📁 basename" section-label）已经按项目分了组，这里再显示一次项目名看似
// 冗余，但明确按任务要求逐项给出，不省略）。
function SearchResultRow({
  project: p,
  thread: t,
  onOpen,
}: {
  project: ProjectInfo
  thread: ThreadInfo
  onOpen: (p: ProjectInfo, t: ThreadInfo) => void
}) {
  const status = useThreadStatus(p.dirName, t.rootKey)
  return (
    <div className="thread-row" onClick={() => onOpen(p, t)}>
      <span className="thread-row-main">
        <StatusDot status={status} />
        <span className="t">{t.title}</span>
        <span className="search-result-project">{basename(p.cwd)}</span>
      </span>
      <span className="time">{formatRelative(t.lastActivityMs)}</span>
    </div>
  )
}
