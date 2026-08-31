import { describe, expect, it } from 'vitest'
import {
  dropIndicatorPreviewRect,
  dropIndicatorRect,
  dropInsertionIndex,
  pointInRect,
  resolveDropMode,
  resolveDropTarget,
  resolveReorderTarget,
  resolveTabBarInsertIndex,
  type PaneSlotRect,
} from './paneDrop'

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

// 同标签内窗格重排（TabPanes.tsx）专用的落点解析：整块命中，不分左右半侧——用户
// 真机验收报告的根因（见 paneDrop.ts 顶部对应函数的注释）：resolveDropTarget 的半侧
// 换算叠加 dropInsertionIndex/reorderInsertIndex 两步下标换算后，目标窗格的某一侧会
// 恰好换算回源窗格原来的下标，变成"只有某个 critical 位置才能拖成功"。这里直接验证
// 修复本身：命中同一个窗格的左边缘、正中、右边缘应该返回完全相同的结果。
describe('resolveReorderTarget：同标签内窗格重排——整块命中，不分左右半侧', () => {
  it('命中同一个窗格的左边缘、正中、右边缘，结果一致（不再有"半侧"这回事）', () => {
    expect(resolveReorderTarget(THREE, 300, 50)).toBe('p1') // 左边缘（左闭）
    expect(resolveReorderTarget(THREE, 449, 50)).toBe('p1') // 中点左侧
    expect(resolveReorderTarget(THREE, 450, 50)).toBe('p1') // 恰好中点——resolveDropTarget 在这里会翻到 'right'
    expect(resolveReorderTarget(THREE, 599, 50)).toBe('p1') // 右边缘前一像素（右开）
  })
  it('命中第一个/第三个窗格', () => {
    expect(resolveReorderTarget(THREE, 100, 50)).toBe('p0')
    expect(resolveReorderTarget(THREE, 700, 50)).toBe('p2')
  })
  it('光标不在任何窗格范围内（水平或垂直）返回 null', () => {
    expect(resolveReorderTarget(THREE, -10, 50)).toBeNull()
    expect(resolveReorderTarget(THREE, 900, 50)).toBeNull()
    expect(resolveReorderTarget(THREE, 100, 100)).toBeNull() // 上闭下开，恰好等于 height 算行外
  })
  it('没有任何窗格时恒返回 null', () => {
    expect(resolveReorderTarget([], 100, 50)).toBeNull()
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

// 窗格拖出成独立标签（设计文档 §5-C）用到的两个纯函数：pointInRect（判断光标是否还在
// 源标签自己的窗格行 / 标签栏范围内）、resolveTabBarInsertIndex（落在标签栏上时换算
// 插入下标）。
describe('pointInRect：光标是否落在某个矩形内（左闭右开、上闭下开）', () => {
  const rect = { top: 10, left: 20, width: 100, height: 50 }
  it('矩形内部命中', () => {
    expect(pointInRect(50, 30, rect)).toBe(true)
  })
  it('左/上边界命中，右/下边界不命中', () => {
    expect(pointInRect(20, 30, rect)).toBe(true)
    expect(pointInRect(50, 10, rect)).toBe(true)
    expect(pointInRect(120, 30, rect)).toBe(false) // left+width
    expect(pointInRect(50, 60, rect)).toBe(false) // top+height
  })
  it('矩形外部不命中', () => {
    expect(pointInRect(0, 0, rect)).toBe(false)
  })
})

// 落点语义判定（本次修复 Fix 1）：目标窗格没有 ptyId（⌘D 新建后还没选定会话、正在
// 渲染 PanePicker 的空槽）时，拖放应该"填充"这个槽位而不是在旁边"插入"新窗格。
describe('resolveDropMode：目标窗格是否为空槽决定落点语义', () => {
  it('目标窗格没有 ptyId：fill', () => {
    expect(resolveDropMode({ ptyId: undefined })).toBe('fill')
    expect(resolveDropMode({})).toBe('fill')
  })
  it('目标窗格已有 ptyId：insert（既有行为）', () => {
    expect(resolveDropMode({ ptyId: 'pty-1' })).toBe('insert')
  })
  it('目标窗格不存在（理论上不应发生）：退化为 insert，不当成空槽处理', () => {
    expect(resolveDropMode(undefined)).toBe('insert')
  })
})

describe('dropIndicatorPreviewRect：落点指示条按落点语义选择覆盖范围', () => {
  const rect = { top: 0, left: 100, width: 200, height: 50 }
  it('fill：覆盖整个窗格，不切半，与 side 无关', () => {
    expect(dropIndicatorPreviewRect(rect, 'fill', 'left')).toEqual(rect)
    expect(dropIndicatorPreviewRect(rect, 'fill', 'right')).toEqual(rect)
  })
  it('reorder：同样覆盖整个窗格，不切半，与 side 无关（同标签内重排，见 resolveReorderTarget）', () => {
    expect(dropIndicatorPreviewRect(rect, 'reorder', 'left')).toEqual(rect)
    expect(dropIndicatorPreviewRect(rect, 'reorder', 'right')).toEqual(rect)
  })
  it('insert：与既有 dropIndicatorRect 一致，按 side 切半', () => {
    expect(dropIndicatorPreviewRect(rect, 'insert', 'left')).toEqual(dropIndicatorRect(rect, 'left'))
    expect(dropIndicatorPreviewRect(rect, 'insert', 'right')).toEqual(dropIndicatorRect(rect, 'right'))
  })
})

describe('resolveTabBarInsertIndex：光标 x 坐标换算成该插入 tabs 数组的下标', () => {
  const TABS = [
    { rect: { top: 0, left: 0, width: 100, height: 26 } }, // 中点 50
    { rect: { top: 0, left: 100, width: 100, height: 26 } }, // 中点 150
    { rect: { top: 0, left: 200, width: 100, height: 26 } }, // 中点 250
  ]
  it('光标在第一个标签中点左侧：插在最前面（下标 0）', () => {
    expect(resolveTabBarInsertIndex(TABS, 10)).toBe(0)
  })
  it('光标在两个标签中点之间：插在后一个标签之前', () => {
    expect(resolveTabBarInsertIndex(TABS, 120)).toBe(1)
    expect(resolveTabBarInsertIndex(TABS, 220)).toBe(2)
  })
  it('光标在最后一个标签中点右侧：追加到末尾', () => {
    expect(resolveTabBarInsertIndex(TABS, 280)).toBe(3)
  })
  it('没有任何标签矩形：恒为 0（等同追加，数组本就是空的）', () => {
    expect(resolveTabBarInsertIndex([], 100)).toBe(0)
  })
})
