// 交接锁本身（src/handoffLock.ts）。它在 windowHandoff / store/tabs / windowClose 三处
// 被读写，那三处各自的集成用例在各自的测试文件里；这里只钉住这个原语自己的语义——尤其
// 是「释放」：锁没释放意味着那个标签**永久关不掉**（closeTab 会一直早退），比它挡的
// 问题更糟（V3.3 Ruling 12 的硬要求）。
import { beforeEach, describe, expect, it } from 'vitest'
import {
  abortSelfDestruct,
  beginHandoff,
  beginSelfDestruct,
  endHandoff,
  isHandoffInFlight,
  isSelfDestructing,
} from '../handoffLock'

// 模块级 Set 跨用例保留，每条用例用完自己清干净（也顺便就是 endHandoff 的一次调用）。
beforeEach(() => {
  for (const id of ['tab-1', 'tab-2']) endHandoff(id)
  abortSelfDestruct()
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

// 「本窗口已经决定自毁」那面旗（V3.4 修复轮 R2 / M1）。它挡的是 destroy 那次 IPC 的往返
// 空档：命令已经发出、Rust 还没真的销毁窗口，这期间落进来的交接载荷若被接管，会随窗口
// 一起消失，而 destroy 绕过 CloseRequested、不杀 PTY——会话成孤儿，标签两个窗口都没有。
// 这里只钉这个原语自己的语义；「拒收」那条集成行为在 windowHandoff.test.ts 里。
describe('selfDestruct 旗（自毁期间拒收交接）', () => {
  it('默认是放下的：没决定自毁的窗口照常接管', () => {
    expect(isSelfDestructing()).toBe(false)
  })

  it('置位之后为真', () => {
    // 初始值与目标值刻意不同（上一条已断言默认为 false），不是恒真断言。
    beginSelfDestruct()
    expect(isSelfDestructing()).toBe(true)
  })

  it('撤销之后回到假：destroy 失败时窗口还活着，必须能重新接管', () => {
    beginSelfDestruct()
    expect(isSelfDestructing()).toBe(true)
    abortSelfDestruct()
    expect(isSelfDestructing()).toBe(false)
  })

  it('与交接锁互不干扰：它是窗口级的，锁是标签级的', () => {
    beginSelfDestruct()
    expect(beginHandoff('tab-1')).toBe(true) // 自毁标记不该顺带锁住任何标签
    endHandoff('tab-1')
    expect(isSelfDestructing()).toBe(true) // 放锁也不该顺带把旗子放下
  })
})
