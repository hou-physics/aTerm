import { useLibrary } from '../../store/library'

// 项目与会话分区：两份既有数据的"一次看全"入口，不是它们的第一个 UI 入口——
// 隐藏项目已经能在 HomePage.tsx 的右键菜单撤销（hideProject 的可撤销轻提示，
// 见 HomePage.tsx:140 附近），移除会话已经能在 Sidebar.tsx 的右键菜单恢复
// （Sidebar.tsx:356 附近，同一惯例）。这里直接调同样的 store action
// （unhideProject / restoreSession），不重新实现那两处的判断——两处既有调用点都
// 只是"调 store action"这一步、没有额外副作用（不像 hideProject/removeSession
// 那样会顺带 useHint.getState().show(...) 弹一条可撤销提示——那条提示属于
// 隐藏/移除动作本身，不属于撤销/恢复动作），所以这里同样只调 store action，
// 不额外补 hint。
//
// 已移除会话的展示名：优先用 aliases[key]（用户改过的名字），没有别名才展示 key
// 本身——不在这里调 displayTitle，那需要 thread 对象，这里没有。
export function ProjectsSection() {
  const hiddenProjects = useLibrary((s) => s.hiddenProjects)
  const removedSessions = useLibrary((s) => s.removedSessions)
  const aliases = useLibrary((s) => s.aliases)
  const unhideProject = useLibrary((s) => s.unhideProject)
  const restoreSession = useLibrary((s) => s.restoreSession)

  const hiddenDirNames = Object.keys(hiddenProjects)
  const removedKeys = Object.keys(removedSessions)

  return (
    <div className="projects-section">
      <div className="projects-section-group">
        <div className="projects-section-group-label">隐藏的项目</div>
        {hiddenDirNames.length === 0 ? (
          <div className="projects-section-empty">没有隐藏的项目</div>
        ) : (
          <ul className="projects-section-list">
            {hiddenDirNames.map((dirName) => (
              <li key={dirName} className="projects-section-row">
                <span className="projects-section-name">{dirName}</span>
                <button
                  type="button"
                  className="projects-section-action"
                  aria-label={`取消隐藏 ${dirName}`}
                  onClick={() => unhideProject(dirName)}
                >
                  取消隐藏
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="projects-section-group">
        <div className="projects-section-group-label">已移除的会话</div>
        {removedKeys.length === 0 ? (
          <div className="projects-section-empty">没有移除的会话</div>
        ) : (
          <ul className="projects-section-list">
            {removedKeys.map((key) => (
              <li key={key} className="projects-section-row">
                <span className="projects-section-name">{aliases[key] ?? key}</span>
                <button
                  type="button"
                  className="projects-section-action"
                  aria-label={`恢复 ${key}`}
                  onClick={() => restoreSession(key)}
                >
                  恢复
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
