import { useEffect, useRef, useState } from 'react'
import { useTheme, type ThemeMode } from '../store/theme'
import { THEMES, type Theme } from '../themes/data'

const MODE_LABEL: Record<ThemeMode, string> = {
  default: '默认',
  dual: '双主题跟随系统',
  single: '手动选定',
}

const LIGHT_THEMES = THEMES.filter((t) => t.appearance === 'light')
const DARK_THEMES = THEMES.filter((t) => t.appearance === 'dark')

// 预览用的几个 ANSI 下标：红/绿/蓝，足够辨认主题基调又不会太拥挤。
const PREVIEW_ANSI_INDEXES = [1, 2, 4]

function ThemeRow({ theme, active, onSelect }: { theme: Theme; active: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      className={active ? 'theme-row active' : 'theme-row'}
      onClick={() => onSelect(theme.id)}
      title={theme.name}
    >
      <span className="theme-row-swatches">
        <span className="theme-swatch" style={{ background: theme.bg }} />
        <span className="theme-swatch" style={{ background: theme.fg }} />
        {PREVIEW_ANSI_INDEXES.map((i) => (
          <span key={i} className="theme-swatch" style={{ background: theme.ansi[i] }} />
        ))}
      </span>
      <span className="theme-row-name">{theme.name}</span>
    </button>
  )
}

function ThemeList({ label, themes, selectedId, onSelect }: {
  label: string
  themes: Theme[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  return (
    <div className="theme-picker-group">
      <div className="theme-picker-group-label">{label}</div>
      <div className="theme-picker-list">
        {themes.map((t) => (
          <ThemeRow key={t.id} theme={t} active={t.id === selectedId} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}

export function ThemeSwitcher() {
  const mode = useTheme((s) => s.mode)
  const activeTheme = useTheme((s) => s.activeTheme)
  const lightThemeId = useTheme((s) => s.lightThemeId)
  const darkThemeId = useTheme((s) => s.darkThemeId)
  const singleThemeId = useTheme((s) => s.singleThemeId)
  const setMode = useTheme((s) => s.setMode)
  const setLightThemeId = useTheme((s) => s.setLightThemeId)
  const setDarkThemeId = useTheme((s) => s.setDarkThemeId)
  const setSingleThemeId = useTheme((s) => s.setSingleThemeId)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div className="theme-switcher" ref={rootRef}>
      <button type="button" className="theme-switcher-trigger" onClick={() => setOpen((v) => !v)}>
        <span className="theme-swatch theme-switcher-dot" style={{ background: activeTheme.bg }} />
        <span className="theme-switcher-text">
          <span className="theme-switcher-name">{activeTheme.name}</span>
          <span className="theme-switcher-mode">{MODE_LABEL[mode]}</span>
        </span>
      </button>
      {open && (
        <div className="theme-picker">
          <div className="theme-picker-modes">
            {(['default', 'dual', 'single'] as ThemeMode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={m === mode ? 'active' : ''}
                onClick={() => setMode(m)}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          {mode === 'dual' && (
            <>
              <ThemeList label="亮色" themes={LIGHT_THEMES} selectedId={lightThemeId} onSelect={setLightThemeId} />
              <ThemeList label="暗色" themes={DARK_THEMES} selectedId={darkThemeId} onSelect={setDarkThemeId} />
            </>
          )}
          {mode === 'single' && (
            <ThemeList label="主题" themes={THEMES} selectedId={singleThemeId} onSelect={setSingleThemeId} />
          )}
        </div>
      )}
    </div>
  )
}
