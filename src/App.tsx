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
  useEffect(() => {
    refresh().catch(console.error)
    const onFocus = () => { refresh().catch(console.error) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Control+Tab / Control+Shift+Tab：像 Chrome 一样在标签间循环切换（含主页标签），
      // 越过数组两端时回绕。故意放在 metaKey 分支之前、且不要求 e.metaKey——这是 Control
      // 键组合，与下面一大段 ⌘ 快捷键是两回事。只对这两个组合调用 preventDefault/
      // stopPropagation，其余按键原样落空到下面的分支，未命中时不做任何拦截，正常
      // 交给终端处理。
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        const { tabs, activeId, setActive } = useTabs.getState()
        const idx = tabs.findIndex((t) => t.id === activeId)
        const delta = e.shiftKey ? -1 : 1
        const next = tabs[(idx + delta + tabs.length) % tabs.length]
        if (next) setActive(next.id)
        return
      }
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
    // 捕获阶段注册：终端（xterm）在冒泡阶段可能会先吃掉 Ctrl+Tab 这类组合键，
    // 捕获阶段能保证我们先于它看到事件。这连带把下面这些既有的 ⌘ 快捷键也一起
    // 挪到了捕获阶段，是有意为之、更可靠；只对上面明确处理的组合调用
    // preventDefault/stopPropagation，其余按键不受影响，仍会照常落到终端。
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
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
      <ConversationPanel />
    </div>
  )
}
