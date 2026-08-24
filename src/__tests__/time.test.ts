import { describe, expect, it } from 'vitest'
import { formatRelative, basename } from '../time'
import { b64ToBytes } from '../b64'

const NOW = Date.parse('2026-08-24T12:00:00Z')
describe('formatRelative', () => {
  it('分档正确', () => {
    expect(formatRelative(NOW - 30_000, NOW)).toBe('刚刚')
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(formatRelative(NOW - 3 * 3600_000, NOW)).toBe('3 小时前')
    expect(formatRelative(NOW - 26 * 3600_000, NOW)).toBe('昨天')
    expect(formatRelative(NOW - 4 * 86400_000, NOW)).toBe('4 天前')
    expect(formatRelative(NOW - 40 * 86400_000, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
describe('b64ToBytes', () => {
  it('解码', () => { expect(new TextDecoder().decode(b64ToBytes('aGk='))).toBe('hi') })
})
describe('basename', () => {
  it('取最后一段', () => { expect(basename('/Users/x/aTerm')).toBe('aTerm') })
})
