import { describe, expect, it } from 'vitest'
import { dateKey, firstLineSummary, formatDateLabel, formatTimeHM, groupUserTurnsByDate } from '../conversation'
import type { Turn } from '../ipc'

function turn(role: 'user' | 'assistant', tsMs: number, text: string, uuid: string): Turn {
  return { role, tsMs, text, uuid }
}

describe('formatDateLabel / dateKey / formatTimeHM', () => {
  it('formatDateLabel 生成「M月D日」', () => {
    expect(formatDateLabel(new Date(2026, 7, 27, 14, 32).getTime())).toBe('8月27日')
    expect(formatDateLabel(new Date(2026, 0, 5, 9, 0).getTime())).toBe('1月5日')
  })
  it('dateKey 按年月日零填充，跨年不同键', () => {
    const a = dateKey(new Date(2025, 11, 31, 23, 59).getTime())
    const b = dateKey(new Date(2026, 0, 1, 0, 1).getTime())
    expect(a).toBe('2025-12-31')
    expect(b).toBe('2026-01-01')
    expect(a).not.toBe(b)
  })
  it('formatTimeHM 生成零填充的 HH:MM', () => {
    expect(formatTimeHM(new Date(2026, 7, 27, 9, 5).getTime())).toBe('09:05')
    expect(formatTimeHM(new Date(2026, 7, 27, 23, 59).getTime())).toBe('23:59')
  })
})

describe('groupUserTurnsByDate', () => {
  it('同一天多轮：归入一组，组内按时间新的在前', () => {
    const t1 = turn('user', new Date(2026, 7, 27, 12, 19).getTime(), '第一条', 'u1')
    const t2 = turn('user', new Date(2026, 7, 27, 14, 32).getTime(), '第二条', 'u2')
    const groups = groupUserTurnsByDate([t1, t2])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('8月27日')
    expect(groups[0].turns.map((t) => t.uuid)).toEqual(['u2', 'u1'])
  })

  it('跨月：两组，日期新的在前', () => {
    const jul = turn('user', new Date(2026, 6, 30, 10, 0).getTime(), '七月的消息', 'u1')
    const aug = turn('user', new Date(2026, 7, 2, 10, 0).getTime(), '八月的消息', 'u2')
    const groups = groupUserTurnsByDate([jul, aug])
    expect(groups.map((g) => g.label)).toEqual(['8月2日', '7月30日'])
  })

  it('跨年：同月同日但不同年份不应合并', () => {
    const y2025 = turn('user', new Date(2025, 7, 27, 10, 0).getTime(), '去年', 'u1')
    const y2026 = turn('user', new Date(2026, 7, 27, 10, 0).getTime(), '今年', 'u2')
    const groups = groupUserTurnsByDate([y2025, y2026])
    expect(groups).toHaveLength(2)
    expect(groups[0].turns[0].uuid).toBe('u2') // 今年（新）在前
    expect(groups[1].turns[0].uuid).toBe('u1')
  })

  it('只统计 role === "user" 的轮次，assistant 轮次被忽略', () => {
    const u = turn('user', new Date(2026, 7, 27, 10, 0).getTime(), '用户', 'u1')
    const a = turn('assistant', new Date(2026, 7, 27, 10, 1).getTime(), '助手', 'a1')
    const groups = groupUserTurnsByDate([u, a])
    expect(groups).toHaveLength(1)
    expect(groups[0].turns).toHaveLength(1)
    expect(groups[0].turns[0].uuid).toBe('u1')
  })
})

describe('firstLineSummary', () => {
  it('短文本原样返回', () => {
    expect(firstLineSummary('修好这个 bug')).toBe('修好这个 bug')
  })
  it('只取第一行，忽略换行之后的内容', () => {
    expect(firstLineSummary('第一行\n第二行\n第三行')).toBe('第一行')
  })
  it('超过长度限制则截断并追加省略号', () => {
    const long = 'a'.repeat(50)
    const out = firstLineSummary(long, 10)
    expect(out).toBe(`${'a'.repeat(10)}…`)
  })
  it('首尾空白被裁剪', () => {
    expect(firstLineSummary('   带前后空格的文本   \n下一行')).toBe('带前后空格的文本')
  })
})
