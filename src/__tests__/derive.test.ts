import { describe, expect, it } from 'vitest'
import { THEMES, getTheme, type Theme } from '../themes/data'
import { deriveUiVars, contrastRatio, relativeLuminance, UI_VAR_NAMES, buildXtermTheme, applyUiVars } from '../themes/derive'

function theme(id: string): Theme {
  const t = getTheme(id)
  if (!t) throw new Error(`missing fixture theme ${id}`)
  return t
}

describe('deriveUiVars', () => {
  it('returns every --color-* variable currently defined in App.css, for every theme', () => {
    for (const t of THEMES) {
      const vars = deriveUiVars(t)
      for (const name of UI_VAR_NAMES) {
        expect(vars).toHaveProperty(name)
        expect(typeof vars[name]).toBe('string')
        expect(vars[name].length).toBeGreaterThan(0)
      }
    }
  })

  it('--color-term-bg is exactly theme.bg', () => {
    for (const t of THEMES) {
      expect(deriveUiVars(t)['--color-term-bg']).toBe(t.bg)
    }
  })

  it('--color-bg is exactly theme.bg and --color-text is exactly theme.fg', () => {
    for (const t of THEMES) {
      const vars = deriveUiVars(t)
      expect(vars['--color-bg']).toBe(t.bg)
      expect(vars['--color-text']).toBe(t.fg)
    }
  })

  it('panel is always distinguishable from bg, across all curated themes (incl. pure #fff/#000 bg)', () => {
    for (const t of THEMES) {
      const vars = deriveUiVars(t)
      expect(vars['--color-panel'].toLowerCase()).not.toBe(vars['--color-bg'].toLowerCase())
    }
  })

  it('elevated and border step further from bg than panel does, toward fg', () => {
    for (const t of THEMES) {
      const vars = deriveUiVars(t)
      expect(vars['--color-elevated'].toLowerCase()).not.toBe(vars['--color-bg'].toLowerCase())
      expect(vars['--color-border'].toLowerCase()).not.toBe(vars['--color-bg'].toLowerCase())
      expect(vars['--color-border'].toLowerCase()).not.toBe(vars['--color-elevated'].toLowerCase())
    }
  })

  it('text/panel contrast clears a stated legibility threshold on every curated theme', () => {
    const MIN = 4.0
    for (const t of THEMES) {
      const vars = deriveUiVars(t)
      const ratio = contrastRatio(vars['--color-text'], vars['--color-panel'])
      expect(ratio).toBeGreaterThanOrEqual(MIN)
    }
  })

  it('accent/panel contrast clears a stated minimum on every curated theme', () => {
    const MIN = 1.6
    for (const t of THEMES) {
      const vars = deriveUiVars(t)
      const ratio = contrastRatio(vars['--color-accent'], vars['--color-panel'])
      expect(ratio).toBeGreaterThanOrEqual(MIN)
    }
  })

  it('accent-text/bg contrast clears a stated minimum on every curated theme', () => {
    const MIN = 3.0
    for (const t of THEMES) {
      const vars = deriveUiVars(t)
      const ratio = contrastRatio(vars['--color-accent-text'], vars['--color-bg'])
      expect(ratio).toBeGreaterThanOrEqual(MIN)
    }
  })

  // 用于 .theme-picker-modes button.active（背景=accent，文字=on-accent）等"背景就是
  // accent 本色"场景。on-accent 恒为纯黑或纯白（pickOnAccent 二选一），4.5 是全部 28
  // 个内置主题都能清过的最高整数/半档阈值——最差的是 night-owlish-light，约 4.84；
  // 之前硬编码的 color:#fff 在同一批主题上只有 3 个能勉强过 3.0，25 个落在 1.7~4.3。
  it('accent/on-accent contrast clears 4.5 on every curated theme (was: hardcoded #fff text on accent bg)', () => {
    const MIN = 4.5
    for (const t of THEMES) {
      const vars = deriveUiVars(t)
      const ratio = contrastRatio(vars['--color-accent'], vars['--color-on-accent'])
      expect(ratio).toBeGreaterThanOrEqual(MIN)
    }
  })

  // 状态引擎前端任务（P2b）新增：running/awaitingInput/done 三个状态点颜色，见
  // derive.ts 的 pickStatusColor。状态点是纯装饰性圆点（不承载文字），4.5 本可以放宽到
  // WCAG 对图形对象建议的 3.0 下限，但"主色不够时退回高亮变体，仍不够再用既有
  // boostContrast 推移"这条路径下，全部 28 个内置主题实测都能达到 4.5（全局最低约
  // 4.56：solarized-light 的 running、ayu-light 的 done），所以直接采用与文字同档的
  // 4.5，没有用上 3.0 的兜底。
  it('the three status colours (running/awaiting/done) each clear 4.5 contrast against panel, on every curated theme', () => {
    const MIN = 4.5
    for (const t of THEMES) {
      const vars = deriveUiVars(t)
      for (const name of ['--color-status-running', '--color-status-awaiting', '--color-status-done'] as const) {
        const ratio = contrastRatio(vars[name], vars['--color-panel'])
        expect(ratio, `${t.id} ${name} vs panel`).toBeGreaterThanOrEqual(MIN)
      }
    }
  })

  it('the three status colours are pairwise distinct on every curated theme (never render two states identically)', () => {
    for (const t of THEMES) {
      const vars = deriveUiVars(t)
      const running = vars['--color-status-running'].toLowerCase()
      const awaiting = vars['--color-status-awaiting'].toLowerCase()
      const done = vars['--color-status-done'].toLowerCase()
      expect(running).not.toBe(awaiting)
      expect(running).not.toBe(done)
      expect(awaiting).not.toBe(done)
    }
  })

  it('on-accent is always pure black or pure white', () => {
    for (const t of THEMES) {
      const onAccent = deriveUiVars(t)['--color-on-accent'].toLowerCase()
      expect(['#000000', '#ffffff']).toContain(onAccent)
    }
  })

  describe('a very dark theme (ayu-dark, bg lum ~0.004)', () => {
    const t = theme('ayu-dark')
    it('has a low relative luminance background', () => {
      expect(relativeLuminance(t.bg)).toBeLessThan(0.02)
    })
    it('derives a panel darker-or-equal-direction than bg, still distinct', () => {
      const vars = deriveUiVars(t)
      expect(vars['--color-panel']).not.toBe(vars['--color-bg'])
      expect(vars['--color-tab-close-hover-text']).toBe('#ffffff')
    })
  })

  describe('a very light theme (github-light, bg #ffffff)', () => {
    const t = theme('github-light')
    it('has bg exactly #ffffff (no headroom to lighten further)', () => {
      expect(t.bg.toLowerCase()).toBe('#ffffff')
    })
    it('still derives a panel distinct from bg by falling back toward fg', () => {
      const vars = deriveUiVars(t)
      expect(vars['--color-panel'].toLowerCase()).not.toBe('#ffffff')
    })
    it('tab-close hover text mirrors the theme text colour, not white', () => {
      const vars = deriveUiVars(t)
      expect(vars['--color-tab-close-hover-text']).toBe(t.fg)
    })
  })

  describe('a low-contrast theme (solarized-light, the least contrasty curated theme)', () => {
    const t = theme('solarized-light')
    it('is indeed the lowest fg/bg contrast among curated themes', () => {
      const ratios = THEMES.map((x) => contrastRatio(x.fg, x.bg))
      expect(contrastRatio(t.fg, t.bg)).toBe(Math.min(...ratios))
    })
    it('still meets the text/panel legibility floor after derivation', () => {
      const vars = deriveUiVars(t)
      expect(contrastRatio(vars['--color-text'], vars['--color-panel'])).toBeGreaterThanOrEqual(4.0)
    })
  })

  it('is pure: calling twice with the same theme yields identical output', () => {
    const t = theme('dracula')
    expect(deriveUiVars(t)).toEqual(deriveUiVars(t))
  })

  it('text-dim/faint are alpha variants of fg, not opaque replacement colours', () => {
    const t = theme('nord')
    const vars = deriveUiVars(t)
    expect(vars['--color-text-dim']).toMatch(/^rgba\(/)
    expect(vars['--color-text-faint']).toMatch(/^rgba\(/)
  })
})

describe('buildXtermTheme', () => {
  it('maps bg/fg/cursor/selection straight from the Theme', () => {
    for (const t of THEMES) {
      const x = buildXtermTheme(t)
      expect(x.background).toBe(t.bg)
      expect(x.foreground).toBe(t.fg)
      expect(x.cursor).toBe(t.cursor)
      expect(x.selectionBackground).toBe(t.selection)
    }
  })

  it('maps all 16 ansi colours to the correctly-named xterm keys, in order', () => {
    const t = theme('tokyo-night')
    const x = buildXtermTheme(t)
    const order: (keyof typeof x)[] = [
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ]
    order.forEach((key, i) => {
      expect(x[key]).toBe(t.ansi[i])
    })
  })

  it('derives scrollbar slider colours from fg at increasing opacity', () => {
    const t = theme('dracula')
    const x = buildXtermTheme(t)
    expect(x.scrollbarSliderBackground).toMatch(/^rgba\(/)
    expect(x.scrollbarSliderHoverBackground).toMatch(/^rgba\(/)
    expect(x.scrollbarSliderActiveBackground).toMatch(/^rgba\(/)
    const alphaOf = (rgba: string) => Number(rgba.match(/[\d.]+\)$/)?.[0].replace(')', ''))
    expect(alphaOf(x.scrollbarSliderBackground as string)).toBeLessThan(alphaOf(x.scrollbarSliderHoverBackground as string))
    expect(alphaOf(x.scrollbarSliderHoverBackground as string)).toBeLessThan(alphaOf(x.scrollbarSliderActiveBackground as string))
  })
})

describe('applyUiVars', () => {
  it('sets every derived --color-* var as an inline style on document.documentElement', () => {
    const t = theme('catppuccin-mocha')
    applyUiVars(t)
    for (const name of UI_VAR_NAMES) {
      expect(document.documentElement.style.getPropertyValue(name)).not.toBe('')
    }
  })

  it('keeps data-theme in sync with the theme appearance', () => {
    applyUiVars(theme('github-dark'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    applyUiVars(theme('github-light'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})
