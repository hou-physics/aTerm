import { describe, expect, it } from 'vitest'
import { clampDividerDrag, equalPaneWidths, fitsPanes, MAX_PANES, MIN_PANE_WIDTH_PX, neighborPaneId } from './paneLayout'

describe('equalPaneWidths', () => {
  it('1 个窗格占满', () => {
    expect(equalPaneWidths(1)).toEqual([1])
  })
  it('2 个窗格各占一半', () => {
    expect(equalPaneWidths(2)).toEqual([0.5, 0.5])
  })
  it('3 个窗格各占三分之一，和为 1', () => {
    const widths = equalPaneWidths(3)
    expect(widths).toHaveLength(3)
    widths.forEach((w) => expect(w).toBeCloseTo(1 / 3))
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })
  it('0 个窗格返回空数组', () => {
    expect(equalPaneWidths(0)).toEqual([])
  })
})

describe('fitsPanes：容器宽度是否够每个窗格达到 320px 最小宽度', () => {
  it('恰好达到临界值时算装得下', () => {
    expect(fitsPanes(2, 640)).toBe(true)
    expect(fitsPanes(3, 960)).toBe(true)
  })
  it('差 1px 也算装不下', () => {
    expect(fitsPanes(2, 639)).toBe(false)
    expect(fitsPanes(3, 959)).toBe(false)
  })
  it('0 个窗格恒为装得下（没有要放的东西）', () => {
    expect(fitsPanes(0, 0)).toBe(true)
  })
})

describe('clampDividerDrag：分隔条拖拽的占比数学（纯函数，覆盖两端夹紧）', () => {
  it('两窗格：正常范围内的拖拽按像素精确转换为占比', () => {
    // 容器 800px，起始各占一半（400/400）；两侧之和 800px，未夹紧范围是 [320,480]，
    // 即最多能挪 ±80px——这里向右拖 50px（未触边），验证换算本身的精度。
    const next = clampDividerDrag([0.5, 0.5], 0, 50, 800)
    expect(next[0]).toBeCloseTo(450 / 800)
    expect(next[1]).toBeCloseTo(350 / 800)
    expect(next[0] + next[1]).toBeCloseTo(1)
  })

  it('两窗格：拖到远超右侧最小宽度时，左侧被夹到"容器宽度 - 320px"这个上限', () => {
    const next = clampDividerDrag([0.5, 0.5], 0, 1000, 800)
    expect(next[0] * 800).toBeCloseTo(800 - MIN_PANE_WIDTH_PX) // 480px
    expect(next[1] * 800).toBeCloseTo(MIN_PANE_WIDTH_PX) // 320px，右侧被夹到最小宽度
  })

  it('两窗格：向左拖到远超左侧最小宽度时，左侧被夹到 320px 下限', () => {
    const next = clampDividerDrag([0.5, 0.5], 0, -1000, 800)
    expect(next[0] * 800).toBeCloseTo(MIN_PANE_WIDTH_PX) // 320px，左侧被夹到最小宽度
    expect(next[1] * 800).toBeCloseTo(800 - MIN_PANE_WIDTH_PX) // 480px
  })

  it('三窗格：只调整被拖动分隔条两侧的窗格，第三个窗格占比不受影响', () => {
    const widths = equalPaneWidths(3) // [1/3, 1/3, 1/3]，容器 1200px（各 400px）
    const next = clampDividerDrag(widths, 0, -1000, 1200) // 拖 index 0（pane0/pane1 之间）
    expect(next[2]).toBeCloseTo(widths[2]) // 第三个窗格原样不变
    expect(next[0] * 1200).toBeCloseTo(MIN_PANE_WIDTH_PX) // pane0 被夹到 320px 下限
    expect(next[1] * 1200).toBeCloseTo(800 - MIN_PANE_WIDTH_PX) // pane0+pane1 的 800px 里剩下的都给 pane1
    expect(next[0] + next[1] + next[2]).toBeCloseTo(1)
  })

  it('三窗格：拖动 index 1（pane1/pane2 之间）不影响 pane0', () => {
    const widths = equalPaneWidths(3) // 容器 1200px，各 400px；pane1/pane2 这一对的和为 800px，
    // 未夹紧范围内的拖拽是 [320, 480]（相对各自 400px 的起点，最多能挪 ±80px）
    const next = clampDividerDrag(widths, 1, 50, 1200)
    expect(next[0]).toBeCloseTo(widths[0])
    expect(next[1] * 1200).toBeCloseTo(450)
    expect(next[2] * 1200).toBeCloseTo(350)
  })

  it('容器宽度为 0 或负数时原样返回，不产生 NaN/Infinity', () => {
    const widths = [0.5, 0.5]
    expect(clampDividerDrag(widths, 0, 100, 0)).toBe(widths)
    expect(clampDividerDrag(widths, 0, 100, -10)).toBe(widths)
  })

  it('index 越界（最后一个窗格右侧、或负数）时原样返回', () => {
    const widths = equalPaneWidths(3)
    expect(clampDividerDrag(widths, 2, 100, 1200)).toBe(widths)
    expect(clampDividerDrag(widths, -1, 100, 1200)).toBe(widths)
  })
})

describe('neighborPaneId：⌘⌥←/→ 焦点移动，边界不循环', () => {
  const ids = ['a', 'b', 'c']

  it('中间窗格向右移动到下一个', () => {
    expect(neighborPaneId(ids, 'b', 1)).toBe('c')
  })
  it('中间窗格向左移动到上一个', () => {
    expect(neighborPaneId(ids, 'b', -1)).toBe('a')
  })
  it('已在最右侧窗格时向右移动，不循环回第一个（返回 undefined）', () => {
    expect(neighborPaneId(ids, 'c', 1)).toBeUndefined()
  })
  it('已在最左侧窗格时向左移动，不循环回最后一个（返回 undefined）', () => {
    expect(neighborPaneId(ids, 'a', -1)).toBeUndefined()
  })
  it('没有窗格时返回 undefined', () => {
    expect(neighborPaneId([], 'a', 1)).toBeUndefined()
  })
  it('activePaneId 未知或缺省时落到第一个窗格', () => {
    expect(neighborPaneId(ids, undefined, 1)).toBe('a')
    expect(neighborPaneId(ids, 'not-found', -1)).toBe('a')
  })
})

describe('MAX_PANES', () => {
  it('上限为 3', () => {
    expect(MAX_PANES).toBe(3)
  })
})
