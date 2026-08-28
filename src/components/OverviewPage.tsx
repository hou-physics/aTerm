// 总览页（Task 7，spec §5.2）：某个项目下所有会话方块的自由拖拽网格。
//
// 数据来源：src/store/sessions.ts 的 useSessions（App.tsx 已经在挂载与窗口聚焦时调
// refresh()，见 App.tsx；这里只读，不重复发起 IPC——与 HomePage.tsx 走的是同一条数据
// 管线，不新开第二条）。按 dirName 从 projects 里找出对应项目，取它的 threads。
//
// 「打开」指总览标签被创建这件事，不是本组件每次挂载（Task 4 store 的 ruling，见
// store/overview.ts 顶部注释与 progress.md 的 Task 4 记录）：这里在挂载、以及此后
// threads 引用变化（App.tsx 周期性 refresh() 换出新的 projects 数组）时都会调
// captureOrder——它已有快照时只做增删合并、不重排（spec §5.2「打开期间不自动重排」），
// 重复调用因此是幂等/自愈的；快照本身的清除只会在 Task 8 新建总览标签时发生，不在
// 这里（切走再切回来不应该让方块重新洗牌）。
//
// 位置持久化走项目既有的两动作范式（拖拽中 setPosition 只改内存，pointerup 才
// commitPosition 落盘，见 store/overview.ts）。容器宽度用 ResizeObserver 取，与
// TerminalLayer.tsx 同一套：useLayoutEffect 里先同步量一次（覆盖"容器与本组件同帧
// 首次挂载"的边界情况），useEffect 里再挂 ResizeObserver 盯后续连续变化；jsdom 没有
// 这个全局，优雅跳过，不影响首帧的同步测量。
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { resumeThread } from '../actions'
import type { ProjectInfo, ThreadInfo } from '../ipc'
import {
  BLOCK_WIDTH_PX, canvasHeight, clampPosition, columnsForWidth, gridSlot,
} from '../overviewLayout'
import { DRAG_THRESHOLD_PX } from '../paneDrop'
import { blockKey, useOverviewStore, type Position } from '../store/overview'
import { useSessions } from '../store/sessions'
import { SessionBlock } from './SessionBlock'

const EMPTY_THREADS: ThreadInfo[] = []
const EMPTY_ORDER: string[] = []

export function OverviewPage({ dirName }: { dirName: string }) {
  const projects = useSessions((s) => s.projects)
  const project = useMemo<ProjectInfo | undefined>(
    () => projects.find((p) => p.dirName === dirName),
    [projects, dirName],
  )
  const threads = project?.threads ?? EMPTY_THREADS

  const captureOrder = useOverviewStore((s) => s.captureOrder)
  useLayoutEffect(() => {
    captureOrder(dirName, threads)
  }, [dirName, threads, captureOrder])

  const order = useOverviewStore((s) => s.order[dirName]) ?? EMPTY_ORDER
  const positions = useOverviewStore((s) => s.positions)

  const byKey = useMemo(() => {
    const m = new Map<string, ThreadInfo>()
    for (const t of threads) m.set(blockKey(dirName, t.rootKey), t)
    return m
  }, [threads, dirName])

  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  const measure = useCallback(() => {
    const el = containerRef.current
    if (el) setContainerWidth(el.getBoundingClientRect().width)
  }, [])

  // 结构性变化（进入这个标签、order 变化导致方块数变化）：同步测一次，赶在浏览器
  // 上屏前算好列数，避免"先按 0 宽度画一帧、下一帧才补上正确列数"的闪烁——与下面
  // ResizeObserver 驱动的连续几何变化（窗口缩放、侧边栏收起展开）刻意分成两条路径，
  // 同 TerminalLayer.tsx 的既有拆分。
  useLayoutEffect(() => {
    measure()
  }, [measure])

  useEffect(() => {
    measure()
    // jsdom 测试环境没有 ResizeObserver 这个全局（真实 Tauri 窗口里恒有）；这里只是
    // 优雅跳过连续观察这条路径——上面的同步 measure() 与 overviewLayout.ts 的纯函数
    // 测试已经覆盖了这层逻辑本身，不需要在测试里也构造一个 polyfill。
    if (typeof ResizeObserver === 'undefined') return undefined
    const container = containerRef.current
    const ro = new ResizeObserver(() => measure())
    if (container) ro.observe(container)
    return () => ro.disconnect()
  }, [measure])

  const columns = columnsForWidth(containerWidth)

  // canvasHeight 只该看这个项目自己的方块位置——store 里的 positions 是跨项目共用的
  // 全局 Record（key 已经带 dirName 前缀区分身份），直接把整张表传进去会让别的项目里
  // 一个被拖到很下面的方块把这个项目的画布也撑高。
  const myPositions = useMemo(() => {
    const m: Record<string, Position> = {}
    for (const key of order) {
      const p = positions[key]
      if (p) m[key] = p
    }
    return m
  }, [order, positions])

  const onOpen = useCallback((t: ThreadInfo) => {
    if (!project) return
    void resumeThread(project.dirName, project.cwd, t)
  }, [project])

  return (
    <div className="overview-page">
      <div
        className="overview-canvas"
        ref={containerRef}
        style={{ height: canvasHeight(order.length, columns, myPositions) }}
      >
        {order.map((key, idx) => {
          const thread = byKey.get(key)
          if (!thread) return null // order 里的 key 理论上总能在 byKey 里找到；防御性跳过而不是崩溃
          const saved = positions[key]
          const pos = saved ? clampPosition(saved, containerWidth) : gridSlot(idx, columns)
          return (
            <DraggableBlock
              key={key}
              blockKey={key}
              thread={thread}
              dirName={dirName}
              pos={pos}
              containerWidth={containerWidth}
              onOpen={onOpen}
            />
          )
        })}
      </div>
    </div>
  )
}

