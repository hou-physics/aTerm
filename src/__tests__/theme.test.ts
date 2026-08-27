import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function mockLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  const ls = {
    getItem: vi.fn((k: string) => (store.has(k) ? store.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => { store.set(k, v) }),
    removeItem: vi.fn((k: string) => { store.delete(k) }),
    clear: vi.fn(() => store.clear()),
    _store: store,
  }
  vi.stubGlobal('localStorage', ls)
  return ls
}

function mockMatchMedia(matches: boolean) {
  type Listener = (e: { matches: boolean }) => void
  const listeners: Listener[] = []
  const mql = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: vi.fn((_event: string, cb: Listener) => listeners.push(cb)),
    removeEventListener: vi.fn(),
  }
  vi.stubGlobal('matchMedia', vi.fn(() => mql))
  return { mql, fire: (m: boolean) => { mql.matches = m; listeners.forEach((cb) => cb({ matches: m })) } }
}

beforeEach(() => {
  vi.resetModules()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('style')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('theme store', () => {
  describe('全新安装（无任何持久化值）', () => {
    it('默认落在 dual 模式，跟随系统解析出对应主题', async () => {
      mockLocalStorage()
      mockMatchMedia(true)
      const { useTheme, DEFAULT_DARK_THEME_ID } = await import('../store/theme')
      expect(useTheme.getState().mode).toBe('dual')
      expect(useTheme.getState().activeTheme.id).toBe(DEFAULT_DARK_THEME_ID)
    })
  })

  describe('三档模式切换', () => {
    it('default 模式始终解析为 DEFAULT_THEME，且不受 lightThemeId/darkThemeId 影响', async () => {
      mockLocalStorage()
      mockMatchMedia(true)
      const { useTheme, DEFAULT_THEME } = await import('../store/theme')
      useTheme.getState().setMode('default')
      expect(useTheme.getState().activeTheme).toBe(DEFAULT_THEME)
      useTheme.getState().setDarkThemeId('dracula')
      expect(useTheme.getState().activeTheme).toBe(DEFAULT_THEME)
    })

    it('single 模式解析为 singleThemeId 指向的主题，并且不跟随系统', async () => {
      mockLocalStorage()
      const { fire } = mockMatchMedia(true)
      const { useTheme } = await import('../store/theme')
      useTheme.getState().setMode('single')
      useTheme.getState().setSingleThemeId('gruvbox-dark')
      expect(useTheme.getState().activeTheme.id).toBe('gruvbox-dark')
      fire(false) // 系统切到浅色，single 模式应保持不变
      expect(useTheme.getState().activeTheme.id).toBe('gruvbox-dark')
    })

    it('dual 模式在指定的亮/暗主题之间按系统外观切换', async () => {
      mockLocalStorage()
      mockMatchMedia(true)
      const { useTheme } = await import('../store/theme')
      useTheme.getState().setMode('dual')
      useTheme.getState().setLightThemeId('github-light')
      useTheme.getState().setDarkThemeId('dracula')
      expect(useTheme.getState().activeTheme.id).toBe('dracula')
    })
  })

  describe('dual 对系统外观变化的响应，与 single/default 的隔离', () => {
    it('dual 模式下，系统外观变化会重新解析 activeTheme', async () => {
      mockLocalStorage()
      const { fire } = mockMatchMedia(true)
      const { useTheme } = await import('../store/theme')
      useTheme.getState().setMode('dual')
      useTheme.getState().setLightThemeId('github-light')
      useTheme.getState().setDarkThemeId('dracula')
      expect(useTheme.getState().activeTheme.id).toBe('dracula')
      fire(false)
      expect(useTheme.getState().activeTheme.id).toBe('github-light')
      fire(true)
      expect(useTheme.getState().activeTheme.id).toBe('dracula')
    })

    it('single 模式下，系统外观变化不影响 activeTheme', async () => {
      mockLocalStorage()
      const { fire } = mockMatchMedia(true)
      const { useTheme } = await import('../store/theme')
      useTheme.getState().setMode('single')
      useTheme.getState().setSingleThemeId('nord')
      const before = useTheme.getState().activeTheme
      fire(false)
      fire(true)
      expect(useTheme.getState().activeTheme).toBe(before)
    })

    it('default 模式下，系统外观变化不影响 activeTheme', async () => {
      mockLocalStorage()
      const { fire } = mockMatchMedia(true)
      const { useTheme, DEFAULT_THEME } = await import('../store/theme')
      useTheme.getState().setMode('default')
      fire(false)
      fire(true)
      expect(useTheme.getState().activeTheme).toBe(DEFAULT_THEME)
    })
  })

  describe('持久化：跨"重载"存活', () => {
    it('mode 与三个主题 id 都写入 localStorage，重新 import 后原样恢复', async () => {
      const ls = mockLocalStorage()
      mockMatchMedia(true)
      const { useTheme: useTheme1 } = await import('../store/theme')
      useTheme1.getState().setMode('dual')
      useTheme1.getState().setLightThemeId('one-half-light')
      useTheme1.getState().setDarkThemeId('kanagawa')
      useTheme1.getState().setSingleThemeId('nightfox')

      vi.resetModules()
      // 模拟重载：新的模块实例，但复用同一份 localStorage 内容
      vi.stubGlobal('localStorage', ls)
      const { useTheme: useTheme2 } = await import('../store/theme')
      expect(useTheme2.getState().mode).toBe('dual')
      expect(useTheme2.getState().lightThemeId).toBe('one-half-light')
      expect(useTheme2.getState().darkThemeId).toBe('kanagawa')
      expect(useTheme2.getState().singleThemeId).toBe('nightfox')
    })
  })

  describe('未知持久化 id 的安全回退', () => {
    it('mode 有效，但主题 id 未知/被移除时，读取阶段就地回退到默认值', async () => {
      mockLocalStorage({
        'aterm-theme-mode': 'dual',
        'aterm-theme-light': 'does-not-exist',
        'aterm-theme-dark': 'also-missing',
        'aterm-theme-single': 'gone',
      })
      mockMatchMedia(true)
      const { useTheme, DEFAULT_LIGHT_THEME_ID, DEFAULT_DARK_THEME_ID } = await import('../store/theme')
      expect(useTheme.getState().lightThemeId).toBe(DEFAULT_LIGHT_THEME_ID)
      expect(useTheme.getState().darkThemeId).toBe(DEFAULT_DARK_THEME_ID)
      expect(useTheme.getState().singleThemeId).toBe(DEFAULT_LIGHT_THEME_ID)
      // 启动没有因此崩溃：activeTheme 是一个真实主题
      expect(useTheme.getState().activeTheme).toBeTruthy()
    })

    it('appearance 不匹配的 id（比如把暗色主题塞进 lightThemeId）同样回退', async () => {
      mockLocalStorage({
        'aterm-theme-mode': 'dual',
        'aterm-theme-light': 'dracula', // dracula 是暗色主题，不是合法的 lightThemeId
      })
      mockMatchMedia(true)
      const { useTheme, DEFAULT_LIGHT_THEME_ID } = await import('../store/theme')
      expect(useTheme.getState().lightThemeId).toBe(DEFAULT_LIGHT_THEME_ID)
    })

    it('setLightThemeId 等 setter 传入未知 id 同样回退，不写入垃圾值', async () => {
      const ls = mockLocalStorage()
      mockMatchMedia(true)
      const { useTheme, DEFAULT_LIGHT_THEME_ID } = await import('../store/theme')
      useTheme.getState().setLightThemeId('totally-bogus')
      expect(useTheme.getState().lightThemeId).toBe(DEFAULT_LIGHT_THEME_ID)
      expect(ls.setItem).toHaveBeenCalledWith('aterm-theme-light', DEFAULT_LIGHT_THEME_ID)
    })
  })

  describe('从旧版单键迁移', () => {
    it("旧值 'light' 迁移为 default 模式", async () => {
      const ls = mockLocalStorage({ 'aterm-theme': 'light' })
      mockMatchMedia(true)
      const { useTheme, DEFAULT_THEME } = await import('../store/theme')
      expect(useTheme.getState().mode).toBe('default')
      expect(useTheme.getState().activeTheme).toBe(DEFAULT_THEME)
      expect(ls.setItem).toHaveBeenCalledWith('aterm-theme-mode', 'default')
    })

    it("旧值 'dark' 迁移为 single 模式 + 暗色默认主题", async () => {
      mockLocalStorage({ 'aterm-theme': 'dark' })
      mockMatchMedia(true)
      const { useTheme, DEFAULT_DARK_THEME_ID } = await import('../store/theme')
      expect(useTheme.getState().mode).toBe('single')
      expect(useTheme.getState().singleThemeId).toBe(DEFAULT_DARK_THEME_ID)
      expect(useTheme.getState().activeTheme.id).toBe(DEFAULT_DARK_THEME_ID)
    })

    it("旧值 'system' 迁移为 dual 模式 + 默认亮暗配对", async () => {
      mockLocalStorage({ 'aterm-theme': 'system' })
      mockMatchMedia(true)
      const { useTheme, DEFAULT_LIGHT_THEME_ID, DEFAULT_DARK_THEME_ID } = await import('../store/theme')
      expect(useTheme.getState().mode).toBe('dual')
      expect(useTheme.getState().lightThemeId).toBe(DEFAULT_LIGHT_THEME_ID)
      expect(useTheme.getState().darkThemeId).toBe(DEFAULT_DARK_THEME_ID)
    })

    it('迁移只发生一次：之后重新 import 直接读新键，不再依赖旧键', async () => {
      const ls = mockLocalStorage({ 'aterm-theme': 'light' })
      mockMatchMedia(true)
      await import('../store/theme')
      expect(ls.getItem('aterm-theme-mode')).toBe('default')
      // 手动改新键，确认第二次 import 时不会被旧键的迁移逻辑覆盖回去
      ls.setItem('aterm-theme-mode', 'single')
      vi.resetModules()
      vi.stubGlobal('localStorage', ls)
      const { useTheme } = await import('../store/theme')
      expect(useTheme.getState().mode).toBe('single')
    })
  })

  describe('jsdom-safe 与单次监听器注册', () => {
    it('matchMedia 缺失时不抛异常，且默认视为深色', async () => {
      mockLocalStorage()
      vi.stubGlobal('matchMedia', undefined)
      const { useTheme } = await import('../store/theme')
      expect(useTheme.getState().systemPrefersDark).toBe(true)
    })

    it('只注册一次 change 监听器', async () => {
      mockLocalStorage()
      const { mql } = mockMatchMedia(true)
      await import('../store/theme')
      expect(mql.addEventListener).toHaveBeenCalledTimes(1)
    })
  })
})
