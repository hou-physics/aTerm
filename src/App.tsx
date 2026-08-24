import './ptyBuffer'
import './App.css'
import { TabBar } from './components/TabBar'
import { TerminalView } from './components/TerminalView'
import { useTabs } from './store/tabs'

export default function App() {
  const { tabs, activeId, openTerminal } = useTabs()
  return (
    <div className="app">
      <aside className="sidebar">{/* Task 9: <Sidebar/> */}</aside>
      <div className="main">
        <TabBar />
        <div className="content">
          <div style={{ display: activeId === 'home' ? 'block' : 'none', padding: 24 }}>
            {/* Task 9 将替换为 <HomePage/> */}
            <button onClick={() => void openTerminal({ title: 'zsh' })}>＋ 新终端</button>
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
