import { describe, expect, it } from 'vitest'
import { shouldTearOut } from '../tabTearOut'

const RECT = { width: 1200, height: 780 }

describe('shouldTearOut', () => {
  it('落点在窗口内：不拖出', () => {
    expect(shouldTearOut({ x: 600, y: 400 }, RECT, 3)).toBe(false)
  })
  it('落点在窗口左侧之外：拖出', () => {
    expect(shouldTearOut({ x: -30, y: 400 }, RECT, 3)).toBe(true)
  })
  it('落点在窗口下方之外：拖出', () => {
    expect(shouldTearOut({ x: 600, y: 900 }, RECT, 3)).toBe(true)
  })
  it('只剩一个标签时永不拖出（等于把窗口整体搬走，没有意义）', () => {
    expect(shouldTearOut({ x: -30, y: 400 }, RECT, 1)).toBe(false)
  })
  it('边界上算窗口内', () => {
    expect(shouldTearOut({ x: 0, y: 0 }, RECT, 3)).toBe(false)
    expect(shouldTearOut({ x: 1200, y: 780 }, RECT, 3)).toBe(false)
  })
})
