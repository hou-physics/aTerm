import './ptyBuffer'
import './App.css'
import { useEffect } from 'react'
import { HomePage } from './components/HomePage'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { TerminalView } from './components/TerminalView'
import { useSessions } from './store/sessions'
import { useTabs } from './store/tabs'

export default function App() {
  const { tabs, activeId } = useTabs()
  const refresh = useSessions((s) => s.refresh)
  useEffect(() => {
    refresh().catch(console.error)
    const onFocus = () => { refresh().catch(console.error) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])
  return (
    <div className="app">
      <aside className="sidebar"><Sidebar /></aside>
      <div className="main">
        <TabBar />
        <div className="content">
          <div style={{ display: activeId === 'home' ? 'block' : 'none' }}>
            <HomePage />
          </div>
          {tabs.filter((t) => t.kind === 'term').map((t) => (
            <div key={t.id} className="term-wrap" style={{ display: activeId === t.id ? 'block' : 'none' }}>
              <TerminalView ptyId={t.ptyId!} active={activeId === t.id} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
