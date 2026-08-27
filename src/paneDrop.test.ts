import { describe, expect, it } from 'vitest'
import { dropIndicatorRect, dropInsertionIndex, resolveDropTarget, type PaneSlotRect } from './paneDrop'

// 三个并排窗格，各 300px 宽、100px 高，贴着 y=[0,100)（与真实横向分屏布局一致）。
const THREE: PaneSlotRect[] = [
  { paneId: 'p0', rect: { top: 0, left: 0, width: 300, height: 100 } },
  { paneId: 'p1', rect: { top: 0, left: 300, width: 300, height: 100 } },
  { paneId: 'p2', rect: { top: 0, left: 600, width: 300, height: 100 } },
]

describe('resolveDropTarget：光标位置命中哪个窗格的左/右半侧', () => {
  it('命中第一个窗格的左半侧', () => {
    expect(resolveDropTarget(THREE, 100, 50)).toEqual({ paneId: 'p0', side: 'left' })
  })
  it('命中第一个窗格的右半侧（恰好在中点，算右半）', () => {
    expect(resolveDropTarget(THREE, 150, 50)).toEqual({ paneId: 'p0', side: 'right' })
    expect(resolveDropTarget(THREE, 200, 50)).toEqual({ paneId: 'p0', side: 'right' })
  })
  it('命中第二个（中间）窗格的左/右半侧', () => {
    expect(resolveDropTarget(THREE, 350, 50)).toEqual({ paneId: 'p1', side: 'left' })
    expect(resolveDropTarget(THREE, 550, 50)).toEqual({ paneId: 'p1', side: 'right' })
  })
  it('命中第三个窗格的左/右半侧', () => {
    expect(resolveDropTarget(THREE, 650, 50)).toEqual({ paneId: 'p2', side: 'left' })
    expect(resolveDropTarget(THREE, 850, 50)).toEqual({ paneId: 'p2', side: 'right' })
  })
  it('光标在任何窗格范围之外（水平方向）返回 null', () => {
    expect(resolveDropTarget(THREE, -10, 50)).toBeNull()
    expect(resolveDropTarget(THREE, 900, 50)).toBeNull()
  })
  it('光标在任何窗格范围之外（垂直方向，行内但行外）返回 null', () => {
    expect(resolveDropTarget(THREE, 100, -5)).toBeNull()
    expect(resolveDropTarget(THREE, 100, 100)).toBeNull() // 上闭下开，恰好等于 height 算行外
  })
  it('右边界恰好等于 left+width 时不算命中当前窗格（左闭右开）', () => {
    // x=300 恰好是 p0 的右边界 = p1 的左边界，应命中 p1 而非 p0
    expect(resolveDropTarget(THREE, 300, 50)).toEqual({ paneId: 'p1', side: 'left' })
  })
  it('没有任何窗格（例如当前标签是 home，无 panes）恒返回 null', () => {
    expect(resolveDropTarget([], 100, 50)).toBeNull()
  })
})

describe('dropIndicatorRect：落点指示条覆盖目标窗格的左半或右半', () => {
  const rect = { top: 0, left: 100, width: 200, height: 50 }
  it('左半：宽度减半，left 不变', () => {
    expect(dropIndicatorRect(rect, 'left')).toEqual({ top: 0, left: 100, width: 100, height: 50 })
  })
  it('右半：宽度减半，left 平移到中点', () => {
    expect(dropIndicatorRect(rect, 'right')).toEqual({ top: 0, left: 200, width: 100, height: 50 })
  })
})

describe('dropInsertionIndex：落点换算成 panes 数组下标', () => {
  const ids = ['a', 'b', 'c']
  it('落在某窗格左半侧：插在该窗格之前（同一下标）', () => {
    expect(dropInsertionIndex(ids, { paneId: 'a', side: 'left' })).toBe(0)
    expect(dropInsertionIndex(ids, { paneId: 'b', side: 'left' })).toBe(1)
    expect(dropInsertionIndex(ids, { paneId: 'c', side: 'left' })).toBe(2)
  })
  it('落在某窗格右半侧：插在该窗格之后（下标+1）', () => {
    expect(dropInsertionIndex(ids, { paneId: 'a', side: 'right' })).toBe(1)
    expect(dropInsertionIndex(ids, { paneId: 'c', side: 'right' })).toBe(3)
  })
  it('目标窗格不在数组中时退化为追加到末尾', () => {
    expect(dropInsertionIndex(ids, { paneId: 'not-there', side: 'left' })).toBe(3)
  })
})
