// 总览页方块（Task 6，spec §5.3）：一个会话一个方块，状态着色 + 预览行 + 徽章。
//
// 状态不经 prop 传入：这里直接调 useThreadStatus(dirName, thread.rootKey) 自己求得。
// 这不是随意的选择——Sidebar.tsx:246 已经因为同样的 Rules of Hooks 限制（不能在
// .map() 循环体内调用 hook）拆出了 SidebarItem，本组件就是总览页网格里同一个解法：
// 让每个方块各自成为一个组件、各自调用一次 hook，而不是在父级的 .map() 里调。
//
// 双击的分工（为 Task 9 让路）：整块 .session-block 的 onDoubleClick 触发 onOpen
// （双击空白区域=打开）；标题 .session-block-title 自己单独接了一个 onDoubleClick，
// 现在换成"进入改名模式"（仍然 stopPropagation，防止顺带触发 onOpen），不需要改动
// 这里的布局或事件结构、也不会跟 onOpen 打架。
//
// 改名态的 pointerdown 隔离（本任务专项要求）：OverviewPage.tsx 的 DraggableBlock 把
// 整个 SessionBlock 包在一个装了原生 pointerdown 拖拽手柄的 div 里，阈值前不会
// preventDefault/setPointerCapture，但 pointerdown 事件本身仍然会向外冒泡到那个手柄
// ——这正是本项目在 TabPanes.tsx 里踩过两次的同一类坑（可交互子节点被拖拽手柄吞掉点击/
// 右键菜单）。改名 input 上的 onPointerDown 因此单独 stopPropagation：点击摆放光标、
// 按住拖动选字都会先发一次 pointerdown，若冒泡到外层手柄，随后的 pointermove 一旦
// 超过 4px 阈值就会被手柄误判成"开始拖拽方块"。stopPropagation 掉这一次 pointerdown
// 之后，手柄根本收不到事件，就不会记录起点、也就不会触发拖拽——原生 mousedown/文本
// 选择行为不受影响（没有调用 preventDefault，只是不让事件继续冒泡）。
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { blockKey } from '../store/overview'
import { useLibrary } from '../store/library'
import { useSessions } from '../store/sessions'
import { useTabs } from '../store/tabs'
import { displayTitle as computeDisplayTitle } from '../sessionList'
import { useThreadStatus } from '../store/status'
import type { ThreadInfo } from '../ipc'
import { formatRelative } from '../time'
import { formatContextTokens, shortModelName } from '../modelNames'
import { StatusDot } from './StatusDot'

export function SessionBlock({ thread, dirName, subagentCount, onOpen }: {
  thread: ThreadInfo
  dirName: string
  subagentCount: number
  onOpen: () => void
}) {
  const status = useThreadStatus(dirName, thread.rootKey)
  // 显示名（优先级：用户别名 > 真实标题 > 「新对话」，见 sessionList.ts 顶部注释）：
  // 别名现由 store/library.ts 持有；没有别名时不能直接退回 thread.title——后端在
  // 会话尚无真实标题时把 title 填成 session id 前 8 位，titled: false 是这个情况的
  // 标记，直接渲染会在总览页方块里露出一串十六进制。
  const key = blockKey(dirName, thread.rootKey)
  const aliases = useLibrary((s) => s.aliases)
  const rename = useLibrary((s) => s.rename)
  const displayTitle = computeDisplayTitle(thread, dirName, aliases)
  const model = shortModelName(thread.model)
  const ctx = formatContextTokens(thread.contextTokens)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(displayTitle)
  const inputRef = useRef<HTMLInputElement>(null)
  // Esc 取消需要区分"这次退出编辑态是取消还是提交"——onBlur 在按下 Esc 后也会触发
  // （焦点从 input 移开时浏览器总会派发 blur），如果不加区分，onBlur 会把 Esc 已经
  // 判定为"作废"的草稿又提交一次。用一个 ref 而不是 state：这个标记只在同一次事件
  // 处理的极短窗口内读写，不需要触发重渲染。
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const beginEdit = () => {
    cancelledRef.current = false
    setDraft(displayTitle)
    setEditing(true)
  }

  const commit = () => {
    setEditing(false)
    rename(key, draft)
    // 改名要立刻生效，不能等挂载/聚焦/状态事件那 15 秒节流的下一轮刷新——纯内存
    // 操作，只扫用户已打开的那几个窗格，开销可忽略（与 Sidebar.tsx 的
    // onRenameSubmit 同一理由）。rename() 的 set() 是同步的，这里读到的
    // useLibrary.getState().aliases 已经是改名后的新值。
    useTabs.getState().reconcilePanes(useSessions.getState().projects, useLibrary.getState().aliases)
  }

  const cancel = () => {
    cancelledRef.current = true
    setEditing(false)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  const onBlur = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    commit()
  }

  return (
    <div className={`session-block session-block-${status ?? 'unknown'}`} onDoubleClick={() => onOpen()}>
      <div className="session-block-head">
        <StatusDot status={status} />
        {editing ? (
          <input
            ref={inputRef}
            className="session-block-title-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            onDoubleClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="session-block-title" onDoubleClick={(e) => { e.stopPropagation(); beginEdit() }}>
            {displayTitle}
          </span>
        )}
      </div>
      {thread.preview && <div className="session-block-preview">{thread.preview}</div>}
      <div className="session-block-badges">
        {model && <span className="badge">{model}</span>}
        {subagentCount > 0 && <span className="badge">⑂ {subagentCount}</span>}
        <span className="badge">{formatRelative(thread.lastActivityMs)}</span>
        {ctx && <span className="badge">上下文 {ctx}</span>}
      </div>
    </div>
  )
}
