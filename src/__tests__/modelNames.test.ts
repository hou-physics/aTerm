import { describe, expect, it } from 'vitest'
import { formatContextTokens, shortModelName } from '../modelNames'

describe('shortModelName', () => {
  it('把模型 id 缩写成人读的短名', () => {
    expect(shortModelName('claude-opus-5')).toBe('Opus 5')
    expect(shortModelName('claude-sonnet-5')).toBe('Sonnet 5')
    expect(shortModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(shortModelName('opus')).toBe('Opus')
  })
  it('认不出的 id 原样返回，不显示空白', () => {
    expect(shortModelName('some-future-model')).toBe('some-future-model')
  })
  it('缺失时返回 undefined，由调用方决定不渲染该徽章', () => {
    expect(shortModelName(null)).toBeUndefined()
    expect(shortModelName(undefined)).toBeUndefined()
  })
})

describe('formatContextTokens —— 显示绝对值，不显示百分比', () => {
  it('千位以上用 k', () => {
    expect(formatContextTokens(106_797)).toBe('107k')
    expect(formatContextTokens(1_500)).toBe('2k')
  })
  it('不足 1000 显示原值', () => {
    expect(formatContextTokens(840)).toBe('840')
  })
  it('缺失返回 undefined', () => {
    expect(formatContextTokens(null)).toBeUndefined()
  })
})
