import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { resumeThread } from '../actions'
import { attachDragSafetyNet } from '../dragSafetyNet'
import { revealInFinder, type ProjectInfo, type ThreadInfo } from '../ipc'
import { DRAG_THRESHOLD_PX, dropInsertionIndex, resolveDropMode, resolveDropTarget } from '../paneDrop'
import { getContentWidth, getPaneSlotRects } from '../paneDropDom'
import { previewPaneDrop } from '../paneLayout'
import { displayTitle, groupRecentByDate, isSessionRemoved } from '../sessionList'
import { useDnd } from '../store/dnd'
import { useDragGhost } from '../store/dragGhost'
import { useHint } from '../store/hint'
import { useLayout } from '../store/layout'
import { useLibrary } from '../store/library'
import { blockKey } from '../store/overview'
import { useSessions } from '../store/sessions'
import { useThreadStatus } from '../store/status'
import { useTabs } from '../store/tabs'
import { basename, formatRelative } from '../time'
import { ContextMenu } from './ContextMenu'
import { HooksControl } from './HooksInstall'
import { StatusDot } from './StatusDot'
import { ThemeSwitcher } from './ThemeSwitcher'

// id：每次 pointerdown 分配的单调递增拖拽序号，见 onItemPointerDown 与
// dragSafetyNet.ts 顶部"调用方每次挂网时……"那段注释——isDragActive() 靠它辨认
// "自己是不是仍然对应当前这次拖拽"，不是只看 dragRef.current 是否非空。
type DragState = { p: ProjectInfo; t: ThreadInfo; startX: number; startY: number; dragging: boolean; ghostStarted: boolean; pointerId: number; id: number }

