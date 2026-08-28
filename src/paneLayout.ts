// 分屏窗格布局的纯函数集合：占比计算、分隔条拖拽夹紧、宽度是否足够容纳 N 个窗格、
// 焦点在窗格间移动（不循环）。全部不依赖 DOM/React/Zustand，供
// src/components/TabPanes.tsx、src/App.tsx、src/store/tabs.ts 共用，也便于在 jsdom
// 无法验证真实布局的前提下单独测试这套数学关系（见
// docs/superpowers/specs/2026-08-27-split-view-design.md §3、§6、§9）。

export const MAX_PANES = 3
export const MIN_PANE_WIDTH_PX = 320

// 下面三个常量对应 App.css 里三条真实吃掉水平空间、但不参与"按 flexGrow 分配"的 DOM
// 开销——量出来的 clientWidth（.term-wrap 或 .content）把它们都算在内，但
// fitsPanes/clampDividerDrag 关心的是"分给窗格内容区"的可用宽度，两者不是一回事
// （见 review：320px 保证在真实渲染像素里因此站不住）。每条常量都在旁边写明对应哪条
// CSS 规则，改 CSS 时务必同步改这里的数字，否则这份保证会再次悄悄失效。
// .term-wrap { padding: 4px 6px 6px 6px } —— 左右各 6px，容器自身内边距，flex 子项
// （窗格/分隔条）分不到。
export const TERM_WRAP_HORIZONTAL_PADDING_PX = 12
// .pane-divider { flex: none; width: 1px; padding: 0 4px } —— 1px 视觉线 + 左右各
// 4px 命中区 = 9px，每条分隔条都从窗格可用空间里先扣掉（(paneCount-1) 条）。
export const DIVIDER_TOTAL_WIDTH_PX = 9
// .pane { border: 1px solid transparent } —— 左右各 1px，物理上占用水平空间（无论
// box-sizing 是 content-box 还是 border-box，边框本身都不是可以分给内容的那部分
// 宽度），每个窗格都有一份，乘以窗格数一起扣掉。
export const PANE_BORDER_TOTAL_WIDTH_PX = 2

// 把"测量到的、包含上面这些开销的原始宽度"（.term-wrap 或 .content 的 clientWidth）
// 换算成真正按 flexGrow 分给 paneCount 个窗格内容区的可用宽度。调用 fitsPanes /
// decidePaneFit / clampDividerDrag 之前必须先过一遍这个函数——直接把测量值当成
// "可以被 paneCount 整除"的宽度传进去，会让 320px 最小宽度这个保证在真实渲染像素
// 里差出几到十几像素（见 review 记录的 CSS 盒模型分析）。paneCount<=0 时没有意义，
// 原样返回测量值；结果不会低于 0（度量异常/容器还没布局时兜底，避免负数向下游
// 传播出 NaN/Infinity）。
export function usablePaneAreaWidth(measuredWidthPx: number, paneCount: number): number {
  if (paneCount <= 0) return measuredWidthPx
  const overhead =
    TERM_WRAP_HORIZONTAL_PADDING_PX + (paneCount - 1) * DIVIDER_TOTAL_WIDTH_PX + paneCount * PANE_BORDER_TOTAL_WIDTH_PX
  return Math.max(0, measuredWidthPx - overhead)
}

// 等分：N 个窗格各 1/N，和恒为 1（除非有浮点误差，测试里按浮点近似比较）。
export function equalPaneWidths(n: number): number[] {
  if (n <= 0) return []
  return Array.from({ length: n }, () => 1 / n)
}

// 给定当前占比数组，判断把某个窗格数放进 widthPx 像素的容器是否每个窗格都能达到
// 最小宽度——不关心具体占比如何分配，只回答"装得下装不下"，用于 ⌘D 创建窗格前的
// 窄窗口降级判断（设计文档 §8）：先看当前宽度装不装得下，装不下再看收起对话面板后
// 腾出的宽度装不装得下，都不行就拒绝创建。
export function fitsPanes(paneCount: number, widthPx: number): boolean {
  if (paneCount <= 0) return true
  return widthPx >= paneCount * MIN_PANE_WIDTH_PX
}

// 窄窗口降级判断（设计文档 §8）：先看当前内容区宽度是否装得下 nextCount 个窗格；
// 装不下且对话面板展开着时，看收起面板腾出的宽度装不装得下；都不行则拒绝。只回答
// "怎么办"，不执行任何副作用（不实际收起面板/不实际创建或移动窗格）——调用方
// （App.tsx 的 ⌘D 处理器、TabBar.tsx/Sidebar.tsx 的拖放处理器，三处共用同一份判断）
// 据此决定下一步，也据此决定要不要复用 store/hint.ts 弹出同一条轻提示。
export type PaneFitDecision = 'fits' | 'collapse-panel' | 'refuse'

export function decidePaneFit(
  nextCount: number,
  contentWidth: number,
  panelCollapsed: boolean,
  panelWidth: number,
): PaneFitDecision {
  if (fitsPanes(nextCount, contentWidth)) return 'fits'
  if (!panelCollapsed && fitsPanes(nextCount, contentWidth + panelWidth)) return 'collapse-panel'
  return 'refuse'
}

// 装不下时具体差多少像素——配合"窗口太窄，还差 Npx"这条拖拽过程中持续显示的提示
// （本次修复 Fix 3：不能再让用户等到松手才知道会被拒绝，见 paneDrop.ts 顶部 DropMode
// 注释同一份背景）。装得下时返回 0，只是避免调用方在这种状态下误用出现负数文案——
// 正常流程只应该在真的装不下时才读这个值。paneCount<=0 时没有意义，同 fitsPanes 一样
// 视为"没有要放的东西"，返回 0。
export function paneFitShortfall(paneCount: number, widthPx: number): number {
  if (paneCount <= 0) return 0
  return Math.max(0, paneCount * MIN_PANE_WIDTH_PX - widthPx)
}

