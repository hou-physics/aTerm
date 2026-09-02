import { create } from 'zustand'
import { getTheme, THEMES, type Theme } from '../themes/data'
import { applyUiVars } from '../themes/derive'

export type ThemeMode = 'default' | 'dual' | 'single'

/**
 * 按 id 取主题，找不到（例如 data.ts 未来改名/删除了该 id）时兜底到 THEMES 里第一个
 * 外观匹配的主题，全都没有再兜底到 THEMES[0]——保证这个 helper 本身永远有返回值，
 * 不会像原先的 `getTheme(ID)!` 断言那样在模块加载时直接抛异常导致启动崩溃。
 * appearance 留空表示不关心外观（用于兜底"随便给一个主题也比崩溃强"的最后一层）。
 */
export function getThemeOrFallback(id: string, appearance?: 'dark' | 'light'): Theme {
  const t = getTheme(id)
  if (t) return t
  const byAppearance = appearance ? THEMES.find((x) => x.appearance === appearance) : undefined
  return byAppearance ?? THEMES[0]
}

// “默认”档：不跟随系统，任何时候都固定用这一个耐看的浅色主题；也是 single/dual 里
// 任何持久化主题 id 校验失败时的兜底、以及从旧版 'light' 迁移时的落点。
export const DEFAULT_LIGHT_THEME_ID = 'catppuccin-latte'
export const DEFAULT_THEME: Theme = getThemeOrFallback(DEFAULT_LIGHT_THEME_ID, 'light')
// “双主题跟随系统”档默认配对的暗色成员，也是从旧版 'dark' 迁移时 single 模式的落点。
export const DEFAULT_DARK_THEME_ID = 'tokyo-night'
const DEFAULT_DARK_THEME: Theme = getThemeOrFallback(DEFAULT_DARK_THEME_ID, 'dark')

type ThemeState = {
  mode: ThemeMode
  lightThemeId: string
  darkThemeId: string
  singleThemeId: string
  systemPrefersDark: boolean
  /** 当前实际生效的主题——TerminalView 与全局 UI 配色都消费这一个字段。 */
  activeTheme: Theme
  setMode(m: ThemeMode): void
  setLightThemeId(id: string): void
  setDarkThemeId(id: string): void
  setSingleThemeId(id: string): void
  /** 把另一个窗口广播过来的主题状态整份应用到本窗口（V3.3 §5.5，唯一调用方是
   *  src/themeSync.ts 的 applyRemoteThemeChange）。见下方实现处的注释。 */
  applyRemoteThemeState(p: RemoteThemeState): void
}

/** 另一个窗口广播过来的主题状态（`theme-changed` 载荷里除 fromLabel 外的部分）。
 *  字段全部按 `unknown` 之外的宽松类型声明是刻意的：它来自 IPC，编译期类型不构成
 *  任何运行期保证，`applyRemoteThemeState` 会逐个重新校验。 */
export type RemoteThemeState = {
  mode: string
  lightThemeId: string
  darkThemeId: string
  singleThemeId: string
}

const MODE_KEY = 'aterm-theme-mode'
const LIGHT_KEY = 'aterm-theme-light'
const DARK_KEY = 'aterm-theme-dark'
const SINGLE_KEY = 'aterm-theme-single'
// 旧版单键存储，值曾是 'system' | 'dark' | 'light'。仅在新键从未写入过时读取一次用于迁移。
const LEGACY_KEY = 'aterm-theme'

// 导出给 src/menuEvents.ts 复用：菜单栏"主题"三项收到的 menu-theme-mode payload
// 校验用的是这同一份判断，不在那边另写一份、彼此漂移。
export function isThemeMode(v: string | null): v is ThemeMode {
  return v === 'default' || v === 'dual' || v === 'single'
}

/** 校验一个持久化的主题 id：必须存在于主题数据里，且外观匹配（若指定）；否则回退到 fallback。 */
function validThemeId(id: string | null, appearance: 'dark' | 'light' | undefined, fallback: string): string {
  if (id) {
    const t = getTheme(id)
    if (t && (!appearance || t.appearance === appearance)) return id
  }
  return fallback
}

type Persisted = {
  mode: ThemeMode
  lightThemeId: string
  darkThemeId: string
  singleThemeId: string
}

const FRESH_DEFAULT: Persisted = {
  // 全新安装（无任何旧/新持久化值）时，沿用旧版的默认行为——跟随系统。
  mode: 'dual',
  lightThemeId: DEFAULT_LIGHT_THEME_ID,
  darkThemeId: DEFAULT_DARK_THEME_ID,
  singleThemeId: DEFAULT_LIGHT_THEME_ID,
}

