import { describe, expect, it } from 'vitest'
import { wheelDeltaToLines } from '../wheel'

describe('wheelDeltaToLines', () => {
  it('像素模式按 cellH 换算并放大 multiplier 倍', () => {
    // 17px 一行，滚动 34px -> 2 行，乘 3 倍 -> 6 行
    const r = wheelDeltaToLines(34, 0, 24, 17, 3, 0)
    expect(r.lines).toBe(6)
    expect(r.remainder).toBeCloseTo(0)
  })

  it('行模式直接使用 deltaY', () => {
    const r = wheelDeltaToLines(2, 1, 24, 17, 3, 0)
    expect(r.lines).toBe(6)
  })

  it('页模式按 rows 换算', () => {
    const r = wheelDeltaToLines(1, 2, 24, 17, 1, 0)
    expect(r.lines).toBe(24)
  })

  it('负值滚动方向为负', () => {
    const r = wheelDeltaToLines(-34, 0, 24, 17, 3, 0)
    expect(r.lines).toBe(-6)
  })

  it('小于一行的余量会累积到下一次调用', () => {
    // 每次只有 0.5 行，两次之后应产出 1 行且余量清零
    const first = wheelDeltaToLines(1, 1, 24, 17, 0.5, 0)
    expect(first.lines).toBe(0)
    expect(first.remainder).toBeCloseTo(0.5)
    const second = wheelDeltaToLines(1, 1, 24, 17, 0.5, first.remainder)
    expect(second.lines).toBe(1)
    expect(second.remainder).toBeCloseTo(0)
  })
})
