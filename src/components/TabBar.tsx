import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { newConversation, newTerminal, resumeThread } from '../actions'
import { attachDragSafetyNet } from '../dragSafetyNet'
import { DRAG_THRESHOLD_PX, pointInRect, resolveDropMode, resolveDropTarget, resolveTabBarInsertIndex } from '../paneDrop'
import { getContentWidth, getPaneSlotRects, getTabBarRect, getTabRects } from '../paneDropDom'
import { previewPaneDrop } from '../paneLayout'
import { useDnd } from '../store/dnd'
import { useDragGhost } from '../store/dragGhost'
import { useHint } from '../store/hint'
import { useLayout } from '../store/layout'
import { type Tab, useTabs } from '../store/tabs'
import { ContextMenu } from './ContextMenu'
import { type SessionPick, SessionPicker } from './SessionPicker'

// 「＋」的浮层：与 ContextMenu.tsx 同一套"portal 到 document.body + 视口钳制 +
// 三种关闭方式（点外部/Esc/窗口失焦）"，只是内容换成 SessionPicker 而不是菜单项
// 列表——定位/关闭逻辑不重复实现第三套，直接照抄 ContextMenu 的做法（那份实现
// 已经解决过"菜单是拖拽手柄的 DOM 后代导致 pointerCapture 吞掉 click"这类问题，
// 见 ContextMenu.tsx 顶部注释）。不传 defaultProject 给 SessionPicker——「＋」不像
// PanePicker 那样有一个"来源窗格"可以推断项目，「新对话」应当列出全部项目供选。
function PlusMenu({
  x,
  y,
  onPick,
  onDismiss,
}: {
  x: number
  y: number
  onPick: (pick: SessionPick) => void
  onDismiss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { offsetWidth: w, offsetHeight: h } = el
    if (w === 0 && h === 0) return
    const clampedX = Math.max(4, Math.min(x, window.innerWidth - w - 4))
    const clampedY = Math.max(4, Math.min(y, window.innerHeight - h - 4))
    setPos({ x: clampedX, y: clampedY })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    const t = setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true)
      window.addEventListener('keydown', onKeyDown, true)
      window.addEventListener('blur', onDismiss)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onDismiss)
    }
  }, [onDismiss])

  return createPortal(
    <div ref={ref} className="plus-menu" style={{ left: pos.x, top: pos.y }}>
      <SessionPicker onPick={onPick} />
    </div>,
    document.body,
  )
}

