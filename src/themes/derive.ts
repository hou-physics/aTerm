// 从一个终端主题（Theme）推导整个应用界面（侧栏/标签栏/面板）用到的 --color-* 变量，
// 让整个应用读起来是同一套配色，而不是终端一套、UI 另一套。纯函数，方便单测。
import type { ITheme } from '@xterm/xterm'
import type { Theme } from './data'

type RGB = { r: number; g: number; b: number }

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

function rgbToHex({ r, g, b }: RGB): string {
  const c = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** 在 sRGB 通道上线性插值，t=0 得 a，t=1 得 b。 */
function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a)
  const cb = hexToRgb(b)
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
  })
}

/** WCAG 相对亮度。 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  const lin = (c: number) => {
    const cs = c / 255
    return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 对比度，恒 >= 1。 */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA)
  const lb = relativeLuminance(hexB)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * 朝 target 方向把 base 推移 amt（0-1）；若因 base 已处于该通道极值导致结果与 base 完全
 * 相同（例如纯白背景已经无法再"更白"），改朝 fallbackTarget 方向推移，保证产出的颜色
 * 与 base 总是可区分（只要 base !== fallbackTarget）。
 */
function nudge(base: string, target: string, amt: number, fallbackTarget: string): string {
  const out = mixHex(base, target, amt)
  if (out.toLowerCase() === base.toLowerCase()) {
    return mixHex(base, fallbackTarget, amt)
  }
  return out
}

const ANSI_BLUE = 4
const ANSI_CYAN = 6
const ANSI_BRIGHT_BLUE = 12
const ANSI_BRIGHT_CYAN = 14

const ACCENT_MIN_CONTRAST = 1.6 // 作为强调色/边框描边使用，只需与面板可区分
const ACCENT_TEXT_MIN_CONTRAST = 3.0 // 作为可点击文字使用，需要更高可读对比度

function pickBestContrast(candidates: string[], against: string, minContrast: number): string {
  let best = candidates[0]
  let bestRatio = -Infinity
  for (const c of candidates) {
    const ratio = contrastRatio(c, against)
    if (ratio >= minContrast) return c
    if (ratio > bestRatio) {
      bestRatio = ratio
      best = c
    }
  }
  return best
}

function pickAccent(theme: Theme, panel: string): string {
  const candidates = [theme.ansi[ANSI_BLUE], theme.ansi[ANSI_CYAN], theme.ansi[ANSI_BRIGHT_BLUE], theme.ansi[ANSI_BRIGHT_CYAN]]
  return pickBestContrast(candidates, panel, ACCENT_MIN_CONTRAST)
}

/**
 * 若候选色本身对比度仍不够（部分主题的蓝/青系 ANSI 色天生偏浅），朝黑或白（取
 * 二者中更能提升对比度的一侧）继续推移，直到达标或已经推到很接近该极值——
 * 保底比死板地不可读要好，同时尽量不完全丢失原色相。
 */
function boostContrast(color: string, against: string, minContrast: number): string {
  if (contrastRatio(color, against) >= minContrast) return color
  const target = contrastRatio(mixHex(color, '#000000', 0.5), against) > contrastRatio(mixHex(color, '#ffffff', 0.5), against)
    ? '#000000'
    : '#ffffff'
  let best = color
  let bestRatio = contrastRatio(color, against)
  for (let t = 0.15; t <= 0.9; t += 0.15) {
    const c = mixHex(color, target, t)
    const ratio = contrastRatio(c, against)
    if (ratio > bestRatio) { best = c; bestRatio = ratio }
    if (ratio >= minContrast) return c
  }
  return best
}

function pickAccentText(theme: Theme, bg: string, accent: string): string {
  const candidates = [accent, theme.ansi[ANSI_BRIGHT_BLUE], theme.ansi[ANSI_BRIGHT_CYAN], theme.ansi[ANSI_BLUE], theme.ansi[ANSI_CYAN]]
  const picked = pickBestContrast(candidates, bg, ACCENT_TEXT_MIN_CONTRAST)
  return boostContrast(picked, bg, ACCENT_TEXT_MIN_CONTRAST)
}

/**
 * 给"背景就是 accent 本色"的场景（例如主题选择器里当前模式按钮的高亮态）挑一个
 * 前景色：黑或白，取二者中对 accent 对比度更高的一侧。不是新的对比度算法，只是
 * 复用 contrastRatio 在两个候选间做选择——全部 28 个内置主题下都能让
 * contrastRatio(accent, onAccent) ≥ 4.5（见 derive.test.ts）。
 */
