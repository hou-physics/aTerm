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
import { attachDragSafetyNet } from '../dragSafetyNet'
import { countSubagents, type ProjectInfo, type ThreadInfo } from '../ipc'
import {
  BLOCK_WIDTH_PX, canvasHeight, clampPosition, columnsForWidth, gridSlot,
} from '../overviewLayout'
import { DRAG_THRESHOLD_PX } from '../paneDrop'
import { blockKey, useOverviewStore, type Position } from '../store/overview'
import { useDragGhost } from '../store/dragGhost'
import { useSessions } from '../store/sessions'
import { SessionBlock } from './SessionBlock'

const EMPTY_THREADS: ThreadInfo[] = []
const EMPTY_ORDER: string[] = []

// sub-agent 徽章（Task 11，spec §5.3）的并发上限：count_subagents 是全仓库唯一的整读
// 大文件操作（Rust 侧按文件缓存、只重新解析新追加的字节，但冷启动的第一次读取仍然
// 可能很贵——见 src-tauri/src/sessions/subagents.rs 顶部注释），一次性对几十个会话
// 同时发起会在冷启动时把这条本该轻量的补齐请求变成一次并发风暴。
const SUBAGENT_FETCH_CONCURRENCY = 4

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

  // 宽度为 0 时不写入 state（只保留上一次量到的好值）：Task 8 接入后，未激活的总览
  // 标签会和 TabPanes.tsx 的既有做法一样常驻挂载、只是 display:none 隐藏（不会真的
  // 卸载重挂）——被隐藏期间这个元素的盒子会整体塌缩成 0×0，如果照单全收，
  // containerWidth 会被写成 0 → columnsForWidth(0) === 1 → 每个持久化位置都被
  // clampPosition 钳到 x:0，切回来的一瞬间所有方块会先在原点闪一下，直到
  // ResizeObserver 补上下一次真实测量为止。commit 086f80c 就是这个项目修过一次同一类
  // bug（终端可见性判定），这里直接从一开始就不落入同一个坑：宽度只在真的量到非零值
  // 时才更新，隐藏期间的 containerWidth 保持上一次的好值不变，可见性恢复后
  // ResizeObserver 自然会送来一次新的真实宽度。
  const measure = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const w = el.getBoundingClientRect().width
    if (w > 0) setContainerWidth(w)
  }, [])

  // 这个 effect 只处理"容器与本组件在同一帧首次挂载"这一种边界情况（同步测一次，
  // 赶在浏览器上屏前算好列数，避免第一帧按 0 宽度画、下一帧才补上正确列数的闪烁）
  // ——它的依赖数组是恒定不变的 measure（本身 deps 为 []），因此这个 effect 只会在
  // 挂载时跑一次，此后永远不会重新执行；这是有意为之，不是遗漏依赖。真正处理"此后
  // 尺寸怎么变化"（标签重新变为可见、窗口缩放、侧边栏收起展开）的是下面那个
  // ResizeObserver——它在整个组件生命周期内持续观察，包括 display:none → block 这一
  // 类尺寸变化，不需要这里的同步 effect 跟着重跑。与 TerminalLayer.tsx 的既有拆分
  // 同一个理由。
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

  // sub-agent 徽章（Task 11）：方块本身已经用上面 Task 2 的 bounded 数据画完了，这里
  // 只是补一个纯展示层的异步 state，绝不影响、也不等待上面的渲染——按 key 存进
  // Map，取不到时 SessionBlock 拿到 undefined，和显式传 0 是同一种「不显示徽章」
  // 效果（spec §5.3：⑂ n 只在 n > 0 时出现）。
  const [subagentCounts, setSubagentCounts] = useState<Map<string, number>>(new Map())
  // 「代」计数器：只在 dirName 变化或组件卸载时推进（与 ConversationPanel.tsx 的
  // requestIdRef 同一个陈旧响应守卫 idiom）。这里所有请求共享同一个当前代——不像
  // ConversationPanel 每次请求各领一个专属 id，因为这里天然就是"整批一起失效"的粒度：
  // 一旦 dirName 变了或组件卸了，这一整代里所有仍在飞的请求都应该被一起丢弃，不需要
  // 逐个区分谁是"更新的那个"。
  const subagentEpochRef = useRef(0)
  useEffect(() => {
    subagentEpochRef.current++
    return () => {
      subagentEpochRef.current++
    }
  }, [dirName])
  // 记录本代里已经发起过请求的 key（成功/失败/仍在飞都算），跨渲染持久（不放进
  // state，纯粹是去重簿记，本身不该触发重渲染）。防止 order/byKey 因为无关的
  // useSessions 周期性 refresh（App.tsx）换出新数组引用、导致下面的 effect 重跑时，
  // 对已经问过的会话重复发起请求——captureOrder（store/overview.ts）每次都会
  // set() 一份新的 order 数组，哪怕内容没变。
  const requestedSubagentKeysRef = useRef<Set<string>>(new Set())
  // 并发上限必须按"这个组件当前总共有多少个请求在飞"计，不能按"这一轮 effect 发出
  // 了几个"计（复审 Important：App.tsx:35 的窗口聚焦 refresh 在终端复用场景下会
  // 频繁触发，超过 4 个会话的项目会经常在上一批还没 drain 完时就迎来下一轮
  // 调度——如果每轮各起一个上限为 4 的独立 worker 池，两轮池子互不知道对方存在，
  // 真实在飞数会摸到 4+4=8）。这里把队列和在飞 worker 数都提升成跨 effect 重跑共享
  // 的 ref（组件整个生命周期只有一份，不随 dirName 之外的任何依赖重置）：新一轮
  // 发现的目标只是 push 进同一个队列，只有当在飞 worker 数低于上限时才补新 worker，
  // 已经在跑的 worker 会自己继续从共享队列里取下一个，不需要、也不能再重复起。
  // 每个目标携带自己的 dirName（而不是各 worker 依赖创建时闭包到的外层 dirName）：
  // 队列本身跨越多轮 effect 重跑存活，一个更早创建、仍在运行的 worker 完全可能在
  // dirName 变化之后才取到一个属于新一轮的目标，这样它请求时用的是这个目标自带的
  // dirName，不会把新目标的 rootKey 错配到旧的 dirName 上。
  const subagentQueueRef = useRef<{ key: string; dirName: string; rootKey: string }[]>([])
  const subagentActiveWorkersRef = useRef(0)
  useEffect(() => {
    const epoch = subagentEpochRef.current
    const newTargets: { key: string; dirName: string; rootKey: string }[] = []
    for (const key of order) {
      if (requestedSubagentKeysRef.current.has(key)) continue
      const t = byKey.get(key)
      if (!t) continue
      requestedSubagentKeysRef.current.add(key)
      newTargets.push({ key, dirName, rootKey: t.rootKey })
    }
    if (newTargets.length === 0) return
    subagentQueueRef.current.push(...newTargets)

    // 简单的并发上限队列：固定数量的 worker 共享同一个队列，谁先 await 完谁先取
    // 下一个——不是"切成几批、批内并发、批间串行"，一个位置腾出来立刻补下一个，
    // 直到队列耗尽。失败的单个请求 catch 后跳过，不影响这个 worker 继续处理队列
    // 里的下一个目标。
    const runWorker = async () => {
      try {
        while (true) {
          const next = subagentQueueRef.current.shift()
          if (!next) return
          try {
            const count = await countSubagents(next.dirName, next.rootKey)
            if (subagentEpochRef.current !== epoch) return // 卸载或 dirName 已切换：丢弃
            setSubagentCounts((prev) => {
              const nextMap = new Map(prev)
              nextMap.set(next.key, count)
              return nextMap
            })
          } catch {
            // 静默略过：这一个会话的徽章读取失败，不弹错误、不影响队列里其它目标。
          }
        }
      } finally {
        subagentActiveWorkersRef.current--
      }
    }
    // 只把在飞 worker 数补到上限——如果已经有 4 个在跑，这里什么都不新起，刚 push
    // 进去的目标会被那些正在跑的 worker 自然消费到。
    const spawnCount = Math.min(
      SUBAGENT_FETCH_CONCURRENCY - subagentActiveWorkersRef.current,
      subagentQueueRef.current.length,
    )
    for (let i = 0; i < spawnCount; i++) {
      subagentActiveWorkersRef.current++
      void runWorker()
    }
  }, [dirName, order, byKey])

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
              subagentCount={subagentCounts.get(key) ?? 0}
              onOpen={onOpen}
            />
          )
        })}
      </div>
    </div>
  )
}

