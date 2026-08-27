import { describe, expect, it } from 'vitest'
import { computeWrapperStyles, slotToWrapperStyle } from './paneGeometry'

// jsdom 不做真实布局，getBoundingClientRect() 恒返回全 0——真实的坐标换算逻辑只能
// 脱离 DOM，单独当纯函数验证（与 paneLayout.test.ts 对 clampDividerDrag 等的处理是
// 同一思路）。

describe('slotToWrapperStyle', () => {
  it('容器在视口原点、插槽紧贴容器左上角：包裹层坐标等于插槽自身尺寸，偏移为 0', () => {
    const slot = { top: 0, left: 0, width: 300, height: 200 }
    const container = { top: 0, left: 0, width: 300, height: 200 }
    expect(slotToWrapperStyle(slot, container)).toEqual({ top: 0, left: 0, width: 300, height: 200 })
  })

  it('容器偏离视口原点：包裹层坐标是插槽与容器视口坐标之差，不是插槽自身的视口坐标', () => {
    const slot = { top: 150, left: 260, width: 400, height: 500 }
    const container = { top: 40, left: 230, width: 900, height: 700 }
    expect(slotToWrapperStyle(slot, container)).toEqual({ top: 110, left: 30, width: 400, height: 500 })
  })

  it('多窗格场景：同一容器下，两个并排插槽换算出互不重叠、左右相邻的包裹层坐标', () => {
    const container = { top: 40, left: 0, width: 640, height: 600 }
    const leftSlot = { top: 64, left: 4, width: 314, height: 530 } // 标题栏 24px 之下
    const rightSlot = { top: 64, left: 323, width: 313, height: 530 } // 分隔条 9px 之后
    const left = slotToWrapperStyle(leftSlot, container)
    const right = slotToWrapperStyle(rightSlot, container)
    expect(left).toEqual({ top: 24, left: 4, width: 314, height: 530 })
    expect(right).toEqual({ top: 24, left: 323, width: 313, height: 530 })
    // 两个包裹层在水平方向上不重叠（右边缘 <= 另一个左边缘）。
    expect(left.left + left.width).toBeLessThanOrEqual(right.left)
  })

  it('插槽尺寸为 0（尚未布局）时原样传递 0，不做任何隐式兜底', () => {
    const slot = { top: 10, left: 10, width: 0, height: 0 }
    const container = { top: 0, left: 0, width: 0, height: 0 }
    expect(slotToWrapperStyle(slot, container)).toEqual({ top: 10, left: 10, width: 0, height: 0 })
  })

  it('几何变化时重算结果随之变化（模拟分隔条拖拽/窗口缩放触发的重新测量）', () => {
    const container = { top: 0, left: 0, width: 600, height: 400 }
    const before = slotToWrapperStyle({ top: 0, left: 0, width: 300, height: 400 }, container)
    const after = slotToWrapperStyle({ top: 0, left: 0, width: 420, height: 400 }, container) // 拖宽后
    expect(before.width).toBe(300)
    expect(after.width).toBe(420)
    expect(after).not.toEqual(before)
  })
})

describe('computeWrapperStyles', () => {
  it('批量换算：Map 里每个 paneId 各自按 slotToWrapperStyle 独立换算，互不影响', () => {
    const container = { top: 10, left: 10, width: 500, height: 300 }
    const rects = new Map([
      ['pane-a', { top: 10, left: 10, width: 240, height: 280 }],
      ['pane-b', { top: 10, left: 260, width: 240, height: 280 }],
    ])
    const result = computeWrapperStyles(rects, container)
    expect(result.size).toBe(2)
    expect(result.get('pane-a')).toEqual({ top: 0, left: 0, width: 240, height: 280 })
    expect(result.get('pane-b')).toEqual({ top: 0, left: 250, width: 240, height: 280 })
  })

  it('空 Map 输入得到空 Map 输出', () => {
    const result = computeWrapperStyles(new Map(), { top: 0, left: 0, width: 100, height: 100 })
    expect(result.size).toBe(0)
  })
})
