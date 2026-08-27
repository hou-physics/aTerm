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