type DragState = { startX: number; startY: number; startPos: Position; dragging: boolean; pointerId: number; id: number }

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
// 逻辑不受任何影响。
//
// 但这个"推迟捕获"的决定本身留了一个洞（首轮实现遗漏、复审发现）：React 的
// onPointerMove/onPointerUp props 只在事件的传播路径经过这个包装 div 时才会触发；
// 越过阈值之前既没有 setPointerCapture、鼠标指针也没有触屏那种隐式捕获，如果一次
// pointermove 的位移直接越过了方块的边界（约 260×116px，浏览器按帧节奏派发
// pointermove，靠近边缘起手的快速拖拽很容易一帧走 16–50px），事件会落在别的元素
// 上，这个组件收不到——dragging 永远不会置 true，方块不会动；随后 pointerup 也落
// 在别处，本组件的 onPointerUp 同样收不到，dragRef.current 就此变成一条不会被清理
// 的陈旧记录。鼠标的 pointerId 在整个会话期间不变，下次哪怕只是把光标悬停到同一个
// 方块上（完全没有按键），onPointerMove 又会命中、读到这条陈旧记录、算出的位移轻易
// 超过 4px 阈值，于是在没有任何按键按下的情况下开始"拖拽"、setPointerCapture、
// 方块跟着光标跑，直到某次点击才会歪打正着地释放捕获。
//
// 解法：不再依赖 React 的事件委托来接住阈值前后的 move/up，而是在 pointerdown 里
// 用原生 window 级监听器接管这次手势从头到尾的 move/up/cancel（挂在 window 上，不
// 依赖指针当前具体落在哪个元素之上，因此无论越过阈值前后，事件都保证能送达）；手势
// 结束（正常落手、取消、或安全网兜底）时统一摘除。setPointerCapture 仍然保留、仍然
// 推迟到越过阈值后才调用——window 监听器解决的是"事件送不送得到这个组件"，
// setPointerCapture 解决的是浏览器原生的 hover/文本选择等副作用，两者不是同一件事，
// 不能相互替代。
//
// 同时接入本项目共用的窗口级拖拽安全网（dragSafetyNet.ts，TabBar.tsx/Sidebar.tsx/
// TabPanes.tsx 三处既有拖拽源都在用）：它的头部注释明确写了 lostpointercapture 经
// React 合成事件委托投递并不可靠（元素在浏览器派发这个事件之前就已经从 DOM 移除时，
// 冒泡路径里可能根本不包含 React 挂载的根节点）。这个手柄一样会遇到——例如拖拽中途
// ⌘Tab 切到别的 App（window blur），此时指针捕获仍握着、也不会有 pointerup，如果
// 没有这张网，dragRef.current 会永远停在 {dragging:true}，切回来后方块还会跟着光标
// 漂移。
function DraggableBlock({
  blockKey: key,
  thread,
  dirName,
  pos,
  containerWidth,
  subagentCount,
  onOpen,
}: {
  blockKey: string
  thread: ThreadInfo
  dirName: string
  pos: Position
  containerWidth: number
  subagentCount: number
  onOpen: (t: ThreadInfo) => void
}) {
  const dragRef = useRef<DragState | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // 摘除这次手势挂在 window 上的原生 move/up/cancel 监听器；与下面的 netCleanupRef
  // 是两件独立的事——前者是这个手柄自己的事件接管，后者是共用的窗口级安全网，各自
  // 独立挂、独立摘，互不代替（同 TabBar.tsx 的 netCleanupRef 注释）。
  const gestureCleanupRef = useRef<(() => void) | null>(null)
  const netCleanupRef = useRef<(() => void) | null>(null)
  // 每次 pointerdown 递增一次，赋给这次拖拽的 DragState.id——供下面 attachDragSafetyNet
  // 的 isDragActive 判定使用，而不是拿 pointerId 当身份。见 onPointerDown 与
  // dragSafetyNet.ts 顶部"调用方每次挂网时……"那段注释：鼠标的 pointerId 在整个会话
  // 期间恒定不变，如果拿它当"这张网是否还对应当前这次拖拽"的判据，一张本该被摘掉却
  // 意外残留的旧网会把后续任何一次新拖拽（哪怕 pointerId 相同）都误判成"自己仍然
  // 存活"，从而把新拖拽提前打断——三处既有拖拽源都用单调递增的 id 而不是 pointerId，
  // 这里保持一致。
  const nextDragIdRef = useRef(0)
  const setPosition = useOverviewStore((s) => s.setPosition)
  const commitPosition = useOverviewStore((s) => s.commitPosition)

  // 拖拽清理的唯一入口：正常落手、pointercancel、安全网兜底、组件卸载兜底都走这里，
  // 与三处既有拖拽源同一个 idiom。对"根本没有拖拽在进行"是安全的空操作，被调用多次
  // 也无害。
  const endDrag = useCallback(() => {
    gestureCleanupRef.current?.()
    gestureCleanupRef.current = null
    netCleanupRef.current?.()
    netCleanupRef.current = null
    dragRef.current = null
    // pointerdown 时无条件调用的 blockSelect() 必须有一个对应的 end()——否则单纯
    // 点一下（从未越过阈值）就会让 body 上屏蔽文本选择的 class 永久卡住，直到某个
    // 不相关的标签/侧边栏/窗格拖拽碰巧清掉它为止（复审发现：dragGhost.ts 顶部注释
    // 明确写了"调用方只需要保证 start() 之后无论走哪条退出路径都恰好调用一次
    // end()"，三处既有拖拽源都在各自的 endDrag 里这样做，这里漏掉了）。end() 对
    // "根本没有调用过 blockSelect()"也是安全的空操作，无条件调用不需要额外判断。
    useDragGhost.getState().end()
  }, [])

  useEffect(() => {
    return () => {
      if (dragRef.current) endDrag()
    }
  }, [endDrag])

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // 不在这里 preventDefault——本项目踩过的坑：pointerdown 上无条件 preventDefault
    // 会吞掉后续合成的 click，方块的双击打开/右键菜单都会点不动（见 TabPanes.tsx/
    // TabBar.tsx/Sidebar.tsx 同一处注释与 PaneDetach.test.tsx 的回归测试）。真正的
    // 抑制挪到下面 handleMove 里，只在确认越过阈值、真的开始拖拽后才调用。
    //
    // 屏蔽文本选择（SessionBlock 里标题/预览行全是可选中文本）：与三处既有拖拽源
    // 同一时机——按下就生效，与是否真的越过阈值无关，只碰 body class，不调用
    // preventDefault。
    useDragGhost.getState().blockSelect()

    const pointerId = e.pointerId
    const startPos = pos
    const dragId = ++nextDragIdRef.current
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPos, dragging: false, pointerId, id: dragId }

    const handleMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      const drag = dragRef.current
      if (!drag) return
      // e.buttons === 0 表示这次 move 到达时按键其实已经松开（正常路径下 pointerup
      // 会先摘掉这个监听器，这里理论上不该发生；留着是防御——万一某个平台/时序下
      // move 抢在 up 之前的清理完成，也不会把一次没有按键的悬停误判成拖拽在继续）。
      // 只能消掉"误判成拖拽"这一个症状，救不回已经错过的那次真实拖拽，所以不能只
      // 靠它——真正的修复是上面这一整套 window 级监听器本身。
      if (ev.buttons === 0) { endDrag(); return }
      if (!drag.dragging) {
        if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < DRAG_THRESHOLD_PX) return
        drag.dragging = true
        // 见上方组件注释：越过阈值、确认是拖拽之后才捕获指针，避免吞掉 SessionBlock
        // 自己的双击。
        wrapRef.current?.setPointerCapture?.(pointerId)
      }
      ev.preventDefault()
      const next = {
        x: drag.startPos.x + (ev.clientX - drag.startX),
        y: drag.startPos.y + (ev.clientY - drag.startY),
      }
      // 两动作范式：拖拽过程中只改内存（setPosition），不落盘——pointerup 才
      // commitPosition。经 clampPosition 钳制，拖拽途中也不会被拖出可见区。
      setPosition(key, clampPosition(next, containerWidth))
    }

    // pointerup 与 pointercancel 共用同一个收尾逻辑（与 TabPanes.tsx 的
    // onPointerCancel={onPointerUp} 同一约定）：只要越过阈值（drag.dragging 为
    // true）就落盘——pointercancel 也不例外，这与"取消"字面听起来的语义不同，但和
    // 三处既有拖拽源的约定一致（复审纠正：上一版注释在这里写成"纯点击/取消都不
    // 产生任何持久化"，不准确——取消一次已经越过阈值的拖拽同样会落盘，真正不落盘
    // 的只有从未越过阈值的纯点击）。
    const handleEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      const drag = dragRef.current
      wrapRef.current?.releasePointerCapture?.(pointerId)
      if (drag?.dragging) {
        const next = {
          x: drag.startPos.x + (ev.clientX - drag.startX),
          y: drag.startPos.y + (ev.clientY - drag.startY),
        }
        commitPosition(key, clampPosition(next, containerWidth))
      }
      endDrag()
    }

    // 挂新的手势监听器前先摘掉任何仍然挂着的旧的（与下面 netCleanupRef 同一套保险，
    // 理论上不该发生——每次手势结束都会经 endDrag() 摘掉自己的，这里是防万一）。
    gestureCleanupRef.current?.()
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
    gestureCleanupRef.current = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
    }

    // 挂新网前先摘掉任何仍然挂着的旧网——见 TabBar.tsx onTabPointerDown 同名注释，
    // 三处既有拖拽源同一套保险。isDragActive 比较的是 dragId 而不是 pointerId，
    // 理由见上方 nextDragIdRef 的注释。
    netCleanupRef.current?.()
    netCleanupRef.current = attachDragSafetyNet(
      pointerId,
      () => dragRef.current !== null && dragRef.current.id === dragId,
      endDrag,
    )
  }, [pos, key, containerWidth, setPosition, commitPosition, endDrag])

  // 指针捕获被浏览器隐式释放时补发的退出路径——与 TabBar.tsx/Sidebar.tsx/
  // TabPanes.tsx 同一理由。这里只做清理，不识别落点/不持久化，与"取消"同一处理。
  const onLostPointerCapture = useCallback(() => {
    endDrag()
  }, [endDrag])

  return (
    <div
      className="overview-block-wrap"
      data-block-key={key}
      ref={wrapRef}
      style={{ position: 'absolute', left: pos.x, top: pos.y, width: BLOCK_WIDTH_PX }}
      onPointerDown={onPointerDown}
      onLostPointerCapture={onLostPointerCapture}
    >
      <SessionBlock thread={thread} dirName={dirName} subagentCount={subagentCount} onOpen={() => onOpen(thread)} />
    </div>
  )
}
