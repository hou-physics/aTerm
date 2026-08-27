import { resumeThread } from '../actions'
import { useSessions } from '../store/sessions'
import { basename, formatRelative } from '../time'
import { ThemeSwitcher } from './ThemeSwitcher'

export function Sidebar() {
  const { projects } = useSessions()
  const recent = projects
    .flatMap((p) => p.threads.map((t) => ({ p, t })))
    .sort((a, b) => b.t.lastActivityMs - a.t.lastActivityMs)
    .slice(0, 12)
  return (
    <>
      <div className="sidebar-list">
        <div className="section-label">最近会话</div>
        {recent.map(({ p, t }) => (
          <div key={`${p.dirName}:${t.rootKey}`} className="side-item" title={t.title} onClick={() => void resumeThread(p.dirName, p.cwd, t)}>
            {t.title}
            <div className="sub">{basename(p.cwd)} · {formatRelative(t.lastActivityMs)}</div>
          </div>
        ))}
      </div>
      <ThemeSwitcher />
    </>
  )
}