// 从侧边栏「最近会话」拖入（设计文档 §5-B 场景 B）：落点解析、上限/窄窗口降级判断、
// 轻提示三处都复用与 TabBar.tsx 场景 A 完全相同的纯函数/store（paneDrop.ts、
// paneLayout.ts 的 decidePaneFit、store/hint.ts），只是终点动作不同——不是移动已有
// 窗格，而是"新建一个窗格 + 立即用这条会话启动它"，与 PanePicker.tsx 里
// startResume 选中同一条会话时做的事完全一致（同样的 inject/threadKey/dirName/
// rootKey 拼法），因此这里不做 focusThread 去重：⌘D 选择器本来就不做去重，
// "exactly as if it had been chosen through the ⌘D picker" 意味着这里也不做。
export function Sidebar() {
  const { projects, loading } = useSessions()
  const { aliases, removedSessions } = useLibrary()
  // 不再 .slice(0, 12)：`.sidebar-list` 本就 flex:1 填满剩余高度并滚动（App.css），
  // 截断只是把下方空间白白空着。移除的会话在这里滤掉（isSessionRemoved），键与
  // 别名共用同一套 blockKey，见 store/library.ts 顶部注释。
  const recent = projects
    .flatMap((p) => p.threads.map((t) => ({ p, t, lastActivityMs: t.lastActivityMs })))
    .filter(({ p, t }) => !isSessionRemoved(removedSessions[blockKey(p.dirName, t.rootKey)], t.lastActivityMs))
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
  const groups = groupRecentByDate(recent, Date.now())
  // 空态判断必须看 projects 本身有没有会话，不能只看 groups/recent 是不是空——
  // 二者为空的原因不同：本来就没发现任何会话，与「有会话，但被用户逐条移除到空」
  // 是完全不同的含义，不能用同一句文案糊弄过去（与 HomePage.tsx 「已隐藏全部项目」
  // 那条空态同一惯例）。跨三个任务分别落地时没人补这个缺口，这里补上。
  const hasAnySession = projects.some((p) => p.threads.length > 0)

  // 单击只选中、双击才打开（防误触，见用户原话）。存 blockKey，与别名/移除名单同一套键。
  const [selected, setSelected] = useState<string | null>(null)

  // 右键菜单：重命名 / 在访达中显示 / 从列表移除（用户原话，见 Task 7 brief）。
  const [menu, setMenu] = useState<{ x: number; y: number; p: ProjectInfo; t: ThreadInfo } | null>(null)
  // 就地编辑中的那一条，存 blockKey（与 selected 同一套键）；非 null 时该行改渲染 <input>。
  const [editing, setEditing] = useState<string | null>(null)

  const onItemContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>, p: ProjectInfo, t: ThreadInfo) => {
    // 不能漏：src/contextMenu.ts 的全局监听靠 e.defaultPrevented 判断"应用自己已经
    // 处理过这次右键"，漏了会连带弹出 WKWebView 的原生菜单（见 brief 要点①）。
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, p, t })
  }, [])

  const dragRef = useRef<DragState | null>(null)
  // 拖拽落地后浏览器仍会补发一次 click；真的发生过一次拖拽时这次 click 不该再触发
  // 一遍 resumeThread（那样会在新窗格之外，同时在旧的 focusThread/openTerminal 路径
  // 上重复处理同一条会话）。与 TabBar.tsx 同一套一次性抑制手法。
  const suppressClickRef = useRef(false)
  // 窗口级兜底监听器的卸载函数，见 dragSafetyNet.ts 顶部注释与 TabBar.tsx 同名字段
  // 的注释（不塞进 DragState，理由相同）。
  const netCleanupRef = useRef<(() => void) | null>(null)
  // 每次 pointerdown 递增一次，赋给这次拖拽的 DragState.id——见 onItemPointerDown。
  const nextDragIdRef = useRef(0)

  // 拖拽清理的唯一入口，与 TabBar.tsx 的 endDrag 同一理由——这里格外关键：「最近会话」
  // 列表在 window focus 时 refresh()，可能把正被拖拽的那一条会话从列表里挤出去（例如
  // 期间被标记为已移除，见 isSessionRemoved），使其 DOM 节点在拖拽中途消失，浏览器
  // 不会补发 pointerup，只会发 lostpointercapture（见
  // 下方 onItemLostPointerCapture）——这正是这个组件比另外两处更需要 dragSafetyNet.ts
  // 那层窗口级兜底的地方：Sidebar 组件本身没有卸载（只是列表项消失），
  // lostpointercapture 若因元素已从 DOM 摘除而没能冒泡到 React 委托根节点，组件卸载
  // 兜底也帮不上忙，只有不依赖元素是否还在 DOM 里的窗口级监听能兜住。
  // pointerup/pointercancel（同一个 onItemPointerUp）、lostpointercapture、组件卸载
  // 兜底（下面的 effect）、窗口级兜底四条退出路径全部委托给这一个函数，不写第二份
  // 清理逻辑；它触碰的两处状态（useDnd 的 target、useDragGhost）本身都是幂等的，被
  // 调用多次也完全无害。
  const endDrag = useCallback(() => {
    netCleanupRef.current?.()
    netCleanupRef.current = null
    dragRef.current = null
    useDnd.getState().setTarget(null)
    useDnd.getState().setDropMode(null)
    useDnd.getState().setRefusal(null)
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
    // 纵深防御，与 TabPanes.tsx/TabBar.tsx 同一理由：右键菜单本身已经 portal 到
    // document.body（见 ContextMenu.tsx），本就不是这个 `.side-item` 元素的 DOM
    // 后代，这条分支理论上不会被真的命中——保留它是三处拖拽源的同一层保险，防止将来
    // 弹层又被嵌回某个拖拽手柄的子树里时同一类问题重演（见 .superpowers/
    // context-menu-portal-report.md 的排查记录）。
    if ((e.target as HTMLElement).closest('.context-menu')) return
    // 屏蔽文本选择，只加 body class，不调用 e.preventDefault()——与 TabBar.tsx 的
    // onTabPointerDown 同一理由/同一时机（见 store/dragGhost.ts 的 blockSelect()
    // 注释）：真正的默认动作抑制挪到了下面 onItemPointerMove 里，只在跨过阈值后才
    // 调用，不影响随后仍会正常触发的合成 click，普通点击会话条目的行为不变。
    useDragGhost.getState().blockSelect()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const dragId = ++nextDragIdRef.current
    dragRef.current = { p, t, startX: e.clientX, startY: e.clientY, dragging: false, ghostStarted: false, pointerId: e.pointerId, id: dragId }
    // 挂新网前先摘掉任何仍然挂着的旧网——见 TabBar.tsx onTabPointerDown 同名注释，
    // 三处拖拽源同一套保险。
    netCleanupRef.current?.()
    // 窗口级兜底：见上方 endDrag 注释与 dragSafetyNet.ts。isDragActive 额外比较
    // dragId，见上方 DragState.id 注释。
    netCleanupRef.current = attachDragSafetyNet(
      e.pointerId,
      () => dragRef.current !== null && dragRef.current.id === dragId,
      endDrag,
    )
  }, [endDrag])

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
      useDnd.getState().setDropMode(null)
      useDnd.getState().setRefusal(null)
      return
    }
    if (!drag.ghostStarted) {
      drag.ghostStarted = true
      // 别名 > 真实标题 > 「新对话」（displayTitle）——与 actions.ts 的 resumeThread、
      // 本组件列表本身（下方 displayTitle(t, p.dirName, aliases)）同一优先级。这里
      // 在高频的 pointermove 回调里：不为它给 useCallback 加依赖、不改数据流，直接
      // getState() 取当下的别名表（与下方 onItemPointerMove 依赖数组同一取舍）。
      useDragGhost.getState().start(displayTitle(drag.t, drag.p.dirName, useLibrary.getState().aliases), e.clientX, e.clientY)
    } else {
      useDragGhost.getState().move(e.clientX, e.clientY)
    }
    const target = resolveDropTarget(getPaneSlotRects(activeTab), e.clientX, e.clientY)
    useDnd.getState().setTarget(target)
    // 实时预览这次拖放会不会被接受（Fix 3），与 TabBar.tsx 同一理由：与
    // onItemPointerUp 真正执行时共用同一份 previewPaneDrop，指示与实际落点行为
    // 永远一致。拖入永远是"新开一个窗格"，draggedCount 恒为 1。
    if (!target) {
      useDnd.getState().setDropMode(null)
      useDnd.getState().setRefusal(null)
      return
    }
    const targetPane = activeTab.panes.find((p) => p.id === target.paneId)
    const mode = resolveDropMode(targetPane)
    useDnd.getState().setDropMode(mode)
    const layout = useLayout.getState()
    const preview = previewPaneDrop(mode, activeTab.panes.length, 1, getContentWidth(), layout.panelCollapsed, layout.panelWidth)
    useDnd.getState().setRefusal(preview.refused ? { reason: preview.reason! } : null)
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
    // 目标窗格没有 ptyId（空槽）：直接在原地用这条会话启动它——恰好就是它自己的
    // PanePicker 会做的事（"exactly as if it had been chosen through the ⌘D
    // picker"），不新建窗格；否则是既有的"插入新窗格"行为。与 onItemPointerMove 的
    // 实时预览共用同一份 resolveDropMode/previewPaneDrop，判断保持一致。
    const targetPane = activeTab.panes.find((p) => p.id === target.paneId)
    const mode = resolveDropMode(targetPane)
    const layout = useLayout.getState()
    // 与 TabBar.tsx 的合并落点同一处修复：getContentWidth() 的原始测量值由
    // previewPaneDrop 内部按结果窗格数换算成真正可用宽度——与 ⌘D（App.tsx）保持
    // 同一套判定，不会互相矛盾。
    const preview = previewPaneDrop(mode, activeTab.panes.length, 1, getContentWidth(), layout.panelCollapsed, layout.panelWidth)
    if (preview.refused) {
      useHint.getState().show(preview.refusalKind === 'max-panes' ? '最多支持 3 个窗格' : '窗口太窄，放不下新窗格')
      return
    }
    if (preview.decision === 'collapse-panel') layout.togglePanel()
    const { p, t } = drag
    const sessionArgs = {
      // 别名 > 真实标题 > 「新对话」（displayTitle）——同上，第三个写入点。这里不在
      // 高频回调里，直接用组件顶部已订阅的 aliases（本函数已因此加入依赖数组）。
      title: displayTitle(t, p.dirName, aliases),
      cwd: p.cwd,
      inject: `claude --resume ${t.resumeSessionId}`,
      threadKey: `${p.dirName}:${t.rootKey}`,
      dirName: p.dirName,
      rootKey: t.rootKey,
      // 此前唯一缺这一行的 resume 起点：拖出来的窗格发出第一句话、rootKey 翻转之后
      // reconcilePanes 找不到它，永久失联（终审 Fix 4）。actions.ts/PanePicker.tsx
      // 两处 resume 起点都已经带了它。
      sessionId: t.resumeSessionId,
    }
    if (mode === 'fill' && targetPane) {
      // startPaneTerminal 只补 ptyId/title 等字段，不touch activePaneId（PanePicker
      // 自己调用它时那块窗格通常已经是焦点）——这里的落点未必是当前焦点窗格，显式
      // 聚焦一次，与"插入"分支（insertPaneAt 内部已经把新窗格设为焦点）保持同一个
      // "新内容进来的窗格立即成为焦点"的直觉。
      useTabs.getState().focusPane(activeTab.id, targetPane.id)
      void useTabs.getState().startPaneTerminal(activeTab.id, targetPane.id, sessionArgs)
      return
    }
    const insertAt = dropInsertionIndex(activeTab.panes.map((x) => x.id), target)
    const paneId = useTabs.getState().insertPaneAt(activeTab.id, insertAt)
    if (!paneId) return // 上面已经校验过上限，这里只是防御性兜底，理论上不会命中
    void useTabs.getState().startPaneTerminal(activeTab.id, paneId, sessionArgs)
  }, [endDrag, aliases])

  // 指针捕获被浏览器隐式释放时补发的退出路径——见上方 endDrag 注释描述的真实触发
  // 场景（拖拽中的会话项被 refresh() 挤出「最近会话」列表）。这里只做清理，不尝试
  // 识别落点或完成任何动作，与"松手落空"是同一处理。
  const onItemLostPointerCapture = useCallback(() => {
    endDrag()
  }, [endDrag])

  // 单击：只选中，不打开——防误触。仍然尊重 suppressClickRef：拖拽落地后浏览器补发
  // 的那次 click 既不该打开，也不该改变选中态。
  const onItemClick = useCallback((p: ProjectInfo, t: ThreadInfo) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    setSelected(blockKey(p.dirName, t.rootKey))
  }, [])

  // 双击：真正打开。同样尊重 suppressClickRef——理由与 onItemClick 一致，拖拽结束后
  // 不该被误判为一次会打开会话的点击。
  const onItemDoubleClick = useCallback((p: ProjectInfo, t: ThreadInfo) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    void resumeThread(p.dirName, p.cwd, t)
  }, [])

  return (
    <>
      <div className="sidebar-list">
        {groups.map((g) => (
          <Fragment key={g.label}>
            <div className="section-label">{g.label}</div>
            {g.items.map(({ p, t }) => {
              const key = blockKey(p.dirName, t.rootKey)
              return (
                <SidebarItem
                  key={`${p.dirName}:${t.rootKey}`}
                  p={p}
                  t={t}
                  title={displayTitle(t, p.dirName, aliases)}
                  selected={selected === key}
                  editing={editing === key}
                  onPointerDown={onItemPointerDown}
                  onPointerMove={onItemPointerMove}
                  onPointerUp={onItemPointerUp}
                  onLostPointerCapture={onItemLostPointerCapture}
                  onClick={onItemClick}
                  onDoubleClick={onItemDoubleClick}
                  onContextMenu={onItemContextMenu}
                  onRenameSubmit={(value) => {
                    useLibrary.getState().rename(key, value)
                    // 改名要立刻生效，不能等挂载/聚焦/状态事件那 15 秒节流的下一轮
                    // 刷新——纯内存操作，只扫用户已打开的那几个窗格，开销可忽略。
                    // getState().aliases 在 rename() 的 set() 之后立刻是新值（zustand
                    // 的 set 是同步的），这里不会读到旧别名。
                    useTabs.getState().reconcilePanes(useSessions.getState().projects, useLibrary.getState().aliases)
                    setEditing(null)
                  }}
                  onRenameCancel={() => setEditing(null)}
                />
              )
            })}
          </Fragment>
        ))}
        {groups.length === 0 && (
          <div className="sidebar-empty">
            {loading
              // refresh() 还没结束：projects 仍是初始的 []，这时候两句空态文案
              // 哪句都不成立——不是"本来没有会话"，也不是"移除到空"，是第三种
              // 状态，不能借用前两句里的任何一句糊弄过去（见上方 hasAnySession
              // 注释）。中性的加载提示复用同一个 .sidebar-empty 样式即可。
              ? '正在扫描 Claude Code 会话…'
              : hasAnySession
                ? '已从列表移除全部会话（不是没有会话——可以用 ⌘D 找到它们）'
                : '尚未发现 Claude Code 会话（~/.claude/projects 为空）'}
          </div>
        )}
      </div>
      <HooksControl />
      <ThemeSwitcher />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onDismiss={() => setMenu(null)}
          items={[
            {
              label: '重命名',
              onSelect: () => setEditing(blockKey(menu.p.dirName, menu.t.rootKey)),
            },
            {
              label: '在访达中显示',
              // 传的是项目 cwd（brief 要点②），不是会话文件路径；后端只接受已存在的
              // 目录。失败时 reject 的就是可直接展示给用户的中文错误字符串。
              onSelect: () => {
                void revealInFinder(menu.p.cwd).catch((msg) => useHint.getState().show(String(msg)))
              },
            },
            {
              label: '从列表移除',
              onSelect: () => {
                const key = blockKey(menu.p.dirName, menu.t.rootKey)
                useLibrary.getState().removeSession(key)
                // 可撤销轻提示，与 HomePage.tsx「隐藏项目」同一惯例（action 字段见
                // store/hint.ts）。restoreSession 此前是零调用点的死代码——这是它
                // 唯一的落地入口。
                useHint.getState().show('已从列表移除', {
                  label: '撤销',
                  onClick: () => useLibrary.getState().restoreSession(key),
                })
              },
            },
          ]}
        />
      )}
    </>
  )
}