function pickOnAccent(accent: string): string {
  return contrastRatio(accent, '#000000') >= contrastRatio(accent, '#ffffff') ? '#000000' : '#ffffff'
}

export function deriveUiVars(theme: Theme): Record<string, string> {
  const isDark = theme.appearance === 'dark'
  const extreme = isDark ? '#000000' : '#ffffff'
  const bg = theme.bg
  const fg = theme.fg

  // panel：从 bg 朝"远离 fg"的方向（即该主题自身背景基调更极端的方向）轻推一步，
  // 形成与内容区背景有区隔、但仍属于同一基调的侧栏/标签栏底色。
  const panel = nudge(bg, extreme, 0.12, fg)
  // elevated / border：朝 fg 方向递进推移，级差递增，用于需要更显眼的悬浮态/分隔线。
  const elevated = nudge(bg, fg, 0.1, extreme)
  const border = nudge(bg, fg, 0.2, extreme)
  // 标签关闭按钮的 hover 态需要比 border 更强的存在感。
  const tabCloseHoverBg = nudge(bg, fg, 0.34, extreme)
  const tabCloseHoverText = isDark ? '#ffffff' : fg

  const accent = pickAccent(theme, panel)
  const accentText = pickAccentText(theme, bg, accent)
  const onAccent = pickOnAccent(accent)

  return {
    '--color-bg': bg,
    '--color-panel': panel,
    '--color-elevated': elevated,
    '--color-border': border,
    '--color-text': fg,
    '--color-text-dim': withAlpha(fg, 0.68),
    '--color-text-faint': withAlpha(fg, 0.46),
    '--color-accent': accent,
    '--color-accent-text': accentText,
    '--color-on-accent': onAccent,
    '--color-term-bg': bg,
    '--color-tab-close-hover-bg': tabCloseHoverBg,
    '--color-tab-close-hover-text': tabCloseHoverText,
  }
}

/** deriveUiVars 产出的每一个 --color-* 变量名，供测试/校验使用。 */
export const UI_VAR_NAMES = [
  '--color-bg',
  '--color-panel',
  '--color-elevated',
  '--color-border',
  '--color-text',
  '--color-text-dim',
  '--color-text-faint',
  '--color-accent',
  '--color-accent-text',
  '--color-on-accent',
  '--color-term-bg',
  '--color-tab-close-hover-bg',
  '--color-tab-close-hover-text',
] as const

// xterm ITheme 的 16 色属性名，顺序对应 Theme.ansi 的 0-15（黑红绿黄蓝紫青白 × 2）；
// 只有下标 5/13（our 'purple'）在 xterm 里叫 magenta，位置不变。
const XTERM_ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const satisfies readonly (keyof ITheme)[]

const SLIDER_ALPHA = { base: 0.35, hover: 0.55, active: 0.75 }

/**
 * 终端本身（xterm）用的主题：直接来自 Theme 的 bg/fg/cursor/selection + 16 色 ANSI，
 * 外加滚动条滑块颜色（xterm 的 SmoothScrollableElement 把颜色写成内联样式，CSS 规则
 * 覆盖不到，见 App.css 里的说明）——滑块色取 theme.fg 的低透明度版本，沿用此前的
 * 三档透明度（常态/hover/按下）。
 */
export function buildXtermTheme(theme: Theme): ITheme {
  const result: ITheme = {
    background: theme.bg,
    foreground: theme.fg,
    cursor: theme.cursor,
    selectionBackground: theme.selection,
    scrollbarSliderBackground: withAlpha(theme.fg, SLIDER_ALPHA.base),
    scrollbarSliderHoverBackground: withAlpha(theme.fg, SLIDER_ALPHA.hover),
    scrollbarSliderActiveBackground: withAlpha(theme.fg, SLIDER_ALPHA.active),
  }
  XTERM_ANSI_KEYS.forEach((key, i) => {
    result[key] = theme.ansi[i]
  })
  return result
}

/** 把 deriveUiVars 的结果写为 document.documentElement 的内联样式；同时保留
 * data-theme 属性同步（部分既有 CSS 可能仍按它选择规则）。 */
export function applyUiVars(theme: Theme): void {
  try {
    const root = document.documentElement
    const vars = deriveUiVars(theme)
    for (const [k, v] of Object.entries(vars)) {
      root.style.setProperty(k, v)
    }
    root.setAttribute('data-theme', theme.appearance)
  } catch {
    /* 非 DOM 环境，忽略 */
  }
}
