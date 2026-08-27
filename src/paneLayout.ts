// 分屏窗格布局的纯函数集合：占比计算、分隔条拖拽夹紧、宽度是否足够容纳 N 个窗格、
// 焦点在窗格间移动（不循环）。全部不依赖 DOM/React/Zustand，供
// src/components/TabPanes.tsx、src/App.tsx、src/store/tabs.ts 共用，也便于在 jsdom
// 无法验证真实布局的前提下单独测试这套数学关系（见
// docs/superpowers/specs/2026-08-27-split-view-design.md §3、§6、§9）。

export const MAX_PANES = 3
export const MIN_PANE_WIDTH_PX = 320

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
