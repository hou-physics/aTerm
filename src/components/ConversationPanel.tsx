import { useCallback, useEffect, useRef, useState } from 'react'
import { firstLineSummary, formatTimeHM, groupUserTurnsByDate } from '../conversation'
import { readConversation, type Conversation } from '../ipc'
import { useTabs } from '../store/tabs'

function scrollToTurn(uuid: string) {
  document.getElementById(`turn-${uuid}`)?.scrollIntoView({ block: 'start' })
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

  if (!dirName || !rootKey) {
    return (
      <div className="conv-panel">
        <div className="conv-header"><span className="conv-title">对话</span></div>
        <div className="conv-empty">当前标签没有关联的对话</div>
      </div>
    )
  }

  const groups = conv ? groupUserTurnsByDate(conv.turns) : []

  return (
    <div className="conv-panel">
      <div className="conv-header">
        <span className="conv-title">对话</span>
        <button type="button" className="conv-refresh" onClick={() => load()} title="刷新">⟳</button>
      </div>
      {loading && <div className="conv-status">加载中…</div>}
      {error && <div className="conv-status conv-error">加载失败：{error}</div>}
      {!loading && !error && conv && (
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
                      <span className="dot">●</span>
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
  )
}