// 拆成独立组件只是为了让 useThreadStatus 能合法地按每条「最近会话」分别调用一次
// （Rules of Hooks：不能在 Sidebar 自己的 .map() 循环体内调用 hook，见 HomePage.tsx
// 里 ProjectCard/ThreadRow 同样的拆分理由）。拖拽/指针相关的所有状态与清理逻辑仍然
// 全部留在 Sidebar 里，这里只透传回调，不复制任何一处判断。
function SidebarItem({ p, t, title, selected, editing, onPointerDown, onPointerMove, onPointerUp, onLostPointerCapture, onClick, onDoubleClick, onContextMenu, onRenameSubmit, onRenameCancel }: {
  p: ProjectInfo
  t: ThreadInfo
  title: string
  selected: boolean
  editing: boolean
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>, p: ProjectInfo, t: ThreadInfo) => void
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
  onLostPointerCapture: () => void
  onClick: (p: ProjectInfo, t: ThreadInfo) => void
  onDoubleClick: (p: ProjectInfo, t: ThreadInfo) => void
  onContextMenu: (e: ReactMouseEvent<HTMLDivElement>, p: ProjectInfo, t: ThreadInfo) => void
  onRenameSubmit: (value: string) => void
  onRenameCancel: () => void
}) {
  const status = useThreadStatus(p.dirName, t.rootKey)
  return (
    <div
      className={selected ? 'side-item side-item-selected' : 'side-item'}
      title={title}
      onPointerDown={(e) => onPointerDown(e, p, t)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onLostPointerCapture}
      onClick={() => !editing && onClick(p, t)}
      onDoubleClick={() => !editing && onDoubleClick(p, t)}
      onContextMenu={(e) => onContextMenu(e, p, t)}
    >
      <span className="side-item-row">
        <StatusDot status={status} />
        {editing
          ? <SidebarRenameInput initialValue={title} onSubmit={onRenameSubmit} onCancel={onRenameCancel} />
          : <span className="side-item-title">{title}</span>}
      </span>
      <div className="sub">{basename(p.cwd)} · {formatRelative(t.lastActivityMs)}</div>
    </div>
  )
}

// 就地重命名输入框：Enter 提交、Escape 取消、失焦也提交（brief 要点③）。commit/discard
// 都经过 doneRef 去重——DOM 从「渲染 input」切回「渲染 span」是父组件状态更新触发的，
// 若 input 此刻真的持有焦点，React 摘除它时浏览器会在同一批里补发一次原生 blur，
// 若不去重，Enter/Escape 各自的提交/取消会被这次补发的 blur 再执行一遍（Escape 的
// 情形下这会把已经取消的编辑重新按 blur 规则提交一次，与"Esc 取消，名字不变"矛盾）。
function SidebarRenameInput({ initialValue, onSubmit, onCancel }: {
  initialValue: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const doneRef = useRef(false)
  const commit = (value: string) => {
    if (doneRef.current) return
    doneRef.current = true
    onSubmit(value)
  }
  const discard = () => {
    if (doneRef.current) return
    doneRef.current = true
    onCancel()
  }
  return (
    <input
      className="side-item-rename-input"
      autoFocus
      defaultValue={initialValue}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') commit(e.currentTarget.value)
        else if (e.key === 'Escape') discard()
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  )
}
