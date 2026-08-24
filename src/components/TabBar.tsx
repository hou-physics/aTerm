import { useTabs } from '../store/tabs'

export function TabBar() {
  const { tabs, activeId, setActive, closeTab } = useTabs()
  return (
    <div className="tabbar">
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
