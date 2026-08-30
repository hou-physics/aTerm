import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function mockLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  const ls = {
    getItem: vi.fn((k: string) => (store.has(k) ? store.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => { store.set(k, v) }),
    removeItem: vi.fn((k: string) => { store.delete(k) }),
    clear: vi.fn(() => store.clear()),
  }
  vi.stubGlobal('localStorage', ls)
  return ls
}

beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.unstubAllGlobals() })

describe('library store — 别名搬家（最重要的一组）', () => {
  it('读得到总览页时代已经存下的名字（键名与键格式都不能变）', async () => {
    // 这条用例就是为了钉死 spec §3.1：存储键必须仍是 aterm.overview.names，
    // 键格式必须仍是 `${dirName}::${rootKey}`。任何一个改了，这里就会读到 undefined。
    mockLocalStorage({ 'aterm.overview.names': JSON.stringify({ '-tmp-a::r1': '旧名字' }) })
    const { useLibrary } = await import('../store/library')
    expect(useLibrary.getState().aliases['-tmp-a::r1']).toBe('旧名字')
  })

  it('写入仍然落在 aterm.overview.names 这个键上', async () => {
    const ls = mockLocalStorage()
    const { useLibrary } = await import('../store/library')
    useLibrary.getState().rename('-tmp-a::r1', '新名字')
    expect(ls.setItem).toHaveBeenCalledWith('aterm.overview.names', JSON.stringify({ '-tmp-a::r1': '新名字' }))
  })

  it('坏数据不炸：值不是对象时退回空表', async () => {
    mockLocalStorage({ 'aterm.overview.names': '"不是对象"' })
    const { useLibrary } = await import('../store/library')
    expect(useLibrary.getState().aliases).toEqual({})
  })
})

describe('library store — rename / clearAlias', () => {
  it('空白名字视为清除，不落盘空标题', async () => {
    mockLocalStorage({ 'aterm.overview.names': JSON.stringify({ '-tmp-a::r1': '旧' }) })
    const { useLibrary } = await import('../store/library')
    useLibrary.getState().rename('-tmp-a::r1', '   ')
    expect(useLibrary.getState().aliases['-tmp-a::r1']).toBe(undefined)
  })
  it('两侧空白被 trim 掉，不会带着空格落盘', async () => {
    const ls = mockLocalStorage()
    const { useLibrary } = await import('../store/library')
    useLibrary.getState().rename('-tmp-a::r1', '  我的任务  ')
    expect(useLibrary.getState().aliases['-tmp-a::r1']).toBe('我的任务')
    // 只断言内存态在原 overviewStore.test.ts 版本里就漏了一半覆盖：trim 有可能只在
    // 读出来的 getter 那一层做了，落盘的仍然带着两侧空格——那样每次重新加载都会
    // 带着这对空格渲染回来。这里补上落盘内容本身的断言。
    expect(ls.setItem).toHaveBeenCalledWith('aterm.overview.names', JSON.stringify({ '-tmp-a::r1': '我的任务' }))
  })
  it('clearAlias 删除该键', async () => {
    mockLocalStorage({ 'aterm.overview.names': JSON.stringify({ '-tmp-a::r1': '旧' }) })
    const { useLibrary } = await import('../store/library')
    useLibrary.getState().clearAlias('-tmp-a::r1')
    expect(useLibrary.getState().aliases['-tmp-a::r1']).toBe(undefined)
  })
})

describe('library store — 隐藏项目', () => {
  it('hide 之后 hiddenProjects 里有它，并持久化到新键', async () => {
    const ls = mockLocalStorage()
    const { useLibrary } = await import('../store/library')
    useLibrary.getState().hideProject('-tmp-a')
    expect(useLibrary.getState().hiddenProjects['-tmp-a']).toBe(true)
    expect(ls.setItem).toHaveBeenCalledWith('aterm.library.hiddenProjects', JSON.stringify({ '-tmp-a': true }))
  })
  it('unhide 往返：隐藏再取消，回到空表', async () => {
    mockLocalStorage()
    const { useLibrary } = await import('../store/library')
    useLibrary.getState().hideProject('-tmp-a')
    useLibrary.getState().unhideProject('-tmp-a')
    expect(useLibrary.getState().hiddenProjects).toEqual({})
  })
  it('读得到已持久化的隐藏名单', async () => {
    mockLocalStorage({ 'aterm.library.hiddenProjects': JSON.stringify({ '-tmp-a': true }) })
    const { useLibrary } = await import('../store/library')
    expect(useLibrary.getState().hiddenProjects['-tmp-a']).toBe(true)
  })
})

describe('library store — 移除会话', () => {
  it('removeSession 记下当前时刻', async () => {
    mockLocalStorage()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_700_000_000_000))
    const { useLibrary } = await import('../store/library')
    useLibrary.getState().removeSession('-tmp-a::r1')
    expect(useLibrary.getState().removedSessions['-tmp-a::r1']).toBe(1_700_000_000_000)
    vi.useRealTimers()
  })
  it('restoreSession 删除该记录', async () => {
    mockLocalStorage({ 'aterm.library.removedSessions': JSON.stringify({ '-tmp-a::r1': 123 }) })
    const { useLibrary } = await import('../store/library')
    useLibrary.getState().restoreSession('-tmp-a::r1')
    expect(useLibrary.getState().removedSessions['-tmp-a::r1']).toBe(undefined)
  })
})
