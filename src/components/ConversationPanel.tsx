import { useCallback, useEffect, useState } from 'react'
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

  const load = useCallback(() => {
    if (!dirName || !rootKey) return
    setLoading(true)
    setError(null)
    readConversation(dirName, rootKey)
      .then((c) => setConv(c))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [dirName, rootKey])

  useEffect(() => {
    setConv(null)
    setError(null)
    if (dirName && rootKey) load()
  }, [dirName, rootKey, load])

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
            {groups.map((g) => (
              <div key={g.key} className="conv-date-group">
                <div className="conv-date-label">{g.label}</div>
                {g.turns.map((t) => (
                  <div key={t.uuid} className="conv-timeline-item" onClick={() => scrollToTurn(t.uuid)}>
                    <span className="dot">●</span>
                    <span className="time">{formatTimeHM(t.tsMs)}</span>
                    <span className="summary">{firstLineSummary(t.text)}</span>
                  </div>
                ))}
              </div>
            ))}
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
