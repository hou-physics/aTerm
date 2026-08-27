import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { newTerminal } from '../actions'
import { resolveDropTarget } from '../paneDrop'
import { getContentWidth, getPaneSlotRects, getTabRects } from '../paneDropDom'
import { decidePaneFit, MAX_PANES } from '../paneLayout'
import { useDnd } from '../store/dnd'
import { useHint } from '../store/hint'
import { useLayout } from '../store/layout'
import { useTabs } from '../store/tabs'

// 拖动超过这个像素距离才算真的在拖标签，而不是一次普通点击——阈值太小会让手抖的
// 点击被误判成拖拽，太大会让拖拽感觉迟钝；4px 是这类交互的常见取值（设计文档要求
// "small movement threshold (e.g. 4px)"）。
const DRAG_THRESHOLD_PX = 4

type DragState = { tabId: string; startX: number; startY: number; dragging: boolean }

// 把窗格拖出成独立标签、松手时落在标签栏上（设计文档 §5-C，TabPanes.tsx 的
// PaneTitleBar 是拖拽源）应插入的位置指示：一条竖线，与 DropIndicator.tsx 的
// 半透明色块同一套"拖拽源实时写 store/dnd.ts、指示条只读"模式，只是这里落点所在的
// 容器是 `.tabbar` 而不是 `.content`，形状也不同（插入位置用线，覆盖窗格用块），
// 因此没有直接复用 DropIndicator 组件本身，而是复用它背后的store/pointer-event 机制。
function TabBarDropIndicator() {
  const tabBarIndex = useDnd((s) => s.tabBarIndex)
  const [left, setLeft] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (tabBarIndex === null) {
      setLeft(null)
      return
    }
    const bar = document.querySelector<HTMLElement>('.tabbar')
    if (!bar) {
      setLeft(null)
      return
    }
    const barRect = bar.getBoundingClientRect()
    const rects = getTabRects()
    const target = rects[tabBarIndex]
    const last = rects[rects.length - 1]
    const x = target ? target.rect.left : last ? last.rect.left + last.rect.width : 0
    setLeft(x - barRect.left)
  }, [tabBarIndex])

  if (left === null) return null
  return <div className="tabbar-drop-indicator" style={{ left }} />
}

// 把已打开的标签拖进窗格区（设计文档 §5-B 场景 A，用户明确要求）：与 TabPanes.tsx 的
// PaneDivider / ConversationPanel.tsx 的宽度手柄同一套 pointerdown/move/up +
// setPointerCapture 模式（复用既有拖拽 idiom），不用 HTML5 dragstart/drop——那套 API
// 在 WKWebView 里表现不稳定、也难以自定义落点指示的样式（任务要求）。
//
// 与分隔条/面板手柄不同的是：这里必须让"没有拖动"的普通点击继续像以前一样调用
// setActive——不能在 pointerdown 时就 preventDefault（那样在部分浏览器实现下会连带
// 抑制随后的原生 click），而是让 click 照常触发，只在"确实发生过一次拖拽"时用
// suppressClickRef 吞掉这一次 click（否则拖拽落地后浏览器补发的 click 会把 activeId
// 设成刚刚被移出的、已经不存在的源标签 id）。
export function TabBar() {
  const { tabs, activeId, setActive, closeTab } = useTabs()
  const sidebarCollapsed = useLayout((s) => s.sidebarCollapsed)
  const toggleSidebar = useLayout((s) => s.toggleSidebar)
  const panelCollapsed = useLayout((s) => s.panelCollapsed)
  const togglePanel = useLayout((s) => s.togglePanel)

  const dragRef = useRef<DragState | null>(null)
  const suppressClickRef = useRef(false)

  const onTabPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, tabId: string) => {
    // 关闭按钮自己的点击语义（stopPropagation + closeTab）不参与拖拽判定，原样放行。
    if ((e.target as HTMLElement).closest('.tab-close')) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { tabId, startX: e.clientX, startY: e.clientY, dragging: false }
  }, [])

  const onTabPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    if (!drag.dragging) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return
      drag.dragging = true
    }
    const { tabs, activeId } = useTabs.getState()
    const dragTab = tabs.find((t) => t.id === drag.tabId)
    // 主页标签没有窗格可移动；拖的正是当前激活标签本身时，那是"拖到自己标签的窗格
    // 区"——设计文档明确要求这是空操作，这里索性连落点都不解析、指示条也不出现
    // （"no visual churn"），而不是等到 pointerup 才悄悄拒绝。
    if (!dragTab || dragTab.kind !== 'term' || dragTab.id === activeId) {
      useDnd.getState().setTarget(null)
      return
    }
    const activeTab = tabs.find((t) => t.id === activeId)
    useDnd.getState().setTarget(resolveDropTarget(getPaneSlotRects(activeTab), e.clientX, e.clientY))
  }, [])

  const onTabPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    const target = useDnd.getState().target
    useDnd.getState().setTarget(null)
    if (!drag || !drag.dragging) return
    suppressClickRef.current = true
    if (!target) return // 松手时不在任何窗格范围内，视为放弃这次拖拽
    const { tabs, activeId } = useTabs.getState()
    const sourceTab = tabs.find((t) => t.id === drag.tabId)
    const targetTab = tabs.find((t) => t.id === activeId)
    if (!sourceTab || sourceTab.kind !== 'term' || !targetTab || targetTab.kind !== 'term') return
    const nextCount = targetTab.panes.length + sourceTab.panes.length
    if (nextCount > MAX_PANES) {
      useHint.getState().show('最多支持 3 个窗格')
      return
    }
    const layout = useLayout.getState()
    const decision = decidePaneFit(nextCount, getContentWidth(), layout.panelCollapsed, layout.panelWidth)
    if (decision === 'refuse') {
      useHint.getState().show('窗口太窄，放不下新窗格')
      return
    }
    if (decision === 'collapse-panel') layout.togglePanel()
    useTabs.getState().movePanesToTab(drag.tabId, activeId, target)
  }, [])

  const onTabClick = useCallback(
    (tabId: string) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        return
      }
      setActive(tabId)
    },
    [setActive],
  )

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
        <div
          key={t.id}
          data-tab-id={t.id}
          className={`tab ${t.id === activeId ? 'active' : ''}`}
          onPointerDown={(e) => onTabPointerDown(e, t.id)}
          onPointerMove={onTabPointerMove}
          onPointerUp={onTabPointerUp}
          onPointerCancel={onTabPointerUp}
          onClick={() => onTabClick(t.id)}
        >
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
      {/* 窗格拖出成独立标签（设计文档 §5-C）落在标签栏上时的插入位置指示，见上方
          TabBarDropIndicator 注释。渲染顺序放最后，画在其它标签栏元素之上，
          不依赖 z-index（与 .pane-drop-indicator 在 App.tsx 里的取舍一致）。 */}
      <TabBarDropIndicator />
    </div>
  )
}
