import './ptyBuffer'
import './App.css'
import { useEffect } from 'react'
import { newTerminal } from './actions'
import { ConversationPanel } from './components/ConversationPanel'
import { HomePage } from './components/HomePage'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { TerminalView } from './components/TerminalView'
import { useLayout } from './store/layout'
import { useSessions } from './store/sessions'
import { useTabs } from './store/tabs'

export default function App() {
  const { tabs, activeId } = useTabs()
  const refresh = useSessions((s) => s.refresh)
  const sidebarCollapsed = useLayout((s) => s.sidebarCollapsed)
  const panelCollapsed = useLayout((s) => s.panelCollapsed)
  useEffect(() => {
    refresh().catch(console.error)
    const onFocus = () => { refresh().catch(console.error) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      const key = e.key.toLowerCase()
      if (key === 'b') {
        e.preventDefault()
        useLayout.getState().toggleSidebar()
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        useLayout.getState().adjustFontSize(1)
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        useLayout.getState().adjustFontSize(-1)
      } else if (e.key === '0') {
        e.preventDefault()
        useLayout.getState().resetFontSize()
      } else if (key === 't') {
        e.preventDefault()
        void newTerminal()
      } else if (key === 'j') {
        e.preventDefault()
        useLayout.getState().togglePanel()
      } else if (key === 'w') {
        e.preventDefault()
        void useTabs.getState().closeTab(useTabs.getState().activeId)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  return (
    <div className="app">
      {!sidebarCollapsed && <aside className="sidebar"><Sidebar /></aside>}
      <div className="main">
        <TabBar />
        <div className="content">
          <div className="home-wrap" style={{ display: activeId === 'home' ? 'block' : 'none' }}>
            <HomePage />
          </div>
          {tabs.filter((t) => t.kind === 'term').map((t) => (
            <div key={t.id} className="term-wrap" style={{ display: activeId === t.id ? 'block' : 'none' }}>
              <TerminalView ptyId={t.ptyId!} active={activeId === t.id} />
            </div>
          ))}
        </div>
      </div>
      {!panelCollapsed && <aside className="conv-panel-dock"><ConversationPanel /></aside>}
    </div>
  )
}
