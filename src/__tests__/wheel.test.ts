import { describe, expect, it } from 'vitest'
import { createWheelAmplifier, wheelDeltaToLines } from '../wheel'

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

describe('createWheelAmplifier', () => {
  it('重入守卫使一次真实事件恰好产生 multiplier-1 次真正补发，而非无限递归', () => {
    // 模拟 xterm 的行为：target 上挂的监听器对合成事件也会再次调用 amplify——
    // 若没有重入守卫，这会无限递归下去；有守卫时，嵌套调用应直接空转。
    const target = document.createElement('div')
    const multiplier = 4
    const amplify = createWheelAmplifier(multiplier)
    let invocationCount = 0
    target.addEventListener('wheel', (e) => {
      invocationCount++
      amplify(target, e as WheelEvent)
    })

    const original = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    target.dispatchEvent(original)

    // 监听器被调用次数 = 1 次真实事件 + (multiplier - 1) 次真正补发的合成事件；
    // 若守卫失效，嵌套调用会继续补发，次数会远大于此。
    expect(invocationCount).toBe(multiplier)
  })

  it('multiplier=1 时不补发任何合成事件', () => {
    const target = document.createElement('div')
    const amplify = createWheelAmplifier(1)
    let invocationCount = 0
    target.addEventListener('wheel', (e) => {
      invocationCount++
      amplify(target, e as WheelEvent)
    })
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
    expect(invocationCount).toBe(1)
  })
})
