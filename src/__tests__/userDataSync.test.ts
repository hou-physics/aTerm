import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, listenTargets, listenMock, emitMock } = vi.hoisted(() => {
  const handlers: Record<string, (event: unknown) => unknown> = {}
  const listenTargets: Record<string, unknown> = {}
  const listenMock = vi.fn(async (event: string, handler: (event: unknown) => unknown, options?: unknown) => {
    handlers[event] = handler
    listenTargets[event] = options
    return () => {}
  })
  const emitMock = vi.fn(async () => undefined)
  return { handlers, listenTargets, listenMock, emitMock }
})

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock, emit: emitMock }))

// 本窗口的 label。**刻意不用 'main'**（Ruling 14 那类恒真陷阱，themeSync.test.ts 同）：
// 'main' 既是 windowLabel 在 jsdom 里的兜底值、又是下面若干断言里"别的窗口"的自然写法，
// 两者相同会让"广播载荷里的 fromLabel 取自本窗口"这条断言恒真——把实现改成写死 'main'
// 照样全绿，而那会让**每个**窗口都把别人的广播当成自己的回声丢掉，同步彻底失效且毫无信号。
const THIS_WINDOW = 'term-9'
const OTHER_WINDOW = 'main'
vi.mock('../windowLabel', () => ({ currentWindowLabel: vi.fn(async () => 'term-9') }))

const ALIASES_KEY = 'aterm.overview.names'
const HIDDEN_KEY = 'aterm.library.hiddenProjects'
const REMOVED_KEY = 'aterm.library.removedSessions'
const POSITIONS_KEY = 'aterm.overview.positions'

/** 真实的 localStorage 替身（有真正的读写语义），用来断言**落盘内容本身**而不是
 *  "setItem 被调用过"。 */
function mockLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  return { read: (k: string) => store.get(k) }
}

/** 让 broadcastUserData 里那一次 `await currentWindowLabel()` 有机会跑完——少 flush 会让
 *  "没有广播"这条断言变成"广播还没来得及发生"，即恒真。 */
async function flushMicrotasks() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

/** 每条用例都从干净的模块图开始：store 在模块加载时读一次 localStorage，所以必须先
 *  把替身装好、再 import。 */
async function freshModules(initial: Record<string, string> = {}) {
  vi.resetModules()
  const ls = mockLocalStorage(initial)
  const sync = await import('../userDataSync')
  const { useLibrary } = await import('../store/library')
  const { useOverviewStore } = await import('../store/overview')
  await sync.userDataSyncReady
  emitMock.mockClear()
  return { ...sync, useLibrary, useOverviewStore, ls }
}

function remotePayload(key: string, value: unknown, fromLabel: string = OTHER_WINDOW) {
  return { fromLabel, key, value }
}

beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.unstubAllGlobals() })

describe('userDataSync：注册', () => {
  it('模块加载时已向 user-data-changed 注册监听（在任何用户交互之前）', async () => {
    const { handleUserDataChanged, USER_DATA_CHANGED_EVENT } = await freshModules()
    expect(handlers[USER_DATA_CHANGED_EVENT]).toBe(handleUserDataChanged)
  })

  it('这条监听刻意不限定 target——它的收件人是所有其它窗口', async () => {
    const { USER_DATA_CHANGED_EVENT } = await freshModules()
    expect(listenTargets[USER_DATA_CHANGED_EVENT]).toBeUndefined()
  })
})

