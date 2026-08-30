import { describe, expect, it } from 'vitest'
import { displayTitle, groupRecentByDate, isSessionRemoved } from '../sessionList'

describe('displayTitle', () => {
  it('有别名时优先用别名', () => {
    const aliases = { '-tmp-a::r1': '我的任务' }
    expect(displayTitle({ rootKey: 'r1', title: '修登录', titled: true }, '-tmp-a', aliases)).toBe('我的任务')
  })
  it('无别名时用真实标题', () => {
    expect(displayTitle({ rootKey: 'r1', title: '修登录', titled: true }, '-tmp-a', {})).toBe('修登录')
  })
  it('titled 为 false 时给「新对话」，绝不显示 uuid 前 8 位', () => {
    // 后端在没有真实标题时把 title 填成 session_id 前 8 位；直接渲染会让列表出现一串十六进制
    expect(displayTitle({ rootKey: 'r1', title: 'ebd067d4', titled: false }, '-tmp-a', {})).toBe('新对话')
  })
  it('别名优先级高于「新对话」——用户给未命名会话起了名就该显示那个名', () => {
    const aliases = { '-tmp-a::r1': '临时试验' }
    expect(displayTitle({ rootKey: 'r1', title: 'ebd067d4', titled: false }, '-tmp-a', aliases)).toBe('临时试验')
  })
  it('别名按「项目::会话」复合键取，不会跨项目误命中', () => {
    const aliases = { '-tmp-b::r1': 'B 的名字' }
    expect(displayTitle({ rootKey: 'r1', title: '修登录', titled: true }, '-tmp-a', aliases)).toBe('修登录')
  })
})

describe('isSessionRemoved', () => {
  it('从未移除过 → 不隐去', () => {
    expect(isSessionRemoved(undefined, 100)).toBe(false)
  })
  it('移除后没有新活动 → 隐去', () => {
    expect(isSessionRemoved(200, 100)).toBe(true)
  })
  it('移除后又有新活动 → 自动回归（这正是「下次再用它就出现」）', () => {
    expect(isSessionRemoved(200, 300)).toBe(false)
  })
  it('边界：活动时间正好等于移除时刻 → 仍隐去（同一时刻不算「又用了一次」）', () => {
    expect(isSessionRemoved(200, 200)).toBe(true)
  })
})

describe('groupRecentByDate', () => {
  // 2026-08-30 12:00 本地时间
  const now = new Date(2026, 7, 30, 12, 0, 0).getTime()
  const at = (d: number, h: number) => new Date(2026, 7, d, h, 0, 0).getTime()

  it('分成今天/昨天/更早三组，顺序固定', () => {
    const items = [
      { lastActivityMs: at(30, 9) },   // 今天
      { lastActivityMs: at(29, 9) },   // 昨天
      { lastActivityMs: at(20, 9) },   // 更早
    ]
    const g = groupRecentByDate(items, now)
    expect(g.map((x) => x.label)).toEqual(['今天', '昨天', '更早'])
    expect(g[0].items.length).toBe(1)
    expect(g[1].items.length).toBe(1)
    expect(g[2].items.length).toBe(1)
  })
  it('空组不产出——没有「昨天」的会话时不该出现一个空的「昨天」标题', () => {
    const g = groupRecentByDate([{ lastActivityMs: at(30, 9) }], now)
    expect(g.map((x) => x.label)).toEqual(['今天'])
  })
  it('午夜边界：今天 00:01 属于今天，昨天 23:59 属于昨天', () => {
    const g = groupRecentByDate(
      [{ lastActivityMs: at(30, 0) + 60_000 }, { lastActivityMs: at(29, 23) + 59 * 60_000 }],
      now,
    )
    expect(g.map((x) => x.label)).toEqual(['今天', '昨天'])
  })
  it('保持传入顺序，不重新排序（调用方已按活跃时间排好）', () => {
    const a = { lastActivityMs: at(30, 9) }
    const b = { lastActivityMs: at(30, 11) }
    const g = groupRecentByDate([a, b], now)
    expect(g[0].items[0]).toBe(a)
    expect(g[0].items[1]).toBe(b)
  })
  it('空输入返回空数组', () => {
    expect(groupRecentByDate([], now)).toEqual([])
  })
})
