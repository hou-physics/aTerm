import { describe, expect, it } from 'vitest'
import { registerSerializer, serializeTerm } from '../termSerialize'

describe('termSerialize', () => {
  it('已注册的 ptyId：serializeTerm 返回注册的序列化结果，且与未注册时的返回值不同', () => {
    registerSerializer('pty-1', () => 'serialized-content')

    const result = serializeTerm('pty-1')

    expect(result).toBe('serialized-content')
    expect(result).not.toBe(serializeTerm('pty-never-registered'))
  })

  it('未注册的 ptyId：serializeTerm 返回 null', () => {
    const result = serializeTerm('pty-never-registered-2')

    expect(result).toBe(null)
  })

  it('注销后：serializeTerm 返回 null', () => {
    const unregister = registerSerializer('pty-2', () => 'should-not-see-this')

    unregister()
    const result = serializeTerm('pty-2')

    expect(result).toBe(null)
  })
})