/** 把旧版 'system' | 'dark' | 'light' 单键映射到新的三档模式，让老用户不被重置。 */
function migrateLegacy(legacy: string): Persisted {
  if (legacy === 'light') {
    return { mode: 'default', lightThemeId: DEFAULT_LIGHT_THEME_ID, darkThemeId: DEFAULT_DARK_THEME_ID, singleThemeId: DEFAULT_LIGHT_THEME_ID }
  }
  if (legacy === 'dark') {
    return { mode: 'single', lightThemeId: DEFAULT_LIGHT_THEME_ID, darkThemeId: DEFAULT_DARK_THEME_ID, singleThemeId: DEFAULT_DARK_THEME_ID }
  }
  // 'system' 及任何未识别的旧值都落到 dual + 默认亮暗配对（等价于旧版“跟随系统”）。
  return { mode: 'dual', lightThemeId: DEFAULT_LIGHT_THEME_ID, darkThemeId: DEFAULT_DARK_THEME_ID, singleThemeId: DEFAULT_LIGHT_THEME_ID }
}

function persistAll(p: Persisted) {
  try {
    localStorage.setItem(MODE_KEY, p.mode)
    localStorage.setItem(LIGHT_KEY, p.lightThemeId)
    localStorage.setItem(DARK_KEY, p.darkThemeId)
    localStorage.setItem(SINGLE_KEY, p.singleThemeId)
  } catch { /* 忽略持久化失败 */ }
}

function persistMode(m: ThemeMode) {
  try { localStorage.setItem(MODE_KEY, m) } catch { /* 忽略持久化失败 */ }
}
function persistLightThemeId(id: string) {
  try { localStorage.setItem(LIGHT_KEY, id) } catch { /* 忽略持久化失败 */ }
}
function persistDarkThemeId(id: string) {
  try { localStorage.setItem(DARK_KEY, id) } catch { /* 忽略持久化失败 */ }
}
function persistSingleThemeId(id: string) {
  try { localStorage.setItem(SINGLE_KEY, id) } catch { /* 忽略持久化失败 */ }
}

function readPersisted(): Persisted {
  try {
    const modeRaw = localStorage.getItem(MODE_KEY)
    if (isThemeMode(modeRaw)) {
      // 新键已经写入过：直接读取，逐个校验，未知/被移除的主题 id 回退到默认值。
      return {
        mode: modeRaw,
        lightThemeId: validThemeId(localStorage.getItem(LIGHT_KEY), 'light', DEFAULT_LIGHT_THEME_ID),
        darkThemeId: validThemeId(localStorage.getItem(DARK_KEY), 'dark', DEFAULT_DARK_THEME_ID),
        singleThemeId: validThemeId(localStorage.getItem(SINGLE_KEY), undefined, DEFAULT_LIGHT_THEME_ID),
      }
    }
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy === 'system' || legacy === 'dark' || legacy === 'light') {
      const migrated = migrateLegacy(legacy)
      persistAll(migrated) // 只需迁移一次：写回新键，后续启动直接走上面的新键分支
      return migrated
    }
  } catch { /* localStorage 不可用（如隐私模式），忽略 */ }
  return FRESH_DEFAULT
}

function systemPrefersDarkNow(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return true // jsdom 等无 matchMedia 的环境下默认深色
  }
}

function resolveActiveTheme(mode: ThemeMode, lightId: string, darkId: string, singleId: string, systemPrefersDark: boolean): Theme {
  if (mode === 'default') return DEFAULT_THEME
  if (mode === 'single') return getTheme(singleId) ?? DEFAULT_THEME
  // dual：跟随系统外观在亮/暗两个成员之间切换
  return systemPrefersDark ? (getTheme(darkId) ?? DEFAULT_DARK_THEME) : (getTheme(lightId) ?? DEFAULT_THEME)
}

function applyActiveTheme(theme: Theme) {
  applyUiVars(theme)
}

const initialPersisted = readPersisted()
const initialSystemPrefersDark = systemPrefersDarkNow()
const initialActiveTheme = resolveActiveTheme(
  initialPersisted.mode,
  initialPersisted.lightThemeId,
  initialPersisted.darkThemeId,
  initialPersisted.singleThemeId,
  initialSystemPrefersDark,
)
applyActiveTheme(initialActiveTheme)