describe('userDataSync：本窗口改动 → 广播出去', () => {
  it('改名后广播，载荷带本窗口 label、历史键名与改后的整张表', async () => {
    const { useLibrary, USER_DATA_CHANGED_EVENT } = await freshModules({
      [ALIASES_KEY]: JSON.stringify({ '-tmp-a::r1': '旧名字' }),
    })

    useLibrary.getState().rename('-tmp-a::r2', '新名字')
    await flushMicrotasks()

    expect(emitMock).toHaveBeenCalledWith(USER_DATA_CHANGED_EVENT, {
      fromLabel: THIS_WINDOW,
      key: ALIASES_KEY,
      value: { '-tmp-a::r1': '旧名字', '-tmp-a::r2': '新名字' },
    })
  })

  it('隐藏项目 / 移除会话 / 取消隐藏 各自广播到自己那个键上', async () => {
    const { useLibrary, USER_DATA_CHANGED_EVENT } = await freshModules()

    useLibrary.getState().hideProject('-tmp-a')
    useLibrary.getState().removeSession('-tmp-a::r1')
    await flushMicrotasks()

    expect(emitMock).toHaveBeenCalledWith(USER_DATA_CHANGED_EVENT, expect.objectContaining({
      key: HIDDEN_KEY,
      value: { '-tmp-a': true },
    }))
    expect(emitMock).toHaveBeenCalledWith(USER_DATA_CHANGED_EVENT, expect.objectContaining({
      key: REMOVED_KEY,
      value: { '-tmp-a::r1': expect.any(Number) },
    }))
  })

  it('方块落手（commitPosition）广播位置表', async () => {
    const { useOverviewStore, USER_DATA_CHANGED_EVENT } = await freshModules()

    useOverviewStore.getState().commitPosition('-tmp-a::r1', { x: 12, y: 34 })
    await flushMicrotasks()

    expect(emitMock).toHaveBeenCalledWith(USER_DATA_CHANGED_EVENT, expect.objectContaining({
      key: POSITIONS_KEY,
      value: { '-tmp-a::r1': { x: 12, y: 34 } },
    }))
  })

  it('拖拽过程中的 setPosition **不**广播（只改内存、不落盘的那一半）', async () => {
    // 一次拖拽是每帧一次 setPosition；若把广播挂在 store 订阅上而不是 persist 上，
    // 这里会发出几十上百条事件，每条都让别的窗口重写一次 localStorage。
    const { useOverviewStore } = await freshModules()

    for (let i = 0; i < 20; i += 1) useOverviewStore.getState().setPosition('-tmp-a::r1', { x: i, y: i })
    await flushMicrotasks()

    expect(emitMock).not.toHaveBeenCalled()
    expect(useOverviewStore.getState().positions['-tmp-a::r1']).toEqual({ x: 19, y: 19 }) // 内存态确实动了
  })
})

