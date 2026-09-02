import { useTheme, type ThemeMode } from '../../store/theme'
import { THEMES, type Theme } from '../../themes/data'
import { SettingCard } from './SettingCard'
import { SettingRow } from './SettingRow'
import { SettingSelect, type SettingSelectOption } from './SettingSelect'

// v3-2c 第二轮：用户否掉了第一版（三个模式大按钮横排 + 两条长长的色块列表，见
// task-5-report.md/AppearanceSection.test.tsx 历史版本），原话"太丑了……你上面一选
// 默认，然后下面什么都不显示，这个东西就显得很绰绰有余"。改成 Codex 桌面版设置页
// 的行式卡片：一张「外观」卡片，四行永远都在（主题模式/浅色主题/深色主题/指定
// 主题），版式恒定，不适用当前模式的行整行禁用、description 换成"为什么不可用"，
// 不再是"选了默认下面就空一片"。
//
// MODE_LABEL 的三个值——src-tauri/src/lib.rs 的
// theme_mode_labels_match_frontend_appearance_section 单测会读取本文件源码，按
// `` `{mode}: '{label}',' `` 精确匹配这三行，Rust 侧 macOS 菜单栏「主题」子菜单
// 用的是同一份文案。改这三个字符串前先看那条测试，否则 cargo test 会红。
const MODE_LABEL: Record<ThemeMode, string> = {
  default: '默认',
  dual: '双主题跟随系统',
  single: '手动选定',
}

const LIGHT_THEMES = THEMES.filter((t) => t.appearance === 'light')
const DARK_THEMES = THEMES.filter((t) => t.appearance === 'dark')

// 预览用的几个 ANSI 下标：红/绿/蓝，足够辨认主题基调又不会太拥挤——与改造前的
// ThemeRow 用的是同一份下标。
const PREVIEW_ANSI_INDEXES = [1, 2, 4]

function themeSelectOptions(themes: Theme[]): SettingSelectOption[] {
  return themes.map((t) => ({
    id: t.id,
    label: t.name,
    swatches: [t.bg, t.fg, ...PREVIEW_ANSI_INDEXES.map((i) => t.ansi[i])],
  }))
}

const MODE_OPTIONS: SettingSelectOption[] = (['default', 'dual', 'single'] as ThemeMode[]).map((m) => ({
  id: m,
  label: MODE_LABEL[m],
}))

const LIGHT_OPTIONS = themeSelectOptions(LIGHT_THEMES)
const DARK_OPTIONS = themeSelectOptions(DARK_THEMES)
// 「指定主题」（single 模式）不区分明暗，可选全部主题——与原版 ThemeList
// label="主题" themes={THEMES} 行为一致。
const ALL_OPTIONS = themeSelectOptions(THEMES)

const MODE_DESCRIPTION = '默认固定使用浅色；跟随系统则随深浅自动切换'
const LIGHT_ENABLED_DESCRIPTION = '系统处于浅色外观时使用'
const DARK_ENABLED_DESCRIPTION = '系统处于深色外观时使用'
const SINGLE_ENABLED_DESCRIPTION = '手动选定模式下使用的主题'
// 浅色/深色两行只在 dual 模式下适用，default/single 两种情况下禁用的原因相同，
// 共用同一句文案。
const DUAL_ONLY_DESCRIPTION = '当前模式不使用，切到『双主题跟随系统』后生效'
const SINGLE_ONLY_DESCRIPTION = '当前模式不使用，切到『手动选定』后生效'

export function AppearanceSection() {
  const mode = useTheme((s) => s.mode)
  const lightThemeId = useTheme((s) => s.lightThemeId)
  const darkThemeId = useTheme((s) => s.darkThemeId)
  const singleThemeId = useTheme((s) => s.singleThemeId)
  const setMode = useTheme((s) => s.setMode)
  const setLightThemeId = useTheme((s) => s.setLightThemeId)
  const setDarkThemeId = useTheme((s) => s.setDarkThemeId)
  const setSingleThemeId = useTheme((s) => s.setSingleThemeId)

  const dualEnabled = mode === 'dual'
  const singleEnabled = mode === 'single'

  return (
    <div className="appearance-section">
      <SettingCard title="外观">
        <SettingRow
          label="主题模式"
          description={MODE_DESCRIPTION}
          control={
            <SettingSelect
              ariaLabel="主题模式"
              options={MODE_OPTIONS}
              value={mode}
              onChange={(id) => setMode(id as ThemeMode)}
            />
          }
        />
        <SettingRow
          label="浅色主题"
          description={dualEnabled ? LIGHT_ENABLED_DESCRIPTION : DUAL_ONLY_DESCRIPTION}
          disabled={!dualEnabled}
          control={
            <SettingSelect
              ariaLabel="浅色主题"
              options={LIGHT_OPTIONS}
              value={lightThemeId}
              onChange={setLightThemeId}
              disabled={!dualEnabled}
            />
          }
        />
        <SettingRow
          label="深色主题"
          description={dualEnabled ? DARK_ENABLED_DESCRIPTION : DUAL_ONLY_DESCRIPTION}
          disabled={!dualEnabled}
          control={
            <SettingSelect
              ariaLabel="深色主题"
              options={DARK_OPTIONS}
              value={darkThemeId}
              onChange={setDarkThemeId}
              disabled={!dualEnabled}
            />
          }
        />
        <SettingRow
          label="指定主题"
          description={singleEnabled ? SINGLE_ENABLED_DESCRIPTION : SINGLE_ONLY_DESCRIPTION}
          disabled={!singleEnabled}
          control={
            <SettingSelect
              ariaLabel="指定主题"
              options={ALL_OPTIONS}
              value={singleThemeId}
              onChange={setSingleThemeId}
              disabled={!singleEnabled}
            />
          }
        />
      </SettingCard>
    </div>
  )
}