type DragState = { startX: number; startY: number; startPos: Position; dragging: boolean; pointerId: number }

// 拖拽手柄：order.map() 里的一项，不能在 map 回调体内直接调用 useRef/useCallback
// （Rules of Hooks），拆成独立组件——和 SessionBlock.tsx 顶部注释、Sidebar.tsx:246
// 是同一个解法。
//
// 特意不采用"pointerdown 时立刻 setPointerCapture"的写法（TabBar.tsx/Sidebar.tsx/
// TabPanes.tsx 的既有拖拽手柄都是这样做的）：那三处的手柄本身不包含需要独立响应
// 点击的后代节点（TabPanes.tsx 的右键菜单已经因为同一个原因被迁移成 document.body
// 的 portal，见 ContextMenu.tsx 顶部注释——"手柄一旦 setPointerCapture，真实浏览器
// 里随后的 pointerup/合成 click 都会被重定向到手柄本身，后代节点自己的 click 再也
// 发不出来"）。这里包的 SessionBlock 恰恰是这一类后代：它自身的空白区域双击要打开
// 会话、标题双击要停止冒泡（Task 6），一旦在 pointerdown 就捕获指针，两处
// onDoubleClick 全部收不到事件。这里的做法是把 setPointerCapture 推迟到确认真的
// 越过 4px 阈值、已经判定为拖拽之后才调用（和"只在越过阈值后才 preventDefault"
// 同一时机）：轻点/双击全程不会越过阈值，指针从未被捕获，SessionBlock 自己的双击
// 逻辑不受任何影响；真正开始拖拽后再捕获，才需要保证指针跑出这层包装 div 的边界时
// move/up 仍能送达同一个元素。
function DraggableBlock({
  blockKey: key,
  thread,
  dirName,
  pos,
  containerWidth,
  onOpen,
}: {
  blockKey: string
  thread: ThreadInfo
  dirName: string
  pos: Position
  containerWidth: number
  onOpen: (t: ThreadInfo) => void
}) {
  const dragRef = useRef<DragState | null>(null)
  const setPosition = useOverviewStore((s) => s.setPosition)
  const commitPosition = useOverviewStore((s) => s.commitPosition)

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // 不在这里 preventDefault——本项目踩过的坑：pointerdown 上无条件 preventDefault
    // 会吞掉后续合成的 click，方块的双击打开/右键菜单都会点不动（见 TabPanes.tsx/
    // TabBar.tsx/Sidebar.tsx 同一处注释与 PaneDetach.test.tsx 的回归测试）。真正的
    // 抑制挪到下面 onPointerMove 里，只在确认越过阈值、真的开始拖拽后才调用。
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPos: pos, dragging: false, pointerId: e.pointerId }
  }, [pos])

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (!drag.dragging) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return
      drag.dragging = true
      // 见上方组件注释：越过阈值、确认是拖拽之后才捕获指针，避免吞掉 SessionBlock
      // 自己的双击。
      e.currentTarget.setPointerCapture?.(e.pointerId)
    }
    e.preventDefault()
    const next = {
      x: drag.startPos.x + (e.clientX - drag.startX),
      y: drag.startPos.y + (e.clientY - drag.startY),
    }
    // 两动作范式：拖拽过程中只改内存（setPosition），不落盘——pointerup 才
    // commitPosition。经 clampPosition 钳制，拖拽途中也不会被拖出可见区。
    setPosition(key, clampPosition(next, containerWidth))
  }, [key, containerWidth, setPosition])

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (drag.dragging) {
      const next = {
        x: drag.startPos.x + (e.clientX - drag.startX),
        y: drag.startPos.y + (e.clientY - drag.startY),
      }
      commitPosition(key, clampPosition(next, containerWidth))
    }
    dragRef.current = null
  }, [key, containerWidth, commitPosition])

  // 指针捕获被浏览器隐式释放、或该指针被取消时：只清理拖拽状态，不识别落点/不
  // 持久化——与 TabBar.tsx/Sidebar.tsx/TabPanes.tsx 同一套"只清理"约定。
  const onLostPointerCapture = useCallback(() => {
    dragRef.current = null
  }, [])

  return (
    <div
      className="overview-block-wrap"
      data-block-key={key}
      style={{ position: 'absolute', left: pos.x, top: pos.y, width: BLOCK_WIDTH_PX }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onLostPointerCapture}
    >
      <SessionBlock thread={thread} dirName={dirName} subagentCount={0} onOpen={() => onOpen(thread)} />
    </div>
  )
}
