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

  // 这条防的是「注册时算一次然后缓存」这类重构：拖出发生在注册之后很久，届时若拿到的
  // 是注册那一刻的快照，交接过去的就是终端刚创建时的空内容——功能静默失效，而上面三条
  // 断言全都照样通过。
  it('每次调用都重新执行注册进来的函数，不缓存首次结果', () => {
    let n = 0
    registerSerializer('pty-fresh', () => `content-${++n}`)

    expect(serializeTerm('pty-fresh')).toBe('content-1')
    expect(serializeTerm('pty-fresh')).toBe('content-2')
  })

  it('注销后：serializeTerm 返回 null', () => {
    const unregister = registerSerializer('pty-2', () => 'should-not-see-this')

    unregister()
    const result = serializeTerm('pty-2')

    expect(result).toBe(null)
  })
})
