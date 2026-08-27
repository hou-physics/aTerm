import { newTerminal } from '../actions'
import { useLayout } from '../store/layout'
import { useTabs } from '../store/tabs'

export function TabBar() {
  const { tabs, activeId, setActive, closeTab } = useTabs()
  const sidebarCollapsed = useLayout((s) => s.sidebarCollapsed)
  const toggleSidebar = useLayout((s) => s.toggleSidebar)
  const panelCollapsed = useLayout((s) => s.panelCollapsed)
  const togglePanel = useLayout((s) => s.togglePanel)
  return (
    <div className="tabbar">
      <button
        type="button"
        className="sidebar-toggle"
        onClick={() => toggleSidebar()}
        title={sidebarCollapsed ? '展开侧边栏 (⌘B)' : '折叠侧边栏 (⌘B)'}
      >
        {sidebarCollapsed ? '›' : '‹'}
      </button>
      {tabs.map((t) => (
        <div key={t.id} className={`tab ${t.id === activeId ? 'active' : ''}`} onClick={() => setActive(t.id)}>
          <span className="tab-title">{t.kind === 'home' ? '⌂' : t.title}</span>
          {t.kind !== 'home' && (
            <span className="tab-close" onClick={(e) => { e.stopPropagation(); void closeTab(t.id) }}>×</span>
          )}
        </div>
      ))}
      <button
        type="button"
        className="tab-new"
        onClick={() => void newTerminal()}
        title="新建终端标签 (⌘T)"
      >
        ＋
      </button>
      <button
        type="button"
        className="panel-toggle"
        onClick={() => togglePanel()}
        title={panelCollapsed ? '显示对话面板 (⌘J)' : '隐藏对话面板 (⌘J)'}
      >
        {panelCollapsed ? '‹' : '›'}
      </button>
    </div>
  )
}
