import { useLayout } from '../store/layout'
import { useTabs } from '../store/tabs'

export function TabBar() {
  const { tabs, activeId, setActive, closeTab } = useTabs()
  const sidebarCollapsed = useLayout((s) => s.sidebarCollapsed)
  const toggleSidebar = useLayout((s) => s.toggleSidebar)
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
    </div>
  )
}
