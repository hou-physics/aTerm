// 总览页方块排布的纯函数集合（spec §5.2）：列数、网格落点、拖拽位置钳制、画布高度。
// 全部不依赖 DOM/React/Zustand，供 src/components/OverviewPage.tsx 使用——与
// paneLayout.ts / paneGeometry.ts 拆出来的理由完全一样：jsdom 不做真实布局
// （getBoundingClientRect() 恒返回全 0 矩形，没有 ResizeObserver），组件测试因此无法
// 验证"800px 宽时该排几列""方块被拖出右边界时钳到哪里"这类几何关系；把它们放在这里，
// 就能脱离渲染直接对这套数学本身写断言（见 src/__tests__/overviewLayout.test.ts），
// 组件那边只负责把量到的真实宽度喂进来。
//
// 三个常量的落地方式不同，别把它们当成同一类东西：BLOCK_WIDTH_PX 是被强制的
// （OverviewPage.tsx 把它当行内 style 写在 .overview-block-wrap 上），而
// BLOCK_HEIGHT_PX 只是"方块实际渲染多高"的估值——.session-block 的高度由内容撑开，
// CSS 里没有任何一条规则固定它。它只用来决定网格里行与行的间距，估小了相邻两行会
// 挨得偏近；改动 SessionBlock 的行数/字号/内边距时要回头看一眼这个数字。

export const BLOCK_WIDTH_PX = 260
export const BLOCK_HEIGHT_PX = 116
export const BLOCK_GAP_PX = 16

export function columnsForWidth(containerWidth: number): number {
  const per = BLOCK_WIDTH_PX + BLOCK_GAP_PX
  return Math.max(1, Math.floor((containerWidth + BLOCK_GAP_PX) / per))
}

export function gridSlot(index: number, columns: number) {
  const col = index % columns
  const row = Math.floor(index / columns)
  return { x: col * (BLOCK_WIDTH_PX + BLOCK_GAP_PX), y: row * (BLOCK_HEIGHT_PX + BLOCK_GAP_PX) }
}

export function clampPosition(pos: { x: number; y: number }, containerWidth: number) {
  const maxX = Math.max(0, containerWidth - BLOCK_WIDTH_PX)
  return { x: Math.min(Math.max(0, pos.x), maxX), y: Math.max(0, pos.y) }
}

export function canvasHeight(count: number, columns: number, positions: Record<string, { x: number; y: number }>): number {
  const rows = Math.ceil(count / columns)
  const gridHeight = rows * (BLOCK_HEIGHT_PX + BLOCK_GAP_PX)

  const positionValues = Object.values(positions)
  if (positionValues.length === 0) {
    return gridHeight
  }

  const maxCustomHeight = Math.max(
    ...positionValues.map(pos => pos.y + BLOCK_HEIGHT_PX + BLOCK_GAP_PX)
  )

  return Math.max(gridHeight, maxCustomHeight)
}