export const useTheme = create<ThemeState>((set, get) => ({
  mode: initialPersisted.mode,
  lightThemeId: initialPersisted.lightThemeId,
  darkThemeId: initialPersisted.darkThemeId,
  singleThemeId: initialPersisted.singleThemeId,
  systemPrefersDark: initialSystemPrefersDark,
  activeTheme: initialActiveTheme,
  setMode: (m) => {
    persistMode(m)
    const { lightThemeId, darkThemeId, singleThemeId, systemPrefersDark } = get()
    const activeTheme = resolveActiveTheme(m, lightThemeId, darkThemeId, singleThemeId, systemPrefersDark)
    applyActiveTheme(activeTheme)
    set({ mode: m, activeTheme })
  },
  setLightThemeId: (id) => {
    const valid = validThemeId(id, 'light', DEFAULT_LIGHT_THEME_ID)
    persistLightThemeId(valid)
    const { mode, darkThemeId, singleThemeId, systemPrefersDark } = get()
    const activeTheme = resolveActiveTheme(mode, valid, darkThemeId, singleThemeId, systemPrefersDark)
    applyActiveTheme(activeTheme)
    set({ lightThemeId: valid, activeTheme })
  },
  setDarkThemeId: (id) => {
    const valid = validThemeId(id, 'dark', DEFAULT_DARK_THEME_ID)
    persistDarkThemeId(valid)
    const { mode, lightThemeId, singleThemeId, systemPrefersDark } = get()
    const activeTheme = resolveActiveTheme(mode, lightThemeId, valid, singleThemeId, systemPrefersDark)
    applyActiveTheme(activeTheme)
    set({ darkThemeId: valid, activeTheme })
  },
  setSingleThemeId: (id) => {
    const valid = validThemeId(id, undefined, DEFAULT_LIGHT_THEME_ID)
    persistSingleThemeId(valid)
    const { mode, lightThemeId, darkThemeId, systemPrefersDark } = get()
    const activeTheme = resolveActiveTheme(mode, lightThemeId, darkThemeId, valid, systemPrefersDark)
    applyActiveTheme(activeTheme)
    set({ singleThemeId: valid, activeTheme })
  },
  // 主题跨窗口同步的接管端（V3.3 §5.5）。为什么不能用上面四个 setter 拼出来：
  //   1. 它们各改一个字段、各自 set() 一次，四次连调会连续触发四次订阅回调 + 四次
  //      applyUiVars，中间还会经过 (新 mode, 旧 themeId) 这类**不存在于任何窗口**的
  //      中间态——那正是用户能看见的闪烁；
  //   2. themeSync 的"重新应用期间不得再次广播"闸门包在一次调用外面，四次 set 意味着
  //      四段各自需要被闸门覆盖的窗口。整份原子替换让那个闸门只需要包住一次调用。
  //
  // 载荷来自 IPC，编译期类型不构成运行期保证，因此逐个字段用与本地 setter **同一份**
  // 校验（validThemeId / isThemeMode）重新过一遍——不是不信任兄弟窗口，而是不想让
  // "远端来的值"成为唯一一条能把非法 id 写进 store 的路径。
  //
  // systemPrefersDark **不取自载荷**：那是本窗口自己的系统外观状态（虽然同一台机器上
  // 各窗口必然相同），由本窗口的 matchMedia 监听维护，主题同步无权覆盖它。
  //
  // 仍然 persistAll：Tauri 各窗口同源、localStorage 本就共享，发送端已经写过一次，这次
  // 写的是同样的值、幂等；留着是因为"共享"这件事是运行环境的性质而不是本模块的保证，
  // 而少写一次的收益是零。
  applyRemoteThemeState: (p) => {
    const mode = isThemeMode(p.mode) ? p.mode : get().mode
    const lightThemeId = validThemeId(p.lightThemeId, 'light', DEFAULT_LIGHT_THEME_ID)
    const darkThemeId = validThemeId(p.darkThemeId, 'dark', DEFAULT_DARK_THEME_ID)
    const singleThemeId = validThemeId(p.singleThemeId, undefined, DEFAULT_LIGHT_THEME_ID)
    persistAll({ mode, lightThemeId, darkThemeId, singleThemeId })
    const activeTheme = resolveActiveTheme(mode, lightThemeId, darkThemeId, singleThemeId, get().systemPrefersDark)
    applyActiveTheme(activeTheme)
    set({ mode, lightThemeId, darkThemeId, singleThemeId, activeTheme })
  },
}))

// 系统外观变化：只在 dual 模式下重新解析 activeTheme（default/single 不跟随系统）。
try {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      const sysDark = systemPrefersDarkNow()
      const { mode, lightThemeId, darkThemeId, singleThemeId, activeTheme } = useTheme.getState()
      const nextActiveTheme = mode === 'dual'
        ? resolveActiveTheme(mode, lightThemeId, darkThemeId, singleThemeId, sysDark)
        : activeTheme
      if (nextActiveTheme !== activeTheme) applyActiveTheme(nextActiveTheme)
      useTheme.setState({ systemPrefersDark: sysDark, activeTheme: nextActiveTheme })
    }
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
    } else if (typeof (mql as unknown as { addListener?: (cb: () => void) => void }).addListener === 'function') {
      (mql as unknown as { addListener: (cb: () => void) => void }).addListener(onChange)
    }
  }
} catch { /* 忽略监听失败 */ }
