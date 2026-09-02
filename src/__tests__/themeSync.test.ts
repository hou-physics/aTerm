import { beforeEach, describe, expect, it, vi } from 'vitest'

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
// 本窗口的 label。**刻意不用 'main'**（Ruling 14）：'main' 既是 windowLabel 在 jsdom
// 里的兜底值、又是下面若干断言里"别的窗口"的自然写法，两者相同会让"广播载荷里的
// fromLabel 取自本窗口"这条断言恒真——把实现改成写死 'main' 照样全绿，而那会让**每个**
// 窗口都把别人的广播当成自己的回声丢掉，跨窗口同步彻底失效且毫无信号。
const THIS_WINDOW = 'term-9'
const OTHER_WINDOW = 'main'
vi.mock('../windowLabel', () => ({ currentWindowLabel: vi.fn(async () => 'term-9') }))

import {
  applyRemoteThemeChange,
  handleThemeChanged,
  THEME_CHANGED_EVENT,
  themeSyncReady,
  type ThemeChangedPayload,
} from '../themeSync'
import { useTheme } from '../store/theme'

/** 两个已知且**外观相反**的主题 id，用来断言"CSS 变量真的变了"而不只是 store 变了。 */
const LIGHT_ID = 'catppuccin-latte'
const DARK_ID = 'tokyo-night'

/** 让 broadcastThemeChange 里那一次 `await currentWindowLabel()` 有机会跑完——
 *  少 flush 会让"没有广播"这条断言变成"广播还没来得及发生"，即恒真。 */
async function flushMicrotasks() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

function remotePayload(over: Partial<ThemeChangedPayload> = {}): ThemeChangedPayload {
  return {
    fromLabel: OTHER_WINDOW,
    mode: 'single',
    lightThemeId: LIGHT_ID,
    darkThemeId: DARK_ID,
    singleThemeId: DARK_ID,
    ...over,
  }
}

/** 把 store 置到一个已知起点：dual + 系统亮色 ⇒ activeTheme 是浅色的 LIGHT_ID。
 *  与下面各用例的目标值（single + DARK_ID）在 mode、主题 id、外观三个维度上都不同，
 *  避免"初始值恰好等于目标值"那类恒真断言。 */
async function resetStoreToKnownStart() {
  useTheme.setState({
    mode: 'dual',
    lightThemeId: LIGHT_ID,
    darkThemeId: DARK_ID,
    singleThemeId: LIGHT_ID,
    systemPrefersDark: false,
  })
  // setState 不会重算 activeTheme，也不会写 CSS 变量。走一次 setMode('dual')（传入与
  // 刚设好的 mode 相同的值）把 activeTheme 重新解析出来并 applyUiVars 一遍——这样每条
  // 用例的起点（store + document）都是自洽的，不会捡到上一条用例留下的 activeTheme。
  // 它不会额外发广播：四个同步字段一个都没变，订阅回调的守卫会过滤掉。
  useTheme.getState().setMode('dual')
  // 上面第一次 setState 确实动了同步字段、会触发一次广播；等它落地再清，否则它会漏进
  // 下一条用例的断言里。
  await flushMicrotasks()
  emitMock.mockClear()
}

beforeEach(async () => {
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-theme')
  await resetStoreToKnownStart()
})

describe('themeSync：注册', () => {
  it('模块加载时已向 theme-changed 注册监听（在任何用户交互之前）', async () => {
    await themeSyncReady
    expect(handlers[THEME_CHANGED_EVENT]).toBe(handleThemeChanged)
  })

  it('这条监听刻意不限定 target——它的收件人是所有其它窗口', async () => {
    // 与 closeRequest.ts / menuEvents.ts 正好相反：那两条是 emit_to 定向、必须限定
    // target；主题变更是真广播，限定了 target 反而收不到别人的。
    await themeSyncReady
    expect(listenTargets[THEME_CHANGED_EVENT]).toBeUndefined()
  })
})

describe('themeSync：本窗口改主题 → 广播出去', () => {
  it('setMode 之后广播 theme-changed，载荷带本窗口 label 与全部四个字段', async () => {
    await themeSyncReady

    useTheme.getState().setMode('single')
    await flushMicrotasks()

    expect(emitMock).toHaveBeenCalledWith(THEME_CHANGED_EVENT, {
      fromLabel: THIS_WINDOW,
      mode: 'single',
      lightThemeId: LIGHT_ID,
      darkThemeId: DARK_ID,
      singleThemeId: LIGHT_ID,
    })
  })

  it('改主题 id（不改 mode）同样广播', async () => {
    // 跨窗口要同步的是全部四个持久化字段，不只是 mode——只盯 mode 的话，用户在设置
    // 浮层里换一个具体主题，别的窗口纹丝不动。
    await themeSyncReady

    useTheme.getState().setDarkThemeId('dracula')
    await flushMicrotasks()

    expect(emitMock).toHaveBeenCalledWith(THEME_CHANGED_EVENT, expect.objectContaining({
      fromLabel: THIS_WINDOW,
      darkThemeId: 'dracula',
    }))
  })

  it('只有 activeTheme / systemPrefersDark 变化时不广播', async () => {
    // 系统切深色时**每个**窗口的 matchMedia 都会各自触发一次 setState；不过滤的话
    // N 个窗口会互相广播出 N² 条毫无信息量的事件（而且每条都会让别人再重绘一次）。
    await themeSyncReady
    const current = useTheme.getState().activeTheme

    useTheme.setState({ systemPrefersDark: true, activeTheme: { ...current, id: `${current.id}-x` } })
    await flushMicrotasks()

    expect(emitMock).not.toHaveBeenCalled()
  })
})

