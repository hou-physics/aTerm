import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { resumeThread } from '../actions'
import type { ProjectInfo, ThreadInfo } from '../ipc'
import { dropInsertionIndex, resolveDropTarget } from '../paneDrop'
import { getContentWidth, getPaneSlotRects } from '../paneDropDom'
import { decidePaneFit, MAX_PANES } from '../paneLayout'
import { useDnd } from '../store/dnd'
import { useDragGhost } from '../store/dragGhost'
import { useHint } from '../store/hint'
import { useLayout } from '../store/layout'
import { useSessions } from '../store/sessions'
import { useTabs } from '../store/tabs'
import { basename, formatRelative } from '../time'
import { ThemeSwitcher } from './ThemeSwitcher'

// 与 TabBar.tsx 场景 A 同一个阈值/idiom：拖动超过这个像素距离才判定为拖拽而不是
// 一次普通点击（设计文档要求 "small movement threshold (e.g. 4px)"）。
const DRAG_THRESHOLD_PX = 4

type DragState = { p: ProjectInfo; t: ThreadInfo; startX: number; startY: number; dragging: boolean; ghostStarted: boolean }

// 从侧边栏「最近会话」拖入（设计文档 §5-B 场景 B）：落点解析、上限/窄窗口降级判断、
// 轻提示三处都复用与 TabBar.tsx 场景 A 完全相同的纯函数/store（paneDrop.ts、
// paneLayout.ts 的 decidePaneFit、store/hint.ts），只是终点动作不同——不是移动已有
// 窗格，而是"新建一个窗格 + 立即用这条会话启动它"，与 PanePicker.tsx 里
// startResume 选中同一条会话时做的事完全一致（同样的 inject/threadKey/dirName/
// rootKey 拼法），因此这里不做 focusThread 去重：⌘D 选择器本来就不做去重，
// "exactly as if it had been chosen through the ⌘D picker" 意味着这里也不做。
export function Sidebar() {
  const { projects } = useSessions()
  const recent = projects
    .flatMap((p) => p.threads.map((t) => ({ p, t })))
    .sort((a, b) => b.t.lastActivityMs - a.t.lastActivityMs)
    .slice(0, 12)

  const dragRef = useRef<DragState | null>(null)
  // 拖拽落地后浏览器仍会补发一次 click；真的发生过一次拖拽时这次 click 不该再触发
  // 一遍 resumeThread（那样会在新窗格之外，同时在旧的 focusThread/openTerminal 路径
  // 上重复处理同一条会话）。与 TabBar.tsx 同一套一次性抑制手法。
  const suppressClickRef = useRef(false)

  // 拖拽清理的唯一入口，与 TabBar.tsx 的 endDrag 同一理由——这里格外关键：「最近会话」
  // 列表在 window focus 时 refresh()，可能把正被拖拽的那一条会话挤出前 12 条，使其
  // DOM 节点在拖拽中途消失，浏览器不会补发 pointerup，只会发 lostpointercapture（见
  // 下方 onItemLostPointerCapture）。pointerup/pointercancel（同一个 onItemPointerUp）、
  // lostpointercapture、组件卸载兜底（下面的 effect）三条退出路径全部委托给这一个
  // 函数，不写第二份清理逻辑；它触碰的两处状态（useDnd 的 target、useDragGhost）本身
  // 都是幂等的，被调用两次也完全无害。
  const endDrag = useCallback(() => {
    dragRef.current = null
    useDnd.getState().setTarget(null)
    useDragGhost.getState().end()
  }, [])

  // 组件卸载时若仍有一次拖拽正在进行，同样要清理——Sidebar 本身会在 ⌘B 折叠侧边栏时
  // 整个卸载（见 App.tsx 的 `{!sidebarCollapsed && <Sidebar/>}`），不依赖任何后续事件
  // 触发，必须在这里主动兜底。
  useEffect(() => {
    return () => {
      if (dragRef.current) endDrag()
    }
  }, [endDrag])

  const onItemPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, p: ProjectInfo, t: ThreadInfo) => {
    // 屏蔽文本选择，只加 body class，不调用 e.preventDefault()——与 TabBar.tsx 的
    // onTabPointerDown 同一理由/同一时机（见 store/dragGhost.ts 的 blockSelect()
    // 注释）：真正的默认动作抑制挪到了下面 onItemPointerMove 里，只在跨过阈值后才
    // 调用，不影响随后仍会正常触发的合成 click，普通点击会话条目的行为不变。
    useDragGhost.getState().blockSelect()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { p, t, startX: e.clientX, startY: e.clientY, dragging: false, ghostStarted: false }
  }, [])

  const onItemPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    if (!drag.dragging) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return
      drag.dragging = true
    }
    // 真正开始拖拽了才抑制默认行为，与 TabBar.tsx 的 onTabPointerMove 同一理由/同一
    // 时机——从不在 pointerdown 上调用，普通点击因此不受影响。
    e.preventDefault()
    const { tabs, activeId } = useTabs.getState()
    const activeTab = tabs.find((x) => x.id === activeId)
    // 唯一可见的落点区域是激活标签的窗格区（home 标签没有窗格）；不是 term 标签时
    // 落点恒为 null，指示条也不出现，这种情况下也不显示拖拽指示（没有地方可以放）。
    if (!activeTab || activeTab.kind !== 'term') {
      useDnd.getState().setTarget(null)
      return
    }
    if (!drag.ghostStarted) {
      drag.ghostStarted = true
      useDragGhost.getState().start(drag.t.title, e.clientX, e.clientY)
    } else {
      useDragGhost.getState().move(e.clientX, e.clientY)
    }
    useDnd.getState().setTarget(resolveDropTarget(getPaneSlotRects(activeTab), e.clientX, e.clientY))
  }, [])

  const onItemPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    // 落点在调用 endDrag()（会清空它）之前先取出来——releasePointerCapture 在真实
    // 浏览器里可能同步触发下面的 onItemLostPointerCapture（它也会调用 endDrag()），
    // 提前读好这个值就不受调用顺序影响。
    const target = useDnd.getState().target
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    // 无条件调用，与 TabBar.tsx 的 onTabPointerUp 同一理由：任何后续 return 都不会让
    // body class 卡住；与 onItemLostPointerCapture/卸载 effect 共用同一个
    // endDrag()，被调用第二次也是安全的空操作。
    endDrag()
    if (!drag || !drag.dragging) return
    suppressClickRef.current = true
    if (!target) return // 松手时不在任何窗格范围内，视为放弃这次拖拽
    const { tabs, activeId } = useTabs.getState()
    const activeTab = tabs.find((x) => x.id === activeId)
    if (!activeTab || activeTab.kind !== 'term') return
    const nextCount = activeTab.panes.length + 1
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
    const insertAt = dropInsertionIndex(activeTab.panes.map((x) => x.id), target)
    const paneId = useTabs.getState().insertPaneAt(activeTab.id, insertAt)
    if (!paneId) return // 上面已经校验过上限，这里只是防御性兜底，理论上不会命中
    const { p, t } = drag
    void useTabs.getState().startPaneTerminal(activeTab.id, paneId, {
      title: t.title,
      cwd: p.cwd,
      inject: `claude --resume ${t.resumeSessionId}`,
      threadKey: `${p.dirName}:${t.rootKey}`,
      dirName: p.dirName,
      rootKey: t.rootKey,
    })
  }, [endDrag])

  // 指针捕获被浏览器隐式释放时补发的退出路径——见上方 endDrag 注释描述的真实触发
  // 场景（拖拽中的会话项被 refresh() 挤出前 12 条列表）。这里只做清理，不尝试识别
  // 落点或完成任何动作，与"松手落空"是同一处理。
  const onItemLostPointerCapture = useCallback(() => {
    endDrag()
  }, [endDrag])

  const onItemClick = useCallback((p: ProjectInfo, t: ThreadInfo) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    void resumeThread(p.dirName, p.cwd, t)
  }, [])

  return (
    <>
      <div className="sidebar-list">
        <div className="section-label">最近会话</div>
        {recent.map(({ p, t }) => (
          <div
            key={`${p.dirName}:${t.rootKey}`}
            className="side-item"
            title={t.title}
            onPointerDown={(e) => onItemPointerDown(e, p, t)}
            onPointerMove={onItemPointerMove}
            onPointerUp={onItemPointerUp}
            onPointerCancel={onItemPointerUp}
            onLostPointerCapture={onItemLostPointerCapture}
            onClick={() => onItemClick(p, t)}
          >
            {t.title}
            <div className="sub">{basename(p.cwd)} · {formatRelative(t.lastActivityMs)}</div>
          </div>
        ))}
      </div>
      <ThemeSwitcher />
    </>
  )
}
