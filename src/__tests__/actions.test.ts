import { describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-9'),
  ptyIsAlive: vi.fn(async () => true),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))

import { newConversationSpec } from '../actions'

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
