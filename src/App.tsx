import './ptyBuffer'
import './closeRequest'
import './contextMenu'
import './App.css'
import { useEffect, useRef } from 'react'
import { newTerminal } from './actions'
import { ConversationPanel } from './components/ConversationPanel'
import { DragGhost } from './components/DragGhost'
import { DropIndicator } from './components/DropIndicator'
import { HomePage } from './components/HomePage'
import { OverviewPage } from './components/OverviewPage'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { TabPanes } from './components/TabPanes'
import { TerminalLayer } from './components/TerminalLayer'
import { decidePaneFit, MAX_PANES, neighborPaneId, usablePaneAreaWidth } from './paneLayout'
import { useHint } from './store/hint'
import { useLayout } from './store/layout'
import { useSessions } from './store/sessions'
import { useTabs } from './store/tabs'

export default function App() {
  const { tabs, activeId } = useTabs()
  const refresh = useSessions((s) => s.refresh)
  const sidebarCollapsed = useLayout((s) => s.sidebarCollapsed)
  const contentRef = useRef<HTMLDivElement>(null)
  // ⌘D 拒绝新建窗格（已达 3 个 / 窄窗口装不下）、以及 TabBar.tsx/Sidebar.tsx 两个
  // 拖拽入口各自的同类拒绝，共用同一条内联轻提示（store/hint.ts）：不用对话框，
  // 几秒后自行消失（设计文档 §5-A"无对话，内联自消失提示即可"），三处触发、一处
  // 渲染，不写第二套提示机制。
  const hint = useHint((s) => s.message)
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
        // ⌘W 关闭当前标签的聚焦窗格；closePane 内部在标签只剩一个窗格时会自己
        // 委托给 closeTab（等同关闭整个标签，沿用既有确认），这里不用分支判断
        // "是不是最后一个窗格"（设计文档 §6）。
        const { tabs, activeId } = useTabs.getState()
        const tab = tabs.find((t) => t.id === activeId)
        if (tab?.kind === 'term' && tab.activePaneId) {
          void useTabs.getState().closePane(activeId, tab.activePaneId)
        }
      } else if (key === 'd') {
        e.preventDefault()
        // ⌘D：在当前标签聚焦窗格右侧新建一个窗格（设计文档 §5-A）。三层前置检查，
        // 任一不满足就拒绝并给出轻提示，绝不去挤压已有窗格：
        //   1) 硬上限 3 个窗格；
        //   2) 当前内容区宽度能否让 N+1 个窗格各自达到 320px 最小宽度；
        //   3) 不行的话，收起对话面板腾出的宽度够不够（够就先收起面板再建）
        //      （设计文档 §8"优先收起对话面板，仍不足则拒绝新建"）。
        const { tabs, activeId } = useTabs.getState()
        const tab = tabs.find((t) => t.id === activeId)
        if (!tab || tab.kind !== 'term' || !tab.activePaneId) return
        const nextCount = tab.panes.length + 1
        if (nextCount > MAX_PANES) {
          useHint.getState().show('最多支持 3 个窗格')
          return
        }
        // contentRef.current.clientWidth 量的是 .content 这个外层容器，比 .term-wrap
        // 还要多绕一层，但数值上与 .term-wrap 的 clientWidth 相等（.content 自身无
        // 边框/内边距，.term-wrap 又是 inset:0 绝对定位铺满它）——同样包含窗格分不到
        // 的内边距/分隔条/窗格边框开销，用 usablePaneAreaWidth 扣掉，⌘D 的拒绝阈值
        // 才对得上真实渲染像素（见 paneLayout.ts 顶部注释）。
        const contentWidth = usablePaneAreaWidth(contentRef.current?.clientWidth ?? 0, nextCount)
        const layout = useLayout.getState()
        const decision = decidePaneFit(nextCount, contentWidth, layout.panelCollapsed, layout.panelWidth)
        if (decision === 'fits') {
          useTabs.getState().addPane(tab.id, tab.activePaneId)
        } else if (decision === 'collapse-panel') {
          layout.togglePanel()
          useTabs.getState().addPane(tab.id, tab.activePaneId)
        } else {
          useHint.getState().show('窗口太窄，放不下新窗格')
        }
      } else if (e.altKey && (key === 'arrowleft' || key === 'arrowright')) {
        e.preventDefault()
        // ⌘⌥←/→：在当前标签的窗格间移动焦点，不跨标签、边界不循环（设计文档 §6）。
        // 到达边界时 neighborPaneId 返回 undefined，原样保持当前焦点不变。
        const { tabs, activeId } = useTabs.getState()
        const tab = tabs.find((t) => t.id === activeId)
        if (!tab || tab.kind !== 'term') return
        const nextId = neighborPaneId(tab.panes.map((p) => p.id), tab.activePaneId, key === 'arrowright' ? 1 : -1)
        if (nextId) useTabs.getState().focusPane(tab.id, nextId)
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
        <div className="content" ref={contentRef}>
          <div className="home-wrap" style={{ display: activeId === 'home' ? 'block' : 'none' }}>
            <HomePage />
          </div>
          {tabs.filter((t) => t.kind === 'term').map((t) => (
            <TabPanes key={t.id} tab={t} isActiveTab={activeId === t.id} />
          ))}
          {/* 总览标签（Task 8）：与上面的 home-wrap/TabPanes 同一策略——非激活标签也
              常驻挂载，只是 display:none 隐藏，标签切换/窗格变化都不会让它卸载重挂。
              OverviewPage 自己的根元素（.overview-page）已经是 position:absolute;
              inset:0（见 App.css），这里的包裹 div 不需要再写任何定位样式，只负责
              显隐切换；它自己没有 position，浏览器会跳过它去找上一层有定位的祖先
              （.content），效果与 .home-wrap 直接铺满一致。dirName 恒有值——只有
              openOverview 会创建 kind==='overview' 的标签，创建时必填 dirName。 */}
          {tabs.filter((t) => t.kind === 'overview').map((t) => (
            <div key={t.id} style={{ display: activeId === t.id ? 'block' : 'none' }}>
              <OverviewPage dirName={t.dirName!} />
            </div>
          ))}
          {/* 扁平终端层：与上面各标签的 TabPanes 同级挂载，不嵌在任何一个标签自己的
              子树里——持有 PTY 的窗格，其 <TerminalView> 实例只存在于这一层，按各自
              插槽（.pane-body[data-pane-slot]，在上面的 TabPanes 树里）当前的实测矩形
              绝对定位覆盖上去，标签切换/窗格增删都不会让它被卸载重挂（见
              TerminalLayer.tsx 顶部注释）。渲染顺序在 TabPanes 列表之后、pane-hint 之前：
              TabPanes 树里的插槽本身不可见（没有可见内容），谁先谁后不影响布局或点击，
              这里选择"之后"只是让终端包裹层在默认层叠顺序里画在插槽之上，不依赖
              z-index。 */}
          <TerminalLayer containerRef={contentRef} />
          {/* 拖放落点指示（设计文档 §5-B）：与 TerminalLayer 同级、渲染顺序在其之后，
              半透明色块因此总是画在终端包裹层之上，不需要额外的 z-index 博弈。 */}
          <DropIndicator containerRef={contentRef} />
          {hint && <div className="pane-hint">{hint}</div>}
        </div>
      </div>
      <ConversationPanel />
      {/* 跟随光标的拖拽指示（TabBar.tsx/Sidebar.tsx/TabPanes.tsx 三处拖拽源共用，见
          store/dragGhost.ts）：position:fixed，挂在树里任何位置效果都一样，渲染顺序
          放最后确保画在最上层。 */}
      <DragGhost />
    </div>
  )
}