// id：每次 pointerdown 分配的单调递增拖拽序号，见下方 nextDragIdRef 与 onTabPointerDown
// 注释——dragSafetyNet.ts 的 isDragActive() 靠它辨认"自己是不是仍然对应当前这次拖拽"，
// 不是只看 dragRef.current 是否非空。
type DragState = { tabId: string; startX: number; startY: number; dragging: boolean; ghostStarted: boolean; pointerId: number; id: number }

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
  // 窗口级兜底监听器的卸载函数，见 dragSafetyNet.ts 顶部注释。与 dragRef 分开存放
  // （不塞进 DragState 里）：endDrag() 需要先调用它再清空 dragRef，顺序反过来的话
  // 兜底监听器里读 dragRef.current 的 isDragActive() 就会先一步看到 null。
  const netCleanupRef = useRef<(() => void) | null>(null)
  // 每次 pointerdown 递增一次，赋给这次拖拽的 DragState.id——见 onTabPointerDown 与
  // dragSafetyNet.ts 顶部"调用方每次挂网时……"那段注释。
  const nextDragIdRef = useRef(0)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number } | null>(null)

  // 「＋」不再直接开一个空终端，而是弹出与 ⌘D 空窗格同一套 SessionPicker，让用户
  // 挑「新终端 / 新对话（选项目） / 恢复某条会话」——⌘T 仍然是"我就要一个 shell"
  // 的快捷路径，两者分工不同，见 App.tsx 里 ⌘T 的处理器（本任务未改动它）。
  const onPlusClick = useCallback((e: ReactMouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setPlusMenu({ x: r.left, y: r.bottom + 4 })
  }, [])

  const onPlusPick = useCallback((pick: SessionPick) => {
    setPlusMenu(null)
    if (pick.kind === 'shell') { void newTerminal(); return }
    if (pick.kind === 'newConversation') { void newConversation(pick.project.cwd); return }
    void resumeThread(pick.project.dirName, pick.project.cwd, pick.thread)
  }, [])

  // 拖拽清理的唯一入口：pointerup/pointercancel（同一个 onTabPointerUp）、
  // lostpointercapture（指针捕获被浏览器隐式释放——例如被拖的标签因为其它原因中途
  // 移出 DOM，浏览器不会补发 pointerup，只会发 lostpointercapture，见下方
  // onTabLostPointerCapture）、组件卸载兜底（下面的 effect）、以及窗口级兜底
  // （dragSafetyNet.ts，指针捕获丢失的时序不可靠，窗口级监听不依赖被拖元素是否仍在
  // DOM 中，是最后一道保险）——五条退出路径全部委托给这一个函数，不写第二份清理逻辑。
  // 它对"根本没有拖拽在进行"是安全的空操作：触碰的三处状态——useDnd 的
  // target/tabBarIndex、useDragGhost——本身都已经是幂等的（反复调用不产生任何新的
  // 可观察效果，见各自文件顶部注释），因此这里不需要再加一层"是否已经清理过"的判断，
  // 被调用多次（例如 lostpointercapture 之后又收到 pointerup，或窗口级兜底与正常路径
  // 前后各触发一次）也完全无害。
  const endDrag = useCallback(() => {
    netCleanupRef.current?.()
    netCleanupRef.current = null
    dragRef.current = null
    useDnd.getState().setTarget(null)
    useDnd.getState().setDropMode(null)
    useDnd.getState().setRefusal(null)
    useDnd.getState().setTabBarIndex(null)
    useDragGhost.getState().end()
  }, [])

  // 组件卸载时若仍有一次拖拽正在进行，同样要清理，否则 body.dragging-no-select/
  // dragging-grab 会永久卡住——不依赖任何后续事件触发（卸载之后这个元素上不会再有
  // 任何指针事件），必须在这里主动兜底。
  useEffect(() => {
    return () => {
      if (dragRef.current) endDrag()
    }
  }, [endDrag])

  const onTabPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, tabId: string) => {
    // 关闭按钮自己的点击语义（stopPropagation + closeTab）不参与拖拽判定，原样放行。
    if ((e.target as HTMLElement).closest('.tab-close')) return
    // 纵深防御，与 TabPanes.tsx 的 PaneTitleBar 同一理由：标签右键菜单本身已经
    // portal 到 document.body（见 ContextMenu.tsx），本就不是这个 `.tab` 元素的
    // DOM 后代，这条分支目前不会被真的命中（本文件的菜单原本渲染在 `.tabbar` 下，
    // 与各 `.tab` 是兄弟节点，不是嵌套关系——见 .superpowers/context-menu-portal-
    // report.md 的排查记录）；保留它是防止将来这层关系改变时同一类问题重演。
    if ((e.target as HTMLElement).closest('.context-menu')) return
    // 屏蔽文本选择（用户反馈"拖拽会顺带选中相邻文字"）：只加 body class，不调用
    // e.preventDefault()——上一轮在这里无条件 preventDefault 是回归的根源（见
    // store/dragGhost.ts 的 blockSelect() 注释）：真正的默认动作抑制挪到了下面
    // onTabPointerMove 里，只在确认跨过 4px 阈值、真的开始拖拽后才调用，一次普通
    // 点击（pointerdown 后没有明显移动就 up）因此永远不会被 preventDefault 影响，
    // 随后的原生 click 照常触发。
    useDragGhost.getState().blockSelect()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const dragId = ++nextDragIdRef.current
    dragRef.current = { tabId, startX: e.clientX, startY: e.clientY, dragging: false, ghostStarted: false, pointerId: e.pointerId, id: dragId }
    // 挂新网前先摘掉任何仍然挂着的旧网：正常情况下不该有残留（endDrag() 是唯一出口，
    // 每次拖拽结束都会摘网），这里是防止极端时序下旧网泄漏、永远留在 window 上的
    // 第二道保险。见 dragSafetyNet.ts 顶部注释。
    netCleanupRef.current?.()
    // 窗口级兜底：见 dragSafetyNet.ts 顶部注释。在这里（拖拽开始的唯一入口）挂上，
    // 在 endDrag()（拖拽结束的唯一出口）里摘掉，二者是同一对，不会有挂了忘摘的情况。
    // isDragActive 不只看 dragRef.current 是否非空，还要求它的 id 与这次拖拽自己的
    // dragId 一致——万一上面这道"先摘旧网"的保险还是没能防住某张旧网存活下来，它也
    // 不会把一次更新的拖拽（属于不同 dragId）误判成自己仍然存活，从而打断新拖拽。
    netCleanupRef.current = attachDragSafetyNet(
      e.pointerId,
      () => dragRef.current !== null && dragRef.current.id === dragId,
      endDrag,
    )
  }, [endDrag])

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
    //
    // 这里问的必须是"是不是主页标签"，不能是"是不是 term 标签"：总览标签（Task 8 新增
    // 的第三种 kind）没有窗格，但它和普通标签一样排在可滚动的标签列表里，reorderTab
    // （tabs.ts）对它完全适用——它只认下标、不认 kind。此前这一行写成
    // `kind !== 'term'`，整个手势在起步就被判无效，拖动总览标签什么都不会发生，也没有
    // 任何反馈。两条落点分支现在分别把关：标签栏排序对总览开放（下面），拖进窗格区
    // 合并仍然只对 term 开放（再下面）。
    if (!dragTab || dragTab.kind === 'home') {
      useDnd.getState().setTarget(null)
      useDnd.getState().setDropMode(null)
      useDnd.getState().setRefusal(null)
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
      const clampedIndex = Math.max(1, rawIndex) // 不能插到主页标签前面
      useDnd.getState().setTabBarIndex(clampedIndex)
      useDnd.getState().setTarget(null)
      useDnd.getState().setDropMode(null)
      useDnd.getState().setRefusal(null)
      if (!drag.ghostStarted) {
        drag.ghostStarted = true
        useDragGhost.getState().start(dragTab.title, e.clientX, e.clientY)
      } else {
        useDragGhost.getState().move(e.clientX, e.clientY)
      }
      return
    }
    useDnd.getState().setTabBarIndex(null)
    // 光标落在窗格区：这条分支是"把拖拽源的窗格合并进当前激活标签"，只有 term 标签
    // 有窗格可搬——总览标签在上面那条标签栏分支里是可以排序的，但拖到窗格区上没有
    // 任何可落的语义（movePanesToTab/fillEmptyPane 对它都是空操作，见 tabs.ts 里
    // 那两处 `sourceTab.kind !== 'term'` 的判定）。在这里清掉落点状态、不出 ghost、
    // 不出指示条，与主页标签在整个手势上的"no visual churn"是同一种处理，只是范围
    // 限于这一条分支。松手路径（onTabPointerUp）里既有的同一条判定继续兜底。
    if (dragTab.kind !== 'term') {
      useDnd.getState().setTarget(null)
      useDnd.getState().setDropMode(null)
      useDnd.getState().setRefusal(null)
      // 但 ghost 一旦已经在标签栏上起来了就得继续跟手（不是冻在原地——那看着像卡
      // 死）。它只在拖拽源是总览标签、且用户从标签栏一路拖进窗格区时才会走到这里；
      // 主页标签根本不会起 ghost，所以那条路径不受影响。
      if (drag.ghostStarted) useDragGhost.getState().move(e.clientX, e.clientY)
      return
    }
    // 拖的正是当前激活标签本身时（"拖到自己标签的窗格区"）依旧是设计文档明确要求的
    // 空操作——这条判定只在这个分支里生效，不影响上面标签栏排序那条分支。
    if (dragTab.id === activeId) {
      useDnd.getState().setTarget(null)
      useDnd.getState().setDropMode(null)
      useDnd.getState().setRefusal(null)
      return
    }
    if (!drag.ghostStarted) {
      drag.ghostStarted = true
      useDragGhost.getState().start(dragTab.title, e.clientX, e.clientY)
    } else {
      useDragGhost.getState().move(e.clientX, e.clientY)
    }
    const activeTab = tabs.find((t) => t.id === activeId)
    const target = resolveDropTarget(getPaneSlotRects(activeTab), e.clientX, e.clientY)
    useDnd.getState().setTarget(target)
    // 实时预览这次拖放会不会被接受（Fix 3：不能等到 pointerup 才让用户知道）——按
    // 落点语义（目标窗格是否是空槽，见 paneDrop.ts 的 resolveDropMode）算出真正的
    // 结果窗格数，与 onTabPointerUp 真正执行时共用同一份 previewPaneDrop，保证"指示
    // 说能放"与"松手确实能放"永远一致。
    if (!target || !activeTab) {
      useDnd.getState().setDropMode(null)
      useDnd.getState().setRefusal(null)
      return
    }
    const targetPane = activeTab.panes.find((p) => p.id === target.paneId)
    const mode = resolveDropMode(targetPane)
    useDnd.getState().setDropMode(mode)
    const layout = useLayout.getState()
    const preview = previewPaneDrop(mode, activeTab.panes.length, dragTab.panes.length, getContentWidth(), layout.panelCollapsed, layout.panelWidth)
    useDnd.getState().setRefusal(preview.refused ? { reason: preview.reason! } : null)
  }, [])

  const onTabPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    // 落点状态在调用 endDrag()（会清空它们）之前先取出来——releasePointerCapture 在
    // 真实浏览器里可能同步触发下面的 onTabLostPointerCapture（它也会调用 endDrag()），
    // 提前读好这两个值就不受调用顺序影响。
    const target = useDnd.getState().target
    const tabBarIndex = useDnd.getState().tabBarIndex
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    // 无条件调用，任何后续 return 都不可能让屏蔽选择的 body class 卡住；这个函数同时
    // 接在 onPointerUp 和 onPointerCancel 上，两条退出路径因此都被覆盖。与
    // onTabLostPointerCapture/卸载 effect 共用同一个 endDrag()，被调用第二次
    // （例如上面的 releasePointerCapture 已经先触发过一次）也是安全的空操作。
    endDrag()
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
    // 目标窗格没有 ptyId（空槽，⌘D 新建后还没选定会话）：这次拖放是"填充"，取代它的
    // 位置，结果窗格数不变；否则是既有的"插入"行为。与 onTabPointerMove 的实时预览
    // 共用同一份 resolveDropMode/previewPaneDrop，保证判断一致（见那边的注释）。
    const targetPane = targetTab.panes.find((p) => p.id === target.paneId)
    const mode = resolveDropMode(targetPane)
    const layout = useLayout.getState()
    // getContentWidth() 量出的是包含内边距/分隔条/窗格边框开销的原始宽度，previewPaneDrop
    // 内部按结果窗格数换算成真正可用宽度——否则这条拖放路径会比 ⌘D 更容易"误判装得下"
    // （见本次修复说明）。
    const preview = previewPaneDrop(mode, targetTab.panes.length, sourceTab.panes.length, getContentWidth(), layout.panelCollapsed, layout.panelWidth)
    if (preview.refused) {
      // 轻提示文案沿用既有两句固定文案（不是 preview.reason 里带具体差额的那句实时
      // 提示——那句已经在拖拽过程中持续显示过了，这里的一次性轻提示只是复盘同一个
      // 结论，保持与 ⌘D/既有拖放行为一致的措辞）。
      useHint.getState().show(preview.refusalKind === 'max-panes' ? '最多支持 3 个窗格' : '窗口太窄，放不下新窗格')
      return
    }
    // collapsePanelKeepingWindow 而非 togglePanel：同 Sidebar.tsx/App.tsx ⌘D 处理器
    // 那处一样的理由——这里要的是"收起面板腾出终端内容区宽度"，togglePanel 现在会联动
    // 缩窗口、终端区宽度不变，腾不出空间。
    if (preview.decision === 'collapse-panel') layout.collapsePanelKeepingWindow()
    if (mode === 'fill' && targetPane) {
      useTabs.getState().fillEmptyPane(drag.tabId, activeId, targetPane.id)
    } else {
      useTabs.getState().movePanesToTab(drag.tabId, activeId, target)
    }
  }, [endDrag])

  // 指针捕获被浏览器隐式释放时补发的退出路径（例如被拖的标签因为其它原因中途移出
  // DOM——同一份拖拽 idiom 用在 Sidebar.tsx 的「最近会话」列表上就是真实会发生的
  // 场景：该列表在 window focus 时 refresh()，可能把正被拖拽的会话项挤出前 12 条，
  // 使其从 DOM 中消失。浏览器此时不会补发 pointerup，只会发 lostpointercapture）。
  // 这里只做清理，不尝试识别落点或完成任何动作——指针已经不再受我们控制，与"松手
  // 落空"是同一处理（不完成这次拖拽）。
  const onTabLostPointerCapture = useCallback(() => {
    endDrag()
  }, [endDrag])

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

  // 标签右键菜单（「拆分为独立标签」/「关闭标签」）只对 term 标签弹出。两种被排除的
  // 标签理由不同，各自成立：
  // - 主页：两项都不适用（没有窗格可拆；closeTab 对 home 本就是空操作）；
  // - 总览：「拆分为独立标签」不适用（panes 恒为空数组），「关闭标签」其实适用——但
  //   关闭它已经有 × 按钮和 ⌘W 两个入口，为它单独弹一个只剩一项、且与 × 完全重复的
  //   菜单没有增益。终审复核过这一处，判定保持现状；这不是遗漏。
  // 排除的表现是"什么都不出现"，不是"弹出一个空菜单"——右键在这些标签上，和右键在
  // 已被 contextMenu.ts 全局拦截、终端区域之外的其它空白处一样。
  const onTabContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>, tab: Tab) => {
    if (tab.kind !== 'term') return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
  }, [])

  const contextMenuTab = contextMenu ? tabs.find((t) => t.id === contextMenu.tabId) : undefined

  // 单个标签自身的渲染——主页标签（钉在标签栏最左侧那组固定元素里）与其余可滚动的
  // 标签共用同一份 JSX/事件接线，不重复写两遍，只是挂载的位置不同（见下方
  // .tabbar-pinned 与 restTabs.map）。
  const renderTab = (t: Tab) => (
    <div
      key={t.id}
      data-tab-id={t.id}
      className={`tab ${t.id === activeId ? 'active' : ''}`}
      onPointerDown={(e) => onTabPointerDown(e, t.id)}
      onPointerMove={onTabPointerMove}
      onPointerUp={onTabPointerUp}
      onPointerCancel={onTabPointerUp}
      onLostPointerCapture={onTabLostPointerCapture}
      onClick={() => onTabClick(t.id)}
      onContextMenu={(e) => onTabContextMenu(e, t)}
    >
      <span className="tab-title">{t.kind === 'home' ? '⌂' : t.title}</span>
      {t.kind !== 'home' && (
        <span className="tab-close" onClick={(e) => { e.stopPropagation(); void closeTab(t.id) }}>×</span>
      )}
    </div>
  )

  // 主页标签恒为 tabs[0]（设计要求：既不能被顶替，也不可被拖动排序，见 reorderTab/
  // detachPaneToNewTab 里对 insertAt 的钳位），因此这里可以放心地把它和「＋」一起
  // 从可滚动的标签列表里摘出来，放进下面的 .tabbar-pinned。
  const [homeTab, ...restTabs] = tabs

  return (
    <div className="tabbar">
      {/* 「＋」新建标签按钮固定在标签栏最左侧、紧邻主页标签（用户反馈：标签一多，
          原先排在最右端的按钮会被滚动条推出视野，必须先把标签栏滚到底才能新建
          标签）。与侧边栏折叠按钮、主页标签一起放进同一个 position: sticky 容器
          （见 App.css 的 .tabbar-pinned 注释），三者作为一个整体钉住，其余标签从
          它们下面滚过去，不会互相重叠。行为/文案/⌘T 快捷键均未改动。 */}
      <div className="tabbar-pinned">
        <button
          type="button"
          className="sidebar-toggle"
          onClick={() => toggleSidebar()}
          title={sidebarCollapsed ? '展开侧边栏 (⌘B)' : '折叠侧边栏 (⌘B)'}
        >
          {sidebarCollapsed ? '›' : '‹'}
        </button>
        {homeTab && renderTab(homeTab)}
        <button
          type="button"
          className="tab-new"
          onClick={onPlusClick}
          title="新建标签"
        >
          ＋
        </button>
      </div>
      {restTabs.map(renderTab)}
      {/* 展开之后，收起交给面板自己顶栏的按钮（ConversationPanel.tsx 的
          conv-collapse-toggle）——"收起某个东西的控件应该长在那个东西身上"。这个
          按钮因此只在面板已收起时才渲染，只负责展开，不再兼任收起。 */}
      {panelCollapsed && (
        <button
          type="button"
          className="panel-toggle"
          onClick={() => togglePanel()}
          title="显示对话面板 (⌘J)"
        >
          ‹
        </button>
      )}
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
      {/* 「＋」的会话选择浮层，见上方 PlusMenu 注释。 */}
      {plusMenu && (
        <PlusMenu x={plusMenu.x} y={plusMenu.y} onPick={onPlusPick} onDismiss={() => setPlusMenu(null)} />
      )}
    </div>
  )
}
