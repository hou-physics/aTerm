import { describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-9'),
  ptyIsAlive: vi.fn(async () => true),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))

import { newConversationSpec, randomUuidV4 } from '../actions'

describe('newConversationSpec', () => {
  it('注入命令里的 session id 与返回的 sessionId 是同一个', () => {
    const spec = newConversationSpec('/tmp/proj')
    expect(spec.inject).toBe(`claude --session-id ${spec.sessionId}`)
  })

  it('生成的是合法 uuid（Rust 侧 is_uuid_stem 会按这个形状校验文件名）', () => {
    const { sessionId } = newConversationSpec('/tmp/proj')
    // is_uuid_stem: 36 字符、4 个短横线、其余全为十六进制
    expect(sessionId.length).toBe(36)
    expect(sessionId.split('-').length - 1).toBe(4)
    expect(/^[0-9a-f-]+$/.test(sessionId)).toBe(true)
  })

  it('每次调用给出不同的 sessionId——同项目并发开两个新对话不能撞车', () => {
    const a = newConversationSpec('/tmp/proj')
    const b = newConversationSpec('/tmp/proj')
    expect(a.sessionId === b.sessionId).toBe(false)
  })

  it('cwd 原样透传，标题固定为「新对话」', () => {
    const spec = newConversationSpec('/tmp/proj')
    expect(spec.cwd).toBe('/tmp/proj')
    expect(spec.title).toBe('新对话')
  })
})

// crypto.randomUUID() 在打包版的 macOS wkwebview 里可能是 undefined（见 actions.ts
// 里 randomUuidV4 头顶的注释）——vitest 跑在 jsdom + Node 的 crypto 上，
// randomUUID 总是存在，所以上面几条用例天然只走得到"有 randomUUID"这条路径，
// 从来验证不到回退分支。这里把 crypto.randomUUID 临时置为 undefined，专门锁住
// 回退路径本身：那条分支本来就不会被前面的用例意外覆盖到。
describe('randomUuidV4 的回退路径（crypto.randomUUID 缺失时）', () => {
  const withoutRandomUUID = (fn: () => void) => {
    const original = crypto.randomUUID
    // @ts-expect-error 模拟非安全上下文：这个方法根本不存在
    crypto.randomUUID = undefined
    try {
      fn()
    } finally {
      crypto.randomUUID = original
    }
  }

  it('crypto.randomUUID 缺失时，仍能生成满足 is_uuid_stem 形状的 uuid', () => {
    withoutRandomUUID(() => {
      const id = randomUuidV4()
      // 与上面 newConversationSpec 那条用例同一组断言：36 字符、4 个短横线、
      // 其余全为十六进制。
      expect(id.length).toBe(36)
      expect(id.split('-').length - 1).toBe(4)
      expect(/^[0-9a-f-]+$/.test(id)).toBe(true)
    })
  })

  it('版本位固定为 4，变体位落在 8/9/a/b 之中（RFC 4122 v4）', () => {
    withoutRandomUUID(() => {
      for (let i = 0; i < 20; i++) {
        const id = randomUuidV4()
        const [, , third, fourth] = id.split('-')
        expect(third[0]).toBe('4')
        expect(['8', '9', 'a', 'b']).toContain(fourth[0])
      }
    })
  })

  it('回退路径下多次调用不重复', () => {
    withoutRandomUUID(() => {
      const seen = new Set(Array.from({ length: 50 }, () => randomUuidV4()))
      expect(seen.size).toBe(50)
    })
  })

  it('newConversationSpec 在回退路径下依然可用（不抛异常，注入命令携带同一个 id）', () => {
    withoutRandomUUID(() => {
      const spec = newConversationSpec('/tmp/proj')
      expect(spec.inject).toBe(`claude --session-id ${spec.sessionId}`)
      expect(spec.sessionId.length).toBe(36)
    })
  })
})