describe('userDataSync：收到别的窗口的广播 → 整份替换', () => {
  it('别名表被换成远端那份，store 与 localStorage 都是新值', async () => {
    // 起点与目标刻意不同（少一个 B），否则是恒真断言。
    const { useLibrary, ls } = await freshModules({
      [ALIASES_KEY]: JSON.stringify({ '-tmp-a::r1': 'x' }),
    })
    expect(useLibrary.getState().aliases['-tmp-a::r2']).toBe(undefined) // 起点

    await handlers['user-data-changed']({
      payload: remotePayload(ALIASES_KEY, { '-tmp-a::r1': 'x', '-tmp-a::r2': 'y' }),
    })

    expect(useLibrary.getState().aliases).toEqual({ '-tmp-a::r1': 'x', '-tmp-a::r2': 'y' })
    expect(ls.read(ALIASES_KEY)).toBe(JSON.stringify({ '-tmp-a::r1': 'x', '-tmp-a::r2': 'y' }))
  })

  it('隐藏项目表被换成远端那份', async () => {
    const { useLibrary } = await freshModules({ [HIDDEN_KEY]: JSON.stringify({ '-tmp-a': true }) })

    await handlers['user-data-changed']({ payload: remotePayload(HIDDEN_KEY, { '-tmp-b': true }) })

    // 整份替换：'-tmp-a' 应当消失（远端已经取消隐藏了），而不是与本地合并后复活。
    expect(useLibrary.getState().hiddenProjects).toEqual({ '-tmp-b': true })
  })

  it('移除会话表被换成远端那份', async () => {
    const { useLibrary } = await freshModules({ [REMOVED_KEY]: JSON.stringify({ '-tmp-a::r1': 1 }) })

    await handlers['user-data-changed']({ payload: remotePayload(REMOVED_KEY, { '-tmp-a::r2': 222 }) })

    expect(useLibrary.getState().removedSessions).toEqual({ '-tmp-a::r2': 222 })
  })

  it('方块位置表被换成远端那份', async () => {
    // 本地多一个 r9，远端那张表里没有它：整份替换应当让 r9 消失。若实现成逐条合并，
    // "在别的窗口被删掉的方块位置"会在这个窗口复活——同一张表里既有替换又有残留。
    const { useOverviewStore } = await freshModules({
      [POSITIONS_KEY]: JSON.stringify({ '-tmp-a::r1': { x: 1, y: 1 }, '-tmp-a::r9': { x: 5, y: 5 } }),
    })

    await handlers['user-data-changed']({
      payload: remotePayload(POSITIONS_KEY, { '-tmp-a::r1': { x: 90, y: 91 } }),
    })

    expect(useOverviewStore.getState().positions).toEqual({ '-tmp-a::r1': { x: 90, y: 91 } })
  })

  it('**重新应用之后绝不再广播**（否则两个窗口互相弹球）', async () => {
    // 本模块的唯一硬不变式。没有 applyingRemoteChange 闸门时：A 改名 → 广播 → B 应用
    // → B 落盘 → B 也广播 → A 应用 → A 落盘 → A 再广播 ……，每一轮都是一次真实的
    // localStorage 写。注意远端载荷与本窗口当前状态**确实不同**，所以 persist 一定会
    // 被调到、钩子一定会触发——闸门是唯一挡住这次广播的东西。
    const { useLibrary } = await freshModules({ [ALIASES_KEY]: JSON.stringify({ '-tmp-a::r1': 'x' }) })

    await handlers['user-data-changed']({
      payload: remotePayload(ALIASES_KEY, { '-tmp-a::r1': 'x', '-tmp-a::r2': 'y' }),
    })
    await flushMicrotasks()

    expect(useLibrary.getState().aliases['-tmp-a::r2']).toBe('y') // 先确认这次应用确实生效了
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('applyRemoteUserData 直接调用时同样不广播', async () => {
    // 闸门本体的用例：不经过事件系统、不经过 fromLabel 判断，单独验证"应用 + 不广播"
    // 这一对。上一条同时受 fromLabel 早退保护，单靠它无法区分是哪一道闸门在起作用。
    const { applyRemoteUserData, useLibrary } = await freshModules()

    applyRemoteUserData(remotePayload(ALIASES_KEY, { '-tmp-a::r1': 'z' }))
    await flushMicrotasks()

    expect(useLibrary.getState().aliases).toEqual({ '-tmp-a::r1': 'z' })
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('闸门只覆盖这一次应用，之后本窗口自己的改动照常广播', async () => {
    // 会因为什么失败：如果 applyingRemoteChange 只置位不复位（例如把 finally 删掉），
    // 这个窗口此后**永远**不再把自己的改动告诉别人——静默、不可恢复、只在多窗口下
    // 才能观察到。
    const { useLibrary, USER_DATA_CHANGED_EVENT } = await freshModules()

    await handlers['user-data-changed']({ payload: remotePayload(ALIASES_KEY, { '-tmp-a::r1': 'z' }) })
    await flushMicrotasks()
    emitMock.mockClear()

    useLibrary.getState().hideProject('-tmp-b')
    await flushMicrotasks()

    expect(emitMock).toHaveBeenCalledWith(USER_DATA_CHANGED_EVENT, expect.objectContaining({
      fromLabel: THIS_WINDOW,
      key: HIDDEN_KEY,
    }))
  })
})

describe('userDataSync：自己发的回声不处理', () => {
  it('fromLabel 是本窗口时早退，不重新应用', async () => {
    // JS 的 emit 会把事件也投递回发送窗口自己。不早退的话每次改名都会多一次整表重写。
    const { useLibrary } = await freshModules({ [ALIASES_KEY]: JSON.stringify({ '-tmp-a::r1': 'x' }) })

    await handlers['user-data-changed']({
      payload: remotePayload(ALIASES_KEY, { '-tmp-a::r1': 'x', '-tmp-a::r2': 'y' }, THIS_WINDOW),
    })

    // 起点没有 r2；早退没生效的话这里会变成 'y'。
    expect(useLibrary.getState().aliases['-tmp-a::r2']).toBe(undefined)
  })

  it('载荷缺 fromLabel（或 key 不是字符串）时什么都不做', async () => {
    const { useLibrary } = await freshModules()

    await handlers['user-data-changed']({ payload: { key: ALIASES_KEY, value: { a: 'y' } } })
    await handlers['user-data-changed']({ payload: { fromLabel: OTHER_WINDOW, value: { a: 'y' } } })

    expect(useLibrary.getState().aliases).toEqual({})
  })
})

describe('userDataSync：远端载荷同样要校验', () => {
  it('value 不是一张表（字符串 / 数组 / null）时保持原状', async () => {
    const { useLibrary } = await freshModules({ [ALIASES_KEY]: JSON.stringify({ '-tmp-a::r1': 'x' }) })

    await handlers['user-data-changed']({ payload: remotePayload(ALIASES_KEY, '不是对象') })
    await handlers['user-data-changed']({ payload: remotePayload(ALIASES_KEY, ['也不是']) })
    await handlers['user-data-changed']({ payload: remotePayload(ALIASES_KEY, null) })

    expect(useLibrary.getState().aliases).toEqual({ '-tmp-a::r1': 'x' })
  })

  it('表里类型不对的条目被逐条剔除，好的条目照常落地', async () => {
    // 一条坏记录不该让整次同步失效，否则一个畸形条目就能让两个窗口从此永久不一致。
    const { useLibrary, useOverviewStore } = await freshModules()

    await handlers['user-data-changed']({
      payload: remotePayload(ALIASES_KEY, { good: '名字', bad: 42 }),
    })
    await handlers['user-data-changed']({
      payload: remotePayload(POSITIONS_KEY, { good: { x: 1, y: 2 }, bad: { x: 'NaN', y: 2 } }),
    })

    expect(useLibrary.getState().aliases).toEqual({ good: '名字' })
    expect(useOverviewStore.getState().positions).toEqual({ good: { x: 1, y: 2 } })
  })

  it('认不出的键被忽略，不抛错也不动任何一张表', async () => {
    const { useLibrary } = await freshModules({ [ALIASES_KEY]: JSON.stringify({ '-tmp-a::r1': 'x' }) })

    await handlers['user-data-changed']({ payload: remotePayload('aterm.something.else', { a: 'y' }) })

    expect(useLibrary.getState().aliases).toEqual({ '-tmp-a::r1': 'x' })
  })
})

// 终审 Ruling 20 的原始复现路径，端到端形态。这条是整组用例里最有说服力的一条：
// 它断言的正是"用户已保存的改名不再凭空消失"。
describe('userDataSync：终审 Ruling 20 的复现路径', () => {
  it('另一个窗口的改名先到达，本窗口随后再改名时不会把它整份覆盖掉', async () => {
    // 1. 主窗口开着，aliases = {A:'x'}
    const { useLibrary, ls } = await freshModules({ [ALIASES_KEY]: JSON.stringify({ A: 'x' }) })

    // 2~3. 拖出的窗口给会话 B 改名，广播过来
    await handlers['user-data-changed']({ payload: remotePayload(ALIASES_KEY, { A: 'x', B: 'y' }) })

    // 4. 回本窗口给会话 C 改名
    useLibrary.getState().rename('C', 'z')
    await flushMicrotasks()

    // 修复前：本窗口按自己陈旧的内存写入 {A:'x', C:'z'}，**B 的改名凭空消失**。
    expect(useLibrary.getState().aliases).toEqual({ A: 'x', B: 'y', C: 'z' })
    expect(ls.read(ALIASES_KEY)).toBe(JSON.stringify({ A: 'x', B: 'y', C: 'z' }))
  })
})
