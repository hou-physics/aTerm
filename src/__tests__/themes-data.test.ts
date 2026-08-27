import { describe, expect, it } from 'vitest'
import { THEMES, THEMES_BY_ID, getTheme } from '../themes/data'

const HEX_RE = /^#[0-9a-f]{6}$/

describe('themes/data', () => {
  it('curates between 24 and 30 themes', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(24)
    expect(THEMES.length).toBeLessThanOrEqual(30)
  })

  it('every theme has exactly 16 ansi entries', () => {
    for (const t of THEMES) {
      expect(t.ansi).toHaveLength(16)
    }
  })

  it('every colour string matches #rrggbb', () => {
    for (const t of THEMES) {
      expect(t.bg).toMatch(HEX_RE)
      expect(t.fg).toMatch(HEX_RE)
      expect(t.cursor).toMatch(HEX_RE)
      expect(t.selection).toMatch(HEX_RE)
      for (const c of t.ansi) {
        expect(c).toMatch(HEX_RE)
      }
    }
  })

  it('ids are unique and kebab-case', () => {
    const ids = THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('names are non-empty and unique', () => {
    const names = THEMES.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) {
      expect(n.length).toBeGreaterThan(0)
    }
  })

  it('both appearances are represented, roughly split dark-heavy', () => {
    const dark = THEMES.filter((t) => t.appearance === 'dark')
    const light = THEMES.filter((t) => t.appearance === 'light')
    expect(dark.length).toBeGreaterThan(0)
    expect(light.length).toBeGreaterThan(0)
    expect(dark.length + light.length).toBe(THEMES.length)
  })

  it('appearance matches relative luminance of bg, not the name', () => {
    for (const t of THEMES) {
      const lum = relativeLuminance(t.bg)
      if (t.appearance === 'light') {
        expect(lum).toBeGreaterThan(0.5)
      } else {
        expect(lum).toBeLessThanOrEqual(0.5)
      }
    }
  })

  it('THEMES_BY_ID and getTheme are consistent with THEMES', () => {
    for (const t of THEMES) {
      expect(THEMES_BY_ID[t.id]).toEqual(t)
      expect(getTheme(t.id)).toEqual(t)
    }
    expect(getTheme('does-not-exist')).toBeUndefined()
  })
})

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
