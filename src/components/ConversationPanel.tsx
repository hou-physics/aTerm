import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { firstLineSummary, formatTimeHM, groupUserTurnsByDate } from '../conversation'
import { readConversation, type Conversation } from '../ipc'
import { PANEL_WIDTH_DEFAULT, TIMELINE_HEIGHT_MIN, useLayout } from '../store/layout'
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

// 时间线区高度同一思路：下限固定 80px（TIMELINE_HEIGHT_MIN，store 层已经钳过），
// 上限是"内容区高度的 60%"这个动态量，只在拖拽这一刻现算（containerHeight 取自
// contentRef，不装 resize 监听器）。containerHeight 取不到（尚未布局、或测试环境
// 没有真实排版）时视为"没有上限"，只由下限兜底，与 windowCap 对 panelWidth 的处理
// 是同一套克制原则。
function timelineHeightCap(px: number, containerHeight: number): number {
  const clamped = Math.max(px, TIMELINE_HEIGHT_MIN)
  if (containerHeight <= 0) return clamped
  return Math.min(clamped, containerHeight * 0.6)
}

export function ConversationPanel() {
  // 派生自「激活标签的激活窗格」，而非直接读标签或拆分 threadKey——窗格才是
  // dirName/rootKey 的持有者（见 store/tabs.ts 的 Pane 类型）。
  const dirName = useTabs((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeId)
    return tab?.panes.find((p) => p.id === tab.activePaneId)?.dirName
  })
  const rootKey = useTabs((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeId)
    return tab?.panes.find((p) => p.id === tab.activePaneId)?.rootKey
  })
  // 提前到这里读取（而不是留在渲染末尾）：下面的 effect 需要把它订阅进依赖数组。
  const panelCollapsed = useLayout((s) => s.panelCollapsed)
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
  // 记录"上一次这个 effect 跑的时候面板是否折叠"，只用来判定折叠 effect 里的
  // catch-up 加载是不是真的踩在一次"折叠 -> 展开"的翻转上（而不是 dirName/
  // rootKey/conv 这些同在依赖数组里的值变化引发的重跑）。初值就是挂载时的
  // panelCollapsed，所以"面板本来就是展开的"这一挂载帧不会被误判成一次翻转。
  const prevCollapsedRef = useRef(panelCollapsed)

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
    // 面板折叠时不发起请求：折叠态整个组件不渲染任何东西，此刻加载纯属后台空耗——
    // 大会话文件的读取/解析可达数十毫秒，没人看得见却依旧要付这个代价。这里读
    // getState() 而非把 panelCollapsed 加进依赖数组：只想在"切标签"这一刻看一眼
    // 当前是否折叠，不想仅仅因为折叠状态翻转就重新跑一遍这个 effect（那样会无谓地
    // 清空 conv/error，与下面那个 effect 的"展开时按需补载"职责重叠）。折叠 ->
    // 展开的加载由下面的 effect 负责。
    if (dirName && rootKey && !useLayout.getState().panelCollapsed) load()
  }, [dirName, rootKey, load, seedExpandedDates])

  useEffect(() => {
    const wasCollapsed = prevCollapsedRef.current
    prevCollapsedRef.current = panelCollapsed
    if (panelCollapsed) {
      // 折叠瞬间：让任何仍在飞行中的旧请求过期——即便 dirName/rootKey 没变化，也不
      // 允许"折叠前发起、折叠后才落地"的响应被写进 state（这一刻用户根本看不见
      // 面板，那次响应视为作废）。requestIdRef 是 load() 里过期响应防护复用的同一个
      // 计数器（见 requestIdRef 声明处的注释）——这里只是新增一个会推进它的时机，
      // 守卫本身（.then/.catch/.finally 里的比对）不做任何改动。
      requestIdRef.current++
      // 请求代提前失效后，其 finally 也不会再把 loading 收尾——顺带同步复位，
      // 避免下次展开时卡在一个再也翻不回 false 的"加载中"。
      setLoading(false)
      // 折叠还可能恰好发生在拖拽宽度的中途：手柄随折叠一起从 DOM 卸载，浏览器会
      // 隐式释放指针捕获但不会补发 pointerup，onResizePointerUp 里的
      // commitPanelWidth 就不会执行。这里兜底：把内存中（已经是最新值的）宽度落盘，
      // 避免那次拖拽白拖。
      useLayout.getState().commitPanelWidth()
      return
    }
    // 只在这次重跑确实是"折叠 -> 展开"的翻转时才补一次 catch-up 加载（wasCollapsed
    // 为真）——dirName/rootKey/conv/load 都在依赖数组里是为了让翻转发生时闭包拿到
    // 的是最新值（例如折叠期间切换过标签），而不是为了让它们的变化本身也触发加载：
    // 面板本来就展开着时，标签切换已经由上面那个 effect 处理，这里必须避免重复
    // 发起同一个请求；同理，收起又立刻展开（dirName/rootKey/conv 都没变）也不该
    // 因为 conv 后来才到位而被误当成"还没加载"再打一次。且只有当前还没有对应数据
    // （!conv）时才需要这一下——数据已经在，不重新拉取。
    if (wasCollapsed && dirName && rootKey && !conv) load()
  }, [panelCollapsed, dirName, rootKey, conv, load])

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
    // 复位到 400px 时同样经过 windowCap：窄窗口下"不超过窗口宽度 60%"这条不变量
    // 优先于字面上的 400（可能复位到比 400 更小），这是有意为之，不要"修正"掉。
    useLayout.getState().setPanelWidth(windowCap(PANEL_WIDTH_DEFAULT))
    useLayout.getState().commitPanelWidth()
  }, [])

  const panelWidth = useLayout((s) => s.panelWidth)

  // 时间线区（日期分组列表）整体的高度拖拽 + 折叠，与上面的宽度手柄是同一套
  // pointerdown/move/up + setPointerCapture 模式，只是方向换成竖直、驱动的是
  // timelineHeight 而非 panelWidth。这与"点击某个日期分组标题折叠该组"是两套彼此独立
  // 的机制：后者只影响一个分组内的条目是否展示，不改变时间线区本身占的高度；这里改的
  // 是整个时间线区（含所有分组）在面板里占多高，甚至可以整体折叠到 0，把高度让给下方
  // 可滚动的正文区。
  const timelineDragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  // 用于在拖拽时读取"内容区"（时间线 + 分隔条 + 正文，不含头部）的当前高度，
  // 供 timelineHeightCap 现算 60% 上限；见该函数与 windowCap 的注释。
  const contentRef = useRef<HTMLDivElement>(null)

  const onTimelineResizePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // 已折叠时分隔条仍然可见、可双击展开，但不响应拖拽——折叠期间时间线区渲染高度
    // 恒为 0，拖拽在视觉上无事发生，容易让人以为拖拽失效；折叠态下唯一的展开入口
    // 就是双击，这里索性不进入拖拽态，语义更清楚。
    if (useLayout.getState().timelineCollapsed) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    timelineDragRef.current = { startY: e.clientY, startHeight: useLayout.getState().timelineHeight }
  }, [])

  const onTimelineResizePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = timelineDragRef.current
    if (!drag) return
    const dy = e.clientY - drag.startY // 分隔条在时间线区下方：指针下移变高、上移变矮
    const containerHeight = contentRef.current?.clientHeight ?? 0
    useLayout.getState().setTimelineHeight(timelineHeightCap(drag.startHeight + dy, containerHeight))
  }, [])

  const onTimelineResizePointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!timelineDragRef.current) return
    timelineDragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    useLayout.getState().commitTimelineHeight()
  }, [])

  // 折叠/展开时间线区的唯一落地逻辑：分隔条双击与头部的折叠按钮共用同一个函数——
  // 一份状态、一份持久化调用，两个入口天然保持同步，不引入第二个标志位。
  const toggleTimelineCollapsed = useCallback(() => {
    const next = !useLayout.getState().timelineCollapsed
    useLayout.getState().setTimelineCollapsed(next)
    useLayout.getState().commitTimelineCollapsed()
  }, [])

  const timelineHeight = useLayout((s) => s.timelineHeight)
  const timelineCollapsed = useLayout((s) => s.timelineCollapsed)

  // 渲染安全网：拖拽/双击这些"主动改动"的时刻已经用 timelineHeightCap 现算过 60% 上限
  // （见 onTimelineResizePointerMove），但 store 里的 timelineHeight 本身（持久化值或
  // 默认值 220）从不经过这层现算——首次启动、内容区还没撑到默认高度，或窗口在保存了
  // 较大高度之后被缩短过，都可能让已存的 timelineHeight 超过当前实际内容区高度的
  // 60%。App.css 里 .conv-timeline 的 max-height:60% 兜住了视觉溢出（分隔条/正文不会
  // 被推出裁剪区、变得连鼠标都够不到），但那只解决"看着不溢出"——store 里存的仍是
  // 超出的旧值，下次挂载还是同样状态。这里在内容真正渲染出来后测一次实际高度，把
  // 超出的存量纠正回去并落盘，不装 window resize 监听器——只在这个 effect 本来就会
  // 重跑的几个时机（conv 到位、标签切换、时间线本身从折叠切回展开）顺带纠正一次，
  // 与 windowCap/timelineHeightCap"只在主动变化的时刻现算"是同一克制原则。
  useEffect(() => {
    if (!dirName || !rootKey || !conv || timelineCollapsed) return
    const containerHeight = contentRef.current?.clientHeight ?? 0
    if (containerHeight <= 0) return
    const capped = timelineHeightCap(timelineHeight, containerHeight)
    if (capped < timelineHeight) {
      useLayout.getState().setTimelineHeight(capped)
      useLayout.getState().commitTimelineHeight()
    }
  }, [dirName, rootKey, conv, timelineCollapsed, timelineHeight])

  // 折叠态：面板完全不渲染、不占宽度，终端拿满剩余空间，也不再收成一条竖条。
  // 展开入口在 TabBar 右端（面板不存在时没有自己的 DOM 可以承载按钮）；折叠入口
  // 挪到了面板自己的顶栏（conv-header-actions 里的 conv-collapse-toggle，见下方）
  // ——"收起某个东西的控件应该长在那个东西身上"。两者都调用同一个 togglePanel，
  // 与 ⌘J 共享同一个 store 方法；panelCollapsed 仍是 store/layout.ts 里唯一的
  // 真相来源，不引入第二个标志位。
  if (panelCollapsed) return null

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
            {hasThread && (
              <>
                <button
                  type="button"
                  className="conv-timeline-toggle"
                  onClick={toggleTimelineCollapsed}
                  title={timelineCollapsed ? '展开时间线' : '折叠时间线'}
                >
                  {timelineCollapsed ? '⌃' : '⌄'}
                </button>
                <button type="button" className="conv-refresh" onClick={() => load()} title="刷新">⟳</button>
              </>
            )}
            {/* 折叠入口，必须留在 hasThread 条件之外：无论当前标签有没有关联对话都要
                渲染，否则用户在没有关联对话的标签（如普通 zsh 终端标签）上打开面板后，
                这里没有任何按钮，而 TabBar 那个又因展开态被隐藏——面板会彻底关不掉。
                调用 togglePanel（而非 collapsePanelKeepingWindow，后者是给 ⌘D 腾地方
                用的、故意不改窗口宽度）——用户手动收起面板时窗口应跟着变窄。 */}
            <button
              type="button"
              className="conv-collapse-toggle"
              onClick={() => useLayout.getState().togglePanel()}
              title="隐藏对话面板 (⌘J)"
            >
              ›
            </button>
          </div>
        </div>
        {!hasThread && <div className="conv-empty">当前标签没有关联的对话</div>}
        {hasThread && loading && <div className="conv-status">加载中…</div>}
        {hasThread && error && <div className="conv-status conv-error">加载失败：{error}</div>}
        {hasThread && !loading && !error && conv && (
          <div className="conv-panel-content" ref={contentRef}>
            <div
              className="conv-timeline"
              style={timelineCollapsed ? { height: 0, padding: 0, overflow: 'hidden' } : { height: timelineHeight }}
            >
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
            <div
              className="conv-timeline-divider"
              role="separator"
              aria-orientation="horizontal"
              title="拖动调整时间线高度（双击折叠）"
              onPointerDown={onTimelineResizePointerDown}
              onPointerMove={onTimelineResizePointerMove}
              onPointerUp={onTimelineResizePointerUp}
              onPointerCancel={onTimelineResizePointerUp}
              onDoubleClick={toggleTimelineCollapsed}
            />
            <div className="conv-body">
              {conv.turns.map((t) => (
                <div key={t.uuid} id={`turn-${t.uuid}`} className={`conv-turn conv-turn-${t.role}`}>
                  {t.text}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
