// 交接锁本身（src/handoffLock.ts）。它在 windowHandoff / store/tabs / windowClose 三处
// 被读写，那三处各自的集成用例在各自的测试文件里；这里只钉住这个原语自己的语义——尤其
// 是「释放」：锁没释放意味着那个标签**永久关不掉**（closeTab 会一直早退），比它挡的
// 问题更糟（V3.3 Ruling 12 的硬要求）。
import { beforeEach, describe, expect, it } from 'vitest'
import { beginHandoff, endHandoff, isHandoffInFlight } from '../handoffLock'

// 模块级 Set 跨用例保留，每条用例用完自己清干净（也顺便就是 endHandoff 的一次调用）。
beforeEach(() => {
  for (const id of ['tab-1', 'tab-2']) endHandoff(id)
})

describe('handoffLock — 交接中的标签锁', () => {
  it('没上过锁的标签不在交接中', () => {
    expect(isHandoffInFlight('tab-1')).toBe(false)
  })

  it('上锁成功返回 true，并且该标签随即处于交接中', () => {
    expect(beginHandoff('tab-1')).toBe(true)
    expect(isHandoffInFlight('tab-1')).toBe(true)
  })

  it('已在交接中的标签再次上锁返回 false（M6：挡住并发的第二次拖出）', () => {
    beginHandoff('tab-1')
    expect(beginHandoff('tab-1')).toBe(false)
    // 被拒绝的那一次绝不能反过来影响正在进行的那一次——锁还在。
    expect(isHandoffInFlight('tab-1')).toBe(true)
  })

  it('释放之后不再处于交接中，且可以重新上锁', () => {
    beginHandoff('tab-1')
    endHandoff('tab-1')
    expect(isHandoffInFlight('tab-1')).toBe(false)
    expect(beginHandoff('tab-1')).toBe(true)
  })

  it('释放一个从没上过锁的标签是安全的空操作（因此 endHandoff 可以无条件放进 finally）', () => {
    expect(() => endHandoff('tab-2')).not.toThrow()
    expect(isHandoffInFlight('tab-2')).toBe(false)
  })

  it('锁按标签区分：锁住一个不会连带锁住另一个', () => {
    beginHandoff('tab-1')
    expect(isHandoffInFlight('tab-2')).toBe(false)
    expect(beginHandoff('tab-2')).toBe(true)
    endHandoff('tab-1')
    // 释放 tab-1 不该把 tab-2 一起放掉。
    expect(isHandoffInFlight('tab-2')).toBe(true)
  })
})