// 拖放会不会被接受的完整判断：先按落点语义（paneDrop.ts 的 DropMode）算出真正的
// "结果窗格数"——'fill'（落在空槽窗格上）总数不变，'insert'（既有行为）总数变为
// currentCount + draggedCount，这正是本次修复要补上的设计间隙：此前一律按 insert
// 计数，会把"填充"误判成"插入"从而错误拒绝（见 .superpowers/pane-fill-report.md 的
// 诊断记录）——再依次检查数量上限（MAX_PANES）与像素宽度（decidePaneFit）。
//
// 供 TabBar.tsx/Sidebar.tsx 在 pointermove（拖拽过程中的实时预览，Fix 3）与
// pointerup（真正执行这次落点）两个时机共用同一份判断：两处如果各自实现一遍，稍有
// 出入就会出现"指示说能放、松手却被拒绝"这种自相矛盾的体验，这正是本次要修的问题
// 之一。rawContentWidthPx 是未经 usablePaneAreaWidth 换算的原始测量值（调用方直接
// 传 getContentWidth() 的返回值，换算交给这里按算出来的 resultingCount 现算——
// 换算所需的窗格数只有在这里才知道，调用方不能先算好再传进来）。
//
// decision 为 'refuse' 时才计算 shortfall：achievable 是"最多能腾出多少可用宽度"——
// 面板已收起就是 usable 本身，未收起则是收起它之后的 usable + panelWidthPx（与
// decidePaneFit 内部 collapse-panel 分支判断的是同一个假设宽度，这里只是在已经确定
// "即使收起也不够"时，反过来算出具体差多少）。
export type DropFitPreview = {
  resultingCount: number
  decision: PaneFitDecision
  refused: boolean
  refusalKind: 'max-panes' | 'too-narrow' | null
  reason: string | null
}

export function previewPaneDrop(
  mode: 'fill' | 'insert',
  currentCount: number,
  draggedCount: number,
  rawContentWidthPx: number,
  panelCollapsed: boolean,
  panelWidthPx: number,
): DropFitPreview {
  const resultingCount = mode === 'fill' ? currentCount : currentCount + draggedCount
  if (resultingCount > MAX_PANES) {
    return { resultingCount, decision: 'refuse', refused: true, refusalKind: 'max-panes', reason: '最多支持 3 个窗格' }
  }
  const usable = usablePaneAreaWidth(rawContentWidthPx, resultingCount)
  const decision = decidePaneFit(resultingCount, usable, panelCollapsed, panelWidthPx)
  if (decision !== 'refuse') {
    return { resultingCount, decision, refused: false, refusalKind: null, reason: null }
  }
  const achievable = panelCollapsed ? usable : usable + panelWidthPx
  const shortfall = paneFitShortfall(resultingCount, achievable)
  return { resultingCount, decision: 'refuse', refused: true, refusalKind: 'too-narrow', reason: `窗口太窄，还差 ${shortfall}px` }
}

// 拖拽分隔条：只调整 index 与 index+1 这两个相邻窗格的占比，其余窗格占比原样保留
// （设计文档 §3"拖动改变两侧占比，其余窗格不受影响"）。deltaPx 为指针在容器坐标系
// 下的水平位移（正值＝右移＝左侧窗格变宽）。两侧窗格的像素宽度之和（pairPx）不变，
// 只在这个和里重新分配；每侧都不允许低于 MIN_PANE_WIDTH_PX，在和不足以让两侧都达到
// 最小宽度的退化情况下（理论上不应发生，见 §8 的创建前置检查），优先保证左侧不低于
// 下限，右侧可能被压到低于下限——这只是数学上的兜底，不代表 UI 层允许这种状态出现。
export function clampDividerDrag(
  widths: number[],
  index: number,
  deltaPx: number,
  containerWidthPx: number,
): number[] {
  if (containerWidthPx <= 0) return widths
  if (index < 0 || index >= widths.length - 1) return widths
  const leftPx0 = widths[index] * containerWidthPx
  const rightPx0 = widths[index + 1] * containerWidthPx
  const pairPx = leftPx0 + rightPx0
  const minLeft = MIN_PANE_WIDTH_PX
  const maxLeft = pairPx - MIN_PANE_WIDTH_PX
  let leftPx = leftPx0 + deltaPx
  leftPx = Math.min(Math.max(leftPx, minLeft), Math.max(maxLeft, minLeft))
  const rightPx = pairPx - leftPx
  const next = widths.slice()
  next[index] = leftPx / containerWidthPx
  next[index + 1] = rightPx / containerWidthPx
  return next
}

// ⌘⌥←/→：在窗格 id 数组里按 delta（-1/+1）移动焦点，边界不循环——已在最左/最右侧时
// 返回 undefined（调用方据此保持原焦点不变），不像 Ctrl+Tab 那样回绕到另一端。
// activePaneId 为 undefined 或不在数组中时，视为"尚未聚焦任何窗格"，落到第一个窗格。
export function neighborPaneId(
  paneIds: string[],
  activePaneId: string | undefined,
  delta: -1 | 1,
): string | undefined {
  if (paneIds.length === 0) return undefined
  const idx = activePaneId ? paneIds.indexOf(activePaneId) : -1
  if (idx === -1) return paneIds[0]
  const next = idx + delta
  if (next < 0 || next >= paneIds.length) return undefined
  return paneIds[next]
}
