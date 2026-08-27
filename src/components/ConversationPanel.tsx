import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { firstLineSummary, formatTimeHM, groupUserTurnsByDate } from '../conversation'
import { readConversation, type Conversation } from '../ipc'
import { PANEL_WIDTH_DEFAULT, useLayout } from '../store/layout'
import { useTabs } from '../store/tabs'

function scrollToTurn(uuid: string) {
  document.getElementById(`turn-${uuid}`)?.scrollIntoView({ block: 'start' })
}

// 面板宽度拖到超过窗口宽度的一部分观感很怪（把终端挤没了），额外封顶到窗口宽度的 60%。
// 只在拖拽/双击复位这些"主动改宽度"的时刻现算，不装 window resize 监听器——
// 窗口后续变化不会主动收窄已设定的宽度，下次拖拽时才会重新生效。
function windowCap(px: number): number {
  return Math.min(px, window.innerWidth * 0.6)
}

export function ConversationPanel() {
  const dirName = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.dirName)
  const rootKey = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.rootKey)
  const [conv, setConv] = useState<Conversation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 时间线各日期分组的展开状态：不持久化，每次会话内容更新（切标签、手动刷新）都
  // 重新播种为"只展开最新一天"，与 requestIdRef 的过期响应防护相互独立，互不影响。
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())
  // 面板从不随标签切换重新挂载（App.tsx 里没有 key），所以必须自行区分"过期"响应：
  // 每次发起请求（无论来自下面的 effect 还是手动刷新按钮）都领取一个新的请求代，
  // 只有仍是当前最新代的响应才允许写入 state。这样切标签前触发的旧请求、或切走后
  // 才点的刷新，晚到时都会被静默丢弃，不会覆盖当前激活标签已经显示的内容。
  const requestIdRef = useRef(0)

  // 与 setConv 在同一次状态更新里调用（React 会自动批处理），确保"分组数据到位"与
  // "展开状态播种"在同一帧提交，不会出现分组已渲染、但仍显示折叠态的过渡帧。
  const seedExpandedDates = useCallback((c: Conversation | null) => {
    const groups = c ? groupUserTurnsByDate(c.turns) : []
    setExpandedDates(groups.length > 0 ? new Set([groups[0].key]) : new Set())
  }, [])

  const load = useCallback(() => {
    if (!dirName || !rootKey) return
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    readConversation(dirName, rootKey)
      .then((c) => {
        if (requestIdRef.current === requestId) {
          setConv(c)
          seedExpandedDates(c)
        }
      })
      .catch((e) => {
        if (requestIdRef.current === requestId) {
          setError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false)
      })
  }, [dirName, rootKey, seedExpandedDates])

  useEffect(() => {
    // 标签（因而 dirName/rootKey）发生变化时，立即让任何仍在飞行中的旧请求失效——
    // 哪怕新标签没有 dirName/rootKey（此时下面不会发起新请求，也不能让旧请求的
    // 迟到响应有机可乘）。
    requestIdRef.current++
    setConv(null)
    setError(null)
    seedExpandedDates(null)
    if (dirName && rootKey) load()
  }, [dirName, rootKey, load, seedExpandedDates])

  const toggleDateGroup = useCallback((key: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // 拖拽状态本身不必是 React state（不需要触发重渲染），一个 ref 就够；
  // pointerdown 时用 setPointerCapture 把该指针后续的 move/up 都路由回同一个
  // 元素，因此全部用该元素自身的 React 指针事件 props 处理即可，不必挂
  // document 级别的全局监听器（也就没有"忘记移除"的风险）。
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const onResizePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { startX: e.clientX, startWidth: useLayout.getState().panelWidth }
  }, [])

  const onResizePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = e.clientX - drag.startX // 手柄在面板左边缘：指针右移变窄、左移变宽
    useLayout.getState().setPanelWidth(windowCap(drag.startWidth - dx))
  }, [])

  const onResizePointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    useLayout.getState().commitPanelWidth()
  }, [])

  const onResizeDoubleClick = useCallback(() => {
    useLayout.getState().setPanelWidth(windowCap(PANEL_WIDTH_DEFAULT))
    useLayout.getState().commitPanelWidth()
  }, [])

  const panelCollapsed = useLayout((s) => s.panelCollapsed)
  const togglePanel = useLayout((s) => s.togglePanel)
  const panelWidth = useLayout((s) => s.panelWidth)

  // 折叠态：面板不整个消失，收成一条 28px 的竖条（带展开按钮），让"再点一下展开"
  // 有个可点的地方。panelCollapsed 是 store/layout.ts 里唯一的真相来源——面板自己的
  // 折叠按钮、这里的展开按钮、TabBar 的开关按钮、App.tsx 的 ⌘J 全部读写同一个字段，
  // 天然保持同步，不引入第二个标志位。
  if (panelCollapsed) {
    return (
      <aside className="conv-panel-strip">
        <button type="button" className="conv-strip-expand" onClick={() => togglePanel()} title="展开面板 (⌘J)">‹</button>
      </aside>
    )
  }

  const hasThread = Boolean(dirName && rootKey)
  const groups = conv ? groupUserTurnsByDate(conv.turns) : []

  return (
    <aside className="conv-panel-dock" style={{ width: panelWidth }}>
      <div className="conv-panel">
        <div
          className="conv-panel-resize-handle"
          role="separator"
          aria-orientation="vertical"
          title="拖动调整面板宽度（双击复位）"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          onDoubleClick={onResizeDoubleClick}
        />
        <div className="conv-header">
          <span className="conv-title">对话</span>
          <div className="conv-header-actions">
            {hasThread && <button type="button" className="conv-refresh" onClick={() => load()} title="刷新">⟳</button>}
            <button type="button" className="conv-collapse" onClick={() => togglePanel()} title="收起面板 (⌘J)">›</button>
          </div>
        </div>
        {!hasThread && <div className="conv-empty">当前标签没有关联的对话</div>}
        {hasThread && loading && <div className="conv-status">加载中…</div>}
        {hasThread && error && <div className="conv-status conv-error">加载失败：{error}</div>}
        {hasThread && !loading && !error && conv && (
          <>
            <div className="conv-timeline">
              {groups.map((g) => {
                const expanded = expandedDates.has(g.key)
                return (
                  <div key={g.key} className="conv-date-group">
                    <button
                      type="button"
                      className="conv-date-label"
                      aria-expanded={expanded}
                      onClick={() => toggleDateGroup(g.key)}
                    >
                      <span className="conv-date-disclosure">{expanded ? '▾' : '▸'}</span>
                      {g.label}
                      {!expanded && <span className="conv-date-count">({g.turns.length})</span>}
                    </button>
                    {expanded && g.turns.map((t) => (
                      <div key={t.uuid} className="conv-timeline-item" onClick={() => scrollToTurn(t.uuid)}>
                        <span className="time">{formatTimeHM(t.tsMs)}</span>
                        <span className="summary">{firstLineSummary(t.text)}</span>
                      </div>
                    ))}
                  </div>
                )
              })}
              {groups.length === 0 && <div className="conv-status">暂无用户发起的轮次</div>}
            </div>
            <div className="conv-body">
              {conv.turns.map((t) => (
                <div key={t.uuid} id={`turn-${t.uuid}`} className={`conv-turn conv-turn-${t.role}`}>
                  {t.text}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
