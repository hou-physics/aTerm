import {
  useCallback,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { pointInRect, resolveTabBarInsertIndex } from '../paneDrop'
import { getPaneRowRect, getTabBarRect, getTabRects } from '../paneDropDom'
import { clampDividerDrag, equalPaneWidths, usablePaneAreaWidth } from '../paneLayout'
import { useDnd } from '../store/dnd'
import { useDragGhost } from '../store/dragGhost'
import { type Pane, type Tab, useTabs } from '../store/tabs'
import { ContextMenu } from './ContextMenu'
import { PanePicker } from './PanePicker'

// 与 TabBar.tsx/Sidebar.tsx 同一个阈值/idiom：拖动超过这个像素距离才判定为拖拽而不是
// 一次普通点击。
const DRAG_THRESHOLD_PX = 4

type TitlebarDragState = { startX: number; startY: number; dragging: boolean; ghostStarted: boolean }

// 窗格标题栏（设计文档 §4）：仅在标签持有多于一个窗格时渲染（单窗格与现状保持一致，
// 不占高度）。左侧标题过长用 CSS 省略号截断；右侧 × 关闭该窗格。聚焦窗格用强调色
// 标出（既有 CSS 变量，不新增调色板条目）。
//
// 同时是"把窗格拖出成独立标签"的拖拽手柄（设计文档 §5-C，用户明确要求的"拖进来"的
// 反向操作）：与 TabBar.tsx/Sidebar.tsx 同一套 pointerdown/move/up + setPointerCapture
// idiom，不写第二套。松手时若光标仍停留在源标签自己的窗格行（`.term-wrap`）范围内，
// 视为"没有真的拖出去"，不做任何事；若停留在标签栏（`.tabbar`）上，按落点算出的位置
// 插入新标签；否则（拖到窗格区之外的任意其它地方）追加到标签栏末尾。
//
// 右键（onContextMenu）打开一个自包含的小菜单（PaneContextMenu.tsx）：「移出为独立
// 标签」调用与拖出去完全相同的 store 方法（只是没有落点，追加到末尾）；「关闭窗格」
// 直接复用 onClose（与 × 按钮同一条路径，含既有确认逻辑）。
function PaneTitleBar({
  tab,
  pane,
  title,
  focused,
  onClose,
}: {
  tab: Tab
  pane: Pane
  title: string
  focused: boolean
  onClose: () => void
}) {
  const dragRef = useRef<TitlebarDragState | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const detach = useCallback(
    (insertAt?: number) => {
      useTabs.getState().detachPaneToNewTab(tab.id, pane.id, insertAt)
    },
    [tab.id, pane.id],
  )

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.pane-titlebar-close')) return
    // 屏蔽文本选择，只加 body class，不调用 e.preventDefault()——与 TabBar.tsx/
    // Sidebar.tsx 同一理由/同一时机（见 store/dragGhost.ts 的 blockSelect() 注释）。
    // 这一点在这里格外关键：右键菜单（PaneContextMenu）就渲染在这个标题栏的 DOM 子树
    // 里（position:fixed 只改视觉位置，不改它仍是这个 pointerdown 处理器的后代这一
    // 事实），点击菜单项时 pointerdown 会先冒泡到这里——上一轮在这里无条件
    // preventDefault 正是"移出为独立标签"点不动这个回归的根源：会抑制冒泡到这里的
    // 那个 pointerdown 所对应的、菜单项自己随后应该正常触发的合成 click。真正的默认
    // 动作抑制挪到了下面 onPointerMove 里，只在跨过阈值、确认是拖拽后才调用。
    useDragGhost.getState().blockSelect()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, dragging: false, ghostStarted: false }
  }, [])

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      if (!drag.dragging) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return
        drag.dragging = true
      }
      // 真正开始拖拽了才抑制默认行为，与 TabBar.tsx/Sidebar.tsx 同一理由/同一时机。
      e.preventDefault()
      if (!drag.ghostStarted) {
        drag.ghostStarted = true
        useDragGhost.getState().start(pane.title, e.clientX, e.clientY)
      } else {
        useDragGhost.getState().move(e.clientX, e.clientY)
      }
      const tabBarRect = getTabBarRect()
      if (tabBarRect && pointInRect(e.clientX, e.clientY, tabBarRect)) {
        useDnd.getState().setTabBarIndex(resolveTabBarInsertIndex(getTabRects(), e.clientX))
      } else {
        useDnd.getState().setTabBarIndex(null)
      }
    },
    [pane.title],
  )

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      dragRef.current = null
      e.currentTarget.releasePointerCapture?.(e.pointerId)
      const tabBarIndex = useDnd.getState().tabBarIndex
      useDnd.getState().setTabBarIndex(null)
      // 无条件调用，与 TabBar.tsx/Sidebar.tsx 同一理由：任何后续 return 都不会让
      // body class 卡住；这个函数同时接在 onPointerUp 和 onPointerCancel 上。
      useDragGhost.getState().end()
      if (!drag || !drag.dragging) return
      const rowRect = getPaneRowRect(tab.id)
      if (rowRect && pointInRect(e.clientX, e.clientY, rowRect)) return // 仍在源标签自己的窗格行里：没有真的拖出去
      detach(tabBarIndex ?? undefined)
    },
    [tab.id, detach],
  )

  const onContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  return (
    <div
      className={`pane-titlebar${focused ? ' pane-titlebar-focused' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
    >
      <span className="pane-titlebar-title" title={title}>{title}</span>
      <span className="pane-titlebar-close" onClick={onClose}>×</span>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            { label: '移出为独立标签', onSelect: () => detach() },
            { label: '关闭窗格', onSelect: onClose },
          ]}
          onDismiss={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

// 相邻窗格之间的拖拽分隔条：与 ConversationPanel.tsx 的宽度/时间线高度手柄同一套
// pointerdown/move/up + setPointerCapture 模式（复用既有拖拽idiom，不发明第二种写法），
// 只是这里驱动的是 Tab.paneWidths 里两个相邻项的占比，纯数学部分委托给
// paneLayout.ts 的 clampDividerDrag（同一份逻辑也在 paneLayout.test.ts 里被单独当
// 纯函数测试，覆盖 jsdom 测不到的真实拖拽）。
function PaneDivider({ tab, index, rowRef }: { tab: Tab; index: number; rowRef: RefObject<HTMLDivElement | null> }) {
  const dragRef = useRef<{ startX: number; startWidths: number[]; containerWidth: number } | null>(null)

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture?.(e.pointerId)
      // rowRef.current.clientWidth 是 .term-wrap 的量出值，包含它自身的水平内边距、
      // 全部分隔条的固定宽度、以及每个窗格自己的边框——这些都不是能分给窗格内容区的
      // 那部分空间，先用 usablePaneAreaWidth 扣掉，clampDividerDrag 的 320px 下限才
      // 真的对应渲染出来的窗格内容宽度（见 paneLayout.ts 顶部注释）。
      const containerWidth = usablePaneAreaWidth(rowRef.current?.clientWidth ?? 0, tab.panes.length)
      const widths = tab.paneWidths ?? equalPaneWidths(tab.panes.length)
      dragRef.current = { startX: e.clientX, startWidths: widths, containerWidth }
    },
    [tab, rowRef],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      const deltaPx = e.clientX - drag.startX
      const next = clampDividerDrag(drag.startWidths, index, deltaPx, drag.containerWidth)
      useTabs.getState().setPaneWidths(tab.id, next)
    },
    [tab.id, index],
  )

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }, [])

  const onDoubleClick = useCallback(() => {
    useTabs.getState().setPaneWidths(tab.id, equalPaneWidths(tab.panes.length))
  }, [tab.id, tab.panes.length])

  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="vertical"
      title="拖动调整窗格宽度（双击恢复等分）"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    />
  )
}

function PaneItem({
  tab,
  pane,
  width,
  showTitlebar,
}: {
  tab: Tab
  pane: Pane
  width: number
  showTitlebar: boolean
}) {
  const focused = tab.activePaneId === pane.id

  // 点击窗格内任意位置即聚焦该窗格（设计文档 §6）；用捕获阶段而不是冒泡阶段的
  // onClick，确保即便点在 xterm 内部（它自己会处理点击、可能不冒泡出干净的合成
  // click）也一定能先拿到这次指针事件。已经是焦点窗格时不重复 set，避免空转。
  const onPointerDownCapture = useCallback(() => {
    if (tab.activePaneId !== pane.id) useTabs.getState().focusPane(tab.id, pane.id)
  }, [tab.id, tab.activePaneId, pane.id])

  const onClose = useCallback(() => {
    void useTabs.getState().closePane(tab.id, pane.id)
  }, [tab.id, pane.id])

  return (
    <div
      className={`pane${showTitlebar && focused ? ' pane-focused' : ''}`}
      style={{ flexGrow: width, flexShrink: 0, flexBasis: 0 }}
      onPointerDownCapture={onPointerDownCapture}
      // 拖放落点解析（设计文档 §5-B）的稳定查询锚点：与只在持有 PTY 时才出现的
      // data-pane-slot（TerminalLayer.tsx 专用，供绝对定位终端包裹层）不同，这里
      // 不管窗格是终端还是还在待选（PanePicker）都恒定存在——拖拽落点需要覆盖
      // 全部窗格，不只是已经启动终端的那些。见 paneDrop.ts / TabBar.tsx / Sidebar.tsx。
      data-pane-id={pane.id}
    >
      {showTitlebar && <PaneTitleBar tab={tab} pane={pane} title={pane.title} focused={focused} onClose={onClose} />}
      {/* 只是几何占位：真正的 <TerminalView> 现在渲染在 TerminalLayer.tsx（App.tsx 里
          与本组件同级挂载的扁平终端层），不再嵌在这棵随标签切换/窗格增删而反复变化的
          子树里——这正是本次重构要解决的问题（终端不该因为布局变化而卸载重挂）。
          data-pane-slot 是 TerminalLayer 反查这块区域实测矩形的唯一线索，不能删；
          没有 ptyId 的窗格（还没选定会话）不挂这个属性，继续在原地渲染 PanePicker，
          与终端层无关。 */}
      <div className="pane-body" data-pane-slot={pane.ptyId ? pane.id : undefined}>
        {!pane.ptyId && <PanePicker tab={tab} paneId={pane.id} />}
      </div>
    </div>
  )
}

// 一个终端标签的窗格行：横向排列该标签的全部 panes（1~3 个），相邻窗格间插入可拖拽
// 分隔条。整行本身沿用原先 .term-wrap 的"始终挂载、用 display 控制显隐"策略——不管
// 标签是否当前激活，它的窗格（标题栏、分隔条、以及持有 PTY 的窗格那个几何占位插槽，
// 见 PaneItem 里的 data-pane-slot）都保持挂载，只是非激活标签整行 display:none
// （设计文档 §10 风险表里"多个 xterm 实例同时存在"就是这个既有代价，分屏并未加剧
// 机制本身，只是同一标签内可能同时有多个）。真正的 TerminalView/xterm 实例不再嵌在
// 这棵子树里，而是扁平挂载在 TerminalLayer.tsx（与本组件同级，见该文件顶部注释），
// 按上面这些插槽的实测矩形绝对定位覆盖上去——这样"标签是否激活"只影响布局与显隐，
// 不再影响 xterm 实例本身是否存在，为将来"把窗格拖进另一个标签"铺路。
export function TabPanes({ tab, isActiveTab }: { tab: Tab; isActiveTab: boolean }) {
  const rowRef = useRef<HTMLDivElement>(null)
  const widths = tab.paneWidths ?? equalPaneWidths(tab.panes.length)
  const showTitlebar = tab.panes.length > 1

  const children: ReactNode[] = []
  tab.panes.forEach((pane, i) => {
    children.push(
      <PaneItem
        key={pane.id}
        tab={tab}
        pane={pane}
        width={widths[i] ?? 1 / tab.panes.length}
        showTitlebar={showTitlebar}
      />,
    )
    if (i < tab.panes.length - 1) {
      children.push(<PaneDivider key={`divider-${pane.id}`} tab={tab} index={i} rowRef={rowRef} />)
    }
  })

  return (
    <div ref={rowRef} className="term-wrap" data-tab-id={tab.id} style={{ display: isActiveTab ? 'flex' : 'none' }}>
      {children}
    </div>
  )
}
