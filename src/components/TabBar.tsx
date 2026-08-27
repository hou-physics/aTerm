import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { newTerminal } from '../actions'
import { pointInRect, resolveDropTarget, resolveTabBarInsertIndex } from '../paneDrop'
import { getContentWidth, getPaneSlotRects, getTabBarRect, getTabRects } from '../paneDropDom'
import { decidePaneFit, MAX_PANES } from '../paneLayout'
import { useDnd } from '../store/dnd'
import { useDragGhost } from '../store/dragGhost'
import { useHint } from '../store/hint'
import { useLayout } from '../store/layout'
import { type Tab, useTabs } from '../store/tabs'
import { ContextMenu } from './ContextMenu'

// 拖动超过这个像素距离才算真的在拖标签，而不是一次普通点击——阈值太小会让手抖的
// 点击被误判成拖拽，太大会让拖拽感觉迟钝；4px 是这类交互的常见取值（设计文档要求
// "small movement threshold (e.g. 4px)"）。
const DRAG_THRESHOLD_PX = 4

type DragState = { tabId: string; startX: number; startY: number; dragging: boolean; ghostStarted: boolean }

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
// setActive——不能在 pointerdown 时就 preventDefault（那样会连带抑制随后本该正常
// 触发的原生 click，见下方 onTabPointerDown 注释——这正是上一轮引入、这一轮修复的
// 回归），而是让 click 照常触发，只在"确实发生过一次拖拽"时用 suppressClickRef 吞掉
// 这一次 click（否则拖拽落地后浏览器补发的 click 会把 activeId 设成刚刚被移出的、
// 已经不存在的源标签 id）。
export function TabBar() {
  const { tabs, activeId, setActive, closeTab } = useTabs()
  const sidebarCollapsed = useLayout((s) => s.sidebarCollapsed)
  const toggleSidebar = useLayout((s) => s.toggleSidebar)
  const panelCollapsed = useLayout((s) => s.panelCollapsed)
  const togglePanel = useLayout((s) => s.togglePanel)

  const dragRef = useRef<DragState | null>(null)
  const suppressClickRef = useRef(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)

  const onTabPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, tabId: string) => {
    // 关闭按钮自己的点击语义（stopPropagation + closeTab）不参与拖拽判定，原样放行。
    if ((e.target as HTMLElement).closest('.tab-close')) return
    // 屏蔽文本选择（用户反馈"拖拽会顺带选中相邻文字"）：只加 body class，不调用
    // e.preventDefault()——上一轮在这里无条件 preventDefault 是回归的根源（见
    // store/dragGhost.ts 的 blockSelect() 注释）：真正的默认动作抑制挪到了下面
    // onTabPointerMove 里，只在确认跨过 4px 阈值、真的开始拖拽后才调用，一次普通
    // 点击（pointerdown 后没有明显移动就 up）因此永远不会被 preventDefault 影响，
    // 随后的原生 click 照常触发。
    useDragGhost.getState().blockSelect()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { tabId, startX: e.clientX, startY: e.clientY, dragging: false, ghostStarted: false }
  }, [])

  const onTabPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    if (!drag.dragging) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return
      drag.dragging = true
    }
    // 真正开始拖拽了才抑制默认行为（例如原生的文字/图像拖拽手势）——只在跨过阈值之后
    // 的每一次 move 上调用，从不在 pointerdown 上调用，这样普通点击的合成 click 永远
    // 不会被这里波及（见 onTabPointerDown 注释）。
    e.preventDefault()
    const { tabs, activeId } = useTabs.getState()
    const dragTab = tabs.find((t) => t.id === drag.tabId)
    // 主页标签既没有窗格可合并、自己也不可被拖动排序（设计要求恒排第一）——整个手势
    // 在这里就判定为无效目标，索性连落点都不解析、指示条/ghost 也不出现（"no visual
    // churn"），而不是等到 pointerup 才悄悄拒绝。
    if (!dragTab || dragTab.kind !== 'term') {
      useDnd.getState().setTarget(null)
      useDnd.getState().setTabBarIndex(null)
      return
    }
    // 光标落在标签栏上：这一段拖拽此刻的落点语义是"标签排序"（新增），不是"合并进
    // 窗格区"——与下面的合并分支不同，即便正在拖的就是当前激活标签本身，在这里也是
    // 合法操作（挪动它在标签栏里的位置），因此不复用下面"拖到自己标签的窗格区是
    // 空操作"那条判定。复用既有的 useDnd().tabBarIndex 字段与 TabBarDropIndicator
    // 组件——这两者本是上一轮为"窗格拖出成独立标签、落在标签栏上"这条路径建的，两种
    // 拖拽源共用同一份落点状态与同一条指示线，互不冲突（同一时刻只有一个 drag 在跑）。
    const tabBarRect = getTabBarRect()
    if (tabBarRect && pointInRect(e.clientX, e.clientY, tabBarRect)) {
      const rawIndex = resolveTabBarInsertIndex(getTabRects(), e.clientX)
      useDnd.getState().setTabBarIndex(Math.max(1, rawIndex)) // 不能插到主页标签前面
      useDnd.getState().setTarget(null)
      if (!drag.ghostStarted) {
        drag.ghostStarted = true
        useDragGhost.getState().start(dragTab.title, e.clientX, e.clientY)
      } else {
        useDragGhost.getState().move(e.clientX, e.clientY)
      }
      return
    }
    useDnd.getState().setTabBarIndex(null)
    // 光标落在窗格区：还原成既有的"合并进当前激活标签的窗格区"这条行为。拖的正是
    // 当前激活标签本身时（"拖到自己标签的窗格区"）依旧是设计文档明确要求的空操作
    // ——这条判定只在这个分支里生效，不影响上面标签栏排序那条分支。
    if (dragTab.id === activeId) {
      useDnd.getState().setTarget(null)
      return
    }
    if (!drag.ghostStarted) {
      drag.ghostStarted = true
      useDragGhost.getState().start(dragTab.title, e.clientX, e.clientY)
    } else {
      useDragGhost.getState().move(e.clientX, e.clientY)
    }
    const activeTab = tabs.find((t) => t.id === activeId)
    useDnd.getState().setTarget(resolveDropTarget(getPaneSlotRects(activeTab), e.clientX, e.clientY))
  }, [])

  const onTabPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    const target = useDnd.getState().target
    const tabBarIndex = useDnd.getState().tabBarIndex
    useDnd.getState().setTarget(null)
    useDnd.getState().setTabBarIndex(null)
    // 无条件调用，任何后续 return 都不可能让屏蔽选择的 body class 卡住——与上面
    // setTarget(null) 同一时机、同一理由；这个函数同时接在 onPointerUp 和
    // onPointerCancel 上，两条退出路径因此都被覆盖，end() 对"根本没开始过"是安全的
    // 空操作（见 store/dragGhost.ts 注释）。
    useDragGhost.getState().end()
    if (!drag || !drag.dragging) return
    suppressClickRef.current = true
    if (tabBarIndex !== null) {
      // 松手时落在标签栏上：这是排序落点，不是合并——纯数组挪动，不涉及窗格/上限/
      // 窄窗口降级那一整套校验（reorderTab 内部对"落回原位"这类空操作已经处理好）。
      useTabs.getState().reorderTab(drag.tabId, tabBarIndex)
      return
    }
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

  // 标签右键菜单：主页标签没有可拆的窗格、也不可关闭（closeTab 本身对 home 是
  // 空操作），因此不弹出菜单——不是"弹出一个空菜单"，是右键在主页标签上和右键在
  // 已被 contextMenu.ts 全局拦截、终端区域之外的其它空白处一样，什么都不出现。
  const onTabContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>, tab: Tab) => {
    if (tab.kind !== 'term') return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
  }, [])

  const contextMenuTab = contextMenu ? tabs.find((t) => t.id === contextMenu.tabId) : undefined

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
          onContextMenu={(e) => onTabContextMenu(e, t)}
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
      {/* 标签右键菜单：复用 TabPanes.tsx 窗格标题栏那一份 ContextMenu 组件，不写
          第二份。「拆分为独立标签」只在该标签持有多于一个窗格时才出现（单窗格标签
          没有什么可拆的，splitTabPanes 对它是 no-op，这里直接不渲染这一项，不依赖
          调用后的返回值判断）；「关闭标签」始终存在，直接复用既有的 closeTab（含其
          确认逻辑）。 */}
      {contextMenu && contextMenuTab && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            ...(contextMenuTab.panes.length > 1
              ? [{ label: '拆分为独立标签', onSelect: () => useTabs.getState().splitTabPanes(contextMenuTab.id) }]
              : []),
            { label: '关闭标签', onSelect: () => void closeTab(contextMenuTab.id) },
          ]}
          onDismiss={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