describe('themeSync：收到别的窗口的广播 → 重新应用', () => {
  it('store 的四个字段与 activeTheme 都被换成远端的值', async () => {
    await themeSyncReady
    expect(useTheme.getState().mode).toBe('dual') // 起点，与目标 'single' 不同
    expect(useTheme.getState().activeTheme.id).toBe(LIGHT_ID) // 起点是浅色

    await handleThemeChanged({ payload: remotePayload() } as never)

    const s = useTheme.getState()
    expect(s.mode).toBe('single')
    expect(s.singleThemeId).toBe(DARK_ID)
    expect(s.activeTheme.id).toBe(DARK_ID)
  })

  it('CSS 变量真的被写到了 document 上（不只是 store 变了）', async () => {
    // 断言真实状态而不是"某个 mock 被调用过"：主题的用户可见效果全部经由
    // applyUiVars 写在 documentElement 的内联样式上，store 变了但没重新 apply 的话
    // 用户看到的还是旧配色。
    await themeSyncReady
    const before = document.documentElement.style.getPropertyValue('--color-bg')

    await handleThemeChanged({ payload: remotePayload() } as never)

    const after = document.documentElement.style.getPropertyValue('--color-bg')
    expect(after).not.toBe('')
    expect(after).not.toBe(before)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('**重新应用之后绝不再广播**（否则两个窗口互相弹球）', async () => {
    // 本模块的唯一硬不变式。没有 applyingRemoteChange 闸门时：A 改主题 → 广播 →
    // B 应用 → B 的 store 变了 → B 也广播 → A 应用 → A 再广播 …… 主题闪烁不止。
    // 注意这条用例的远端载荷与本窗口当前状态**确实不同**（dual→single），所以 store
    // 一定会发生变化、订阅回调一定会被触发——闸门是唯一挡住这次广播的东西。
    await themeSyncReady

    await handleThemeChanged({ payload: remotePayload() } as never)
    await flushMicrotasks()

    expect(useTheme.getState().mode).toBe('single') // 先确认这次应用确实生效了
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('闸门只覆盖这一次应用，之后本窗口自己的改动照常广播', async () => {
    // 会因为什么失败：如果 applyingRemoteChange 只置位不复位（例如把 finally 删掉、
    // 或者写成"应用远端状态时永久静音"），这个窗口此后**永远**不再把自己的主题变更
    // 告诉别人——一个静默、不可恢复、只在多窗口下才能观察到的故障。
    await themeSyncReady
    await handleThemeChanged({ payload: remotePayload() } as never)
    await flushMicrotasks()
    emitMock.mockClear()

    useTheme.getState().setMode('default')
    await flushMicrotasks()

    expect(emitMock).toHaveBeenCalledWith(THEME_CHANGED_EVENT, expect.objectContaining({
      fromLabel: THIS_WINDOW,
      mode: 'default',
    }))
  })

  it('applyRemoteThemeChange 直接调用时同样不广播', async () => {
    // 闸门本体的用例：不经过事件系统、不经过 fromLabel 判断，单独验证"应用 + 不广播"
    // 这一对。handleThemeChanged 那条同时受 fromLabel 早退保护，单靠它无法区分
    // 到底是哪一道闸门在起作用。
    await themeSyncReady

    applyRemoteThemeChange(remotePayload())
    await flushMicrotasks()

    expect(useTheme.getState().mode).toBe('single')
    expect(emitMock).not.toHaveBeenCalled()
  })
})

describe('themeSync：自己发的回声不处理', () => {
  it('fromLabel 是本窗口时早退，不重新应用', async () => {
    // JS 的 emit 会把事件也投递回发送窗口自己。不早退的话每次改主题都会多一次全量
    // 重绘（applyUiVars 重写全部 CSS 变量），而且是在用户刚看到新配色之后立刻再刷一遍。
    await themeSyncReady

    await handleThemeChanged({ payload: remotePayload({ fromLabel: THIS_WINDOW }) } as never)

    // 起点是 dual，载荷里是 single；如果早退没生效，这里会变成 'single'。
    expect(useTheme.getState().mode).toBe('dual')
  })

  it('载荷缺 fromLabel 时什么都不做', async () => {
    await themeSyncReady

    await handleThemeChanged({ payload: { ...remotePayload(), fromLabel: undefined } } as never)

    expect(useTheme.getState().mode).toBe('dual')
  })
})

describe('themeSync：远端载荷同样要校验', () => {
  it('非法 mode 不会落进 store', async () => {
    await themeSyncReady

    await handleThemeChanged({ payload: remotePayload({ mode: 'not-a-real-mode' }) } as never)

    // 保持原值 'dual'，而不是把一个 ThemeMode 之外的字符串写进 store——那会污染所有
    // 依赖 mode 做穷尽匹配的下游逻辑。
    expect(useTheme.getState().mode).toBe('dual')
  })

  it('未知的主题 id 回退到默认值而不是写进 store', async () => {
    await themeSyncReady

    await handleThemeChanged({ payload: remotePayload({ mode: 'single', singleThemeId: 'no-such-theme' }) } as never)

    const s = useTheme.getState()
    expect(s.singleThemeId).not.toBe('no-such-theme')
    expect(s.activeTheme.id).toBe(s.singleThemeId)
  })

  it('systemPrefersDark 是本窗口自己的状态，远端载荷无权改它', async () => {
    // 起点 systemPrefersDark=false（beforeEach 设的）。载荷里根本没有这个字段，
    // 实现若"顺手"把它也一起替换（比如整份 payload 展开进 setState），这里会变 true。
    await themeSyncReady

    await handleThemeChanged({ payload: { ...remotePayload(), systemPrefersDark: true } } as never)

    expect(useTheme.getState().systemPrefersDark).toBe(false)
  })
})
