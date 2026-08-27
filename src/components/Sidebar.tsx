import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { resumeThread } from '../actions'
import type { ProjectInfo, ThreadInfo } from '../ipc'
import { dropInsertionIndex, resolveDropTarget } from '../paneDrop'
import { getContentWidth, getPaneSlotRects } from '../paneDropDom'
import { decidePaneFit, MAX_PANES } from '../paneLayout'
import { useDnd } from '../store/dnd'
import { useHint } from '../store/hint'
import { useLayout } from '../store/layout'
import { useSessions } from '../store/sessions'
import { useTabs } from '../store/tabs'
import { basename, formatRelative } from '../time'
import { ThemeSwitcher } from './ThemeSwitcher'

// 与 TabBar.tsx 场景 A 同一个阈值/idiom：拖动超过这个像素距离才判定为拖拽而不是
// 一次普通点击（设计文档要求 "small movement threshold (e.g. 4px)"）。
const DRAG_THRESHOLD_PX = 4

type DragState = { p: ProjectInfo; t: ThreadInfo; startX: number; startY: number; dragging: boolean }

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

  const onItemPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, p: ProjectInfo, t: ThreadInfo) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { p, t, startX: e.clientX, startY: e.clientY, dragging: false }
  }, [])

  const onItemPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    if (!drag.dragging) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return
      drag.dragging = true
    }
    const { tabs, activeId } = useTabs.getState()
    const activeTab = tabs.find((x) => x.id === activeId)
    // 唯一可见的落点区域是激活标签的窗格区（home 标签没有窗格）；不是 term 标签时
    // 落点恒为 null，指示条也不出现。
    if (!activeTab || activeTab.kind !== 'term') {
      useDnd.getState().setTarget(null)
      return
    }
    useDnd.getState().setTarget(resolveDropTarget(getPaneSlotRects(activeTab), e.clientX, e.clientY))
  }, [])

  const onItemPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    const target = useDnd.getState().target
    useDnd.getState().setTarget(null)
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
  }, [])

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
