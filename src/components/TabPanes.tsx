import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { clampDividerDrag, equalPaneWidths } from '../paneLayout'
import { type Pane, type Tab, useTabs } from '../store/tabs'
import { PanePicker } from './PanePicker'
import { TerminalView } from './TerminalView'

// 窗格标题栏（设计文档 §4）：仅在标签持有多于一个窗格时渲染（单窗格与现状保持一致，
// 不占高度）。左侧标题过长用 CSS 省略号截断；右侧 × 关闭该窗格。聚焦窗格用强调色
// 标出（既有 CSS 变量，不新增调色板条目）。
function PaneTitleBar({ title, focused, onClose }: { title: string; focused: boolean; onClose: () => void }) {
  return (
    <div className={`pane-titlebar${focused ? ' pane-titlebar-focused' : ''}`}>
      <span className="pane-titlebar-title" title={title}>{title}</span>
      <span className="pane-titlebar-close" onClick={onClose}>×</span>
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
      const containerWidth = rowRef.current?.clientWidth ?? 0
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
  isActiveTab,
}: {
  tab: Tab
  pane: Pane
  width: number
  showTitlebar: boolean
  isActiveTab: boolean
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
    >
      {showTitlebar && <PaneTitleBar title={pane.title} focused={focused} onClose={onClose} />}
      <div className="pane-body">
        {pane.ptyId ? (
          <TerminalView ptyId={pane.ptyId} active={isActiveTab && focused} />
        ) : (
          <PanePicker tab={tab} paneId={pane.id} />
        )}
      </div>
    </div>
  )
}

// 一个终端标签的窗格行：横向排列该标签的全部 panes（1~3 个），相邻窗格间插入可拖拽
// 分隔条。整行本身沿用原先 .term-wrap 的"始终挂载、用 display 控制显隐"策略——不管
// 标签是否当前激活，它的窗格（以及内部的 TerminalView/xterm 实例）都保持挂载，只是
// 非激活标签整行 display:none（设计文档 §10 风险表里"多个 xterm 实例同时存在"就是
// 这个既有代价，分屏并未加剧机制本身，只是同一标签内可能同时有多个）。
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
        isActiveTab={isActiveTab}
      />,
    )
    if (i < tab.panes.length - 1) {
      children.push(<PaneDivider key={`divider-${pane.id}`} tab={tab} index={i} rowRef={rowRef} />)
    }
  })

  return (
    <div ref={rowRef} className="term-wrap" style={{ display: isActiveTab ? 'flex' : 'none' }}>
      {children}
    </div>
  )
}
