// 总览页方块（Task 6，spec §5.3）：一个会话一个方块，状态着色 + 预览行 + 徽章。
//
// 状态不经 prop 传入：这里直接调 useThreadStatus(dirName, thread.rootKey) 自己求得。
// 这不是随意的选择——Sidebar.tsx:246 已经因为同样的 Rules of Hooks 限制（不能在
// .map() 循环体内调用 hook）拆出了 SidebarItem，本组件就是总览页网格里同一个解法：
// 让每个方块各自成为一个组件、各自调用一次 hook，而不是在父级的 .map() 里调。
//
// 双击的分工（为 Task 9 让路）：整块 .session-block 的 onDoubleClick 触发 onOpen
// （双击空白区域=打开）；标题 .session-block-title 自己单独接了一个 onDoubleClick，
// 目前只 stopPropagation（阻止事件冒泡到外层触发 onOpen），Task 9 只需要把这个
// handler 的函数体换成"进入改名模式"，不需要改动这里的布局或事件结构、也不会跟
// onOpen 打架。
import { blockKey, useOverviewStore } from '../store/overview'
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
  // 自定义名字（Task 4 的 store，Task 9 才会接上改名 UI）：这里只读，有就显示，没有
  // 就退回记录里的原始标题。
  const customName = useOverviewStore((s) => s.names[blockKey(dirName, thread.rootKey)])
  const displayTitle = customName ?? thread.title
  const model = shortModelName(thread.model)
  const ctx = formatContextTokens(thread.contextTokens)

  return (
    <div className={`session-block session-block-${status ?? 'unknown'}`} onDoubleClick={() => onOpen()}>
      <div className="session-block-head">
        <StatusDot status={status} />
        <span className="session-block-title" onDoubleClick={(e) => e.stopPropagation()}>
          {displayTitle}
        </span>
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
