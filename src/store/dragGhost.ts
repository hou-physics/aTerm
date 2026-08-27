import { create } from 'zustand'

// 拖拽期间屏蔽文本选择 + 跟随光标的拖拽指示（用户明确反馈的两个痛点：拖拽会顺带选中
// 相邻文字；拖拽过程中没有任何视觉反馈，感觉不像在"拖"东西）。三个拖拽源
// （TabBar.tsx 拖标签、Sidebar.tsx 拖「最近会话」、TabPanes.tsx 拖窗格标题栏）共用
// 这一份 store，而不是各自维护一份——同一套"拖拽开始/结束"语义，没有理由写三遍。
//
// body class 的增删收在 start()/end() 里（而不是交给某个组件的 effect 去 diff
// visible），是为了让"拖拽结束就一定移除"这件事不依赖任何组件是否挂载、是否重渲染
// ——调用方只需要保证 start() 之后无论走哪条退出路径（松手成功、松手落空、
// pointercancel）都恰好调用一次 end()，class 就绝不会卡住（三个拖拽源都遵循同一个
// 既有 idiom：在 onPointerUp/onPointerCancel 共用的处理函数最开头、任何 return 之前
// 无条件调用一次 end()，与它们本来就有的 useDnd.setTarget(null) 是同一处、同一时机，
// 见各自文件）。end() 对"根本没开始过"的情况也是安全的空操作（class 本就不存在，
// visible 本就是 false），因此调用方总是无条件调用它，不需要先判断"是否真的在拖"。
const DRAG_NO_SELECT_CLASS = 'dragging-no-select'

type DragGhostState = {
  visible: boolean
  label: string
  x: number
  y: number
  blockSelect(): void
  start(label: string, x: number, y: number): void
  move(x: number, y: number): void
  end(): void
}

// move() 高频触发（每次 pointermove），与 TerminalLayer.tsx 的 scheduleRecompute 同一套
// "多次连续触发合并进同一个 requestAnimationFrame"节流模式——拖拽指示只需要跟手，不需要
// 比屏幕刷新率更快地更新，没必要每个 pointermove 都触发一次 React 重渲染。
let frame = 0
let pendingXY: { x: number; y: number } | null = null

function flush() {
  frame = 0
  if (pendingXY) {
    useDragGhost.setState(pendingXY)
    pendingXY = null
  }
}

export const useDragGhost = create<DragGhostState>((set) => ({
  visible: false,
  label: '',
  x: 0,
  y: 0,
  // 三个拖拽源在各自 pointerdown 里第一件事就调用它（见 TabBar.tsx/Sidebar.tsx/
  // TabPanes.tsx）：这一刻还不知道这次按下最终会不会跨过 4px 阈值变成真正的拖拽，
  // 但"屏蔽文本选择"这件事无论如何都该立刻生效（用户反馈"拖拽会顺带选中相邻文字"，
  // 越早屏蔽越不会有选中的那一瞬间）——与是否真的开始拖拽无关，也不影响 visible/
  // label（跟随光标的指示只在确认是拖拽、调用 start() 后才出现）。
  //
  // 关键的是它只碰 body class，绝不调用 event.preventDefault()：那是上一轮引入的
  // 回归（见 .superpowers/tab-menu-reorder-report.md）——pointerdown 上无条件
  // preventDefault 会抑制随后本该正常触发的合成 click，而右键菜单（PaneContextMenu
  // 等）是作为拖拽手柄的 DOM 子节点渲染的（position:fixed 只改变视觉位置，不改变它在
  // React 树/DOM 树里仍是拖拽手柄后代这一事实），点击菜单项时 pointerdown 会先冒泡
  // 经过拖拽手柄——一旦手柄的 pointerdown 处理器无条件 preventDefault，菜单项自己的
  // click 就再也发不出来。真正的默认动作抑制现在挪到了 pointermove 里、且只在确认
  // 跨过阈值（drag.dragging 变 true）之后才调用，一次普通点击（含点在菜单项上）永远
  // 不会跨过阈值，因此不受影响。
  blockSelect: () => {
    document.body.classList.add(DRAG_NO_SELECT_CLASS)
  },
  start: (label, x, y) => {
    document.body.classList.add(DRAG_NO_SELECT_CLASS)
    set({ visible: true, label, x, y })
  },
  move: (x, y) => {
    pendingXY = { x, y }
    if (!frame && typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(flush)
  },
  end: () => {
    if (frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
    pendingXY = null
    document.body.classList.remove(DRAG_NO_SELECT_CLASS)
    set({ visible: false })
  },
}))
