import { describe, expect, it } from 'vitest'
import {
  BLOCK_GAP_PX, BLOCK_HEIGHT_PX, BLOCK_WIDTH_PX,
  canvasHeight, clampPosition, columnsForWidth, gridSlot,
} from '../overviewLayout'

describe('columnsForWidth', () => {
  it('按方块宽与间距算列数', () => {
    expect(columnsForWidth(BLOCK_WIDTH_PX)).toBe(1)
    expect(columnsForWidth(BLOCK_WIDTH_PX * 2 + BLOCK_GAP_PX)).toBe(2)
    expect(columnsForWidth(BLOCK_WIDTH_PX * 3 + BLOCK_GAP_PX * 2)).toBe(3)
  })
  it('窗口再窄也至少一列，不返回 0 导致除零', () => {
    expect(columnsForWidth(10)).toBe(1)
    expect(columnsForWidth(0)).toBe(1)
  })
})

describe('gridSlot', () => {
  it('按行优先排布', () => {
    expect(gridSlot(0, 3)).toEqual({ x: 0, y: 0 })
    expect(gridSlot(2, 3)).toEqual({ x: (BLOCK_WIDTH_PX + BLOCK_GAP_PX) * 2, y: 0 })
    expect(gridSlot(3, 3)).toEqual({ x: 0, y: BLOCK_HEIGHT_PX + BLOCK_GAP_PX })
  })
})

describe('clampPosition —— 读取持久化位置的路径上必须钳制', () => {
  it('负坐标拉回原点', () => {
    expect(clampPosition({ x: -50, y: -30 }, 1000)).toEqual({ x: 0, y: 0 })
  })
  it('超出右边界的方块拉回可见区（否则换小屏后方块永久失踪）', () => {
    const w = 600
    expect(clampPosition({ x: 5000, y: 40 }, w)).toEqual({ x: w - BLOCK_WIDTH_PX, y: 40 })
  })
  it('容器比方块还窄时不产生负的 x', () => {
    expect(clampPosition({ x: 999, y: 0 }, 100)).toEqual({ x: 0, y: 0 })
  })
})

describe('canvasHeight', () => {
  it('无自定义位置时按网格行数算高', () => {
    expect(canvasHeight(4, 3, {})).toBe((BLOCK_HEIGHT_PX + BLOCK_GAP_PX) * 2)
  })
  it('有方块被拖到很下面时画布跟着变高', () => {
    expect(canvasHeight(1, 3, { k: { x: 0, y: 900 } })).toBe(900 + BLOCK_HEIGHT_PX + BLOCK_GAP_PX)
  })
})
