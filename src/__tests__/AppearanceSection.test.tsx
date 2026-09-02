import { describe, expect, it, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AppearanceSection } from '../components/settings/AppearanceSection'
import { useTheme } from '../store/theme'

// v3-2c 第二轮：主题页从"三个模式大按钮 + 两条长长的色块列表"改成 Codex 风格的行式
// 卡片（SettingCard + SettingRow + SettingSelect）——用户原话"太丑了……你上面一选
// 默认，然后下面什么都不显示"。新版四行永远都在（主题模式/浅色主题/深色主题/指定
// 主题），不适用当前模式的行整行禁用、description 换成"为什么不可用"，不再是"选了
// 默认下面就空一片"。本文件是这次改版对应的重写（原版断言语义一条不少，见下方各
// 用例头部注释标注对应关系）。
//
// 每一行的控件（SettingSelect 触发器）都用 aria-label 精确对应行的可见 label 文案
// （"主题模式"/"浅色主题"/"深色主题"/"指定主题"），与 TerminalSection 的滑块
// aria-label="滚动速度" 同一惯例，因此可以直接用 getByRole('button', { name: ... })
// 定位到具体某一行的下拉，不依赖 DOM 结构顺序。
function openSelect(rowLabel: string) {
  fireEvent.click(screen.getByRole('button', { name: rowLabel }))
}

describe('AppearanceSection', () => {
  beforeEach(() => {
    useTheme.setState({
      mode: 'dual',
      lightThemeId: 'catppuccin-latte',
      darkThemeId: 'tokyo-night',
      singleThemeId: 'nord',
    })
  })

  it('四行永远都在：主题模式/浅色主题/深色主题/指定主题四个控件都能按行 label 找到', () => {
    render(<AppearanceSection />)
    for (const label of ['主题模式', '浅色主题', '深色主题', '指定主题']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeNull()
    }
  })

  // --- 禁用矩阵：三种模式下各自哪些行被禁用（断言控件带原生 disabled）---

  it('default 模式：只有"主题模式"启用，其余三行的控件都是 disabled', () => {
    useTheme.setState({ mode: 'default' })
    render(<AppearanceSection />)
    expect((screen.getByRole('button', { name: '主题模式' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '浅色主题' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '深色主题' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '指定主题' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('dual 模式：主题模式/浅色主题/深色主题启用，指定主题禁用', () => {
    render(<AppearanceSection />) // beforeEach 已是 dual
    expect((screen.getByRole('button', { name: '主题模式' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '浅色主题' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '深色主题' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '指定主题' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('single 模式：主题模式/指定主题启用，浅色主题/深色主题禁用', () => {
    useTheme.setState({ mode: 'single' })
    render(<AppearanceSection />)
    expect((screen.getByRole('button', { name: '主题模式' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '浅色主题' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '深色主题' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '指定主题' }) as HTMLButtonElement).disabled).toBe(false)
  })

  // --- description 文案：启用态说明用途，禁用态说明"为什么不可用" ---

  it('dual 模式下，浅色/深色主题行显示各自的启用说明', () => {
    render(<AppearanceSection />)
    expect(screen.queryByText('系统处于浅色外观时使用')).not.toBeNull()
    expect(screen.queryByText('系统处于深色外观时使用')).not.toBeNull()
  })

  it('default 模式下，浅色/深色/指定主题三行都显示"当前模式不使用"的禁用说明', () => {
    useTheme.setState({ mode: 'default' })
    render(<AppearanceSection />)
    // 浅色/深色两行禁用原因相同，共用同一句文案，页面上应出现两次。
    expect(screen.getAllByText('当前模式不使用，切到『双主题跟随系统』后生效').length).toBe(2)
    expect(screen.queryByText('当前模式不使用，切到『手动选定』后生效')).not.toBeNull()
  })

  it('single 模式下，指定主题行显示启用说明；浅色/深色两行显示禁用说明', () => {
    useTheme.setState({ mode: 'single' })
    render(<AppearanceSection />)
    expect(screen.queryByText('手动选定模式下使用的主题')).not.toBeNull()
    expect(screen.getAllByText('当前模式不使用，切到『双主题跟随系统』后生效').length).toBe(2)
  })

  it('"主题模式"行的说明文案跨模式保持不变（它自己从不禁用）', () => {
    useTheme.setState({ mode: 'default' })
    const { rerender } = render(<AppearanceSection />)
    expect(screen.queryByText('默认固定使用浅色；跟随系统则随深浅自动切换')).not.toBeNull()
    act(() => { useTheme.setState({ mode: 'single' }) })
    rerender(<AppearanceSection />)
    expect(screen.queryByText('默认固定使用浅色；跟随系统则随深浅自动切换')).not.toBeNull()
  })

  // --- store 写入：对应原版"点模式按钮改变 store"/"选主题写进 store" 三条，改用下拉交互 ---

  it('主题模式下拉选"手动选定"：真的写进 useTheme.getState().mode', () => {
    render(<AppearanceSection />) // beforeEach: mode 起点是 dual，与目标 single 不同
    openSelect('主题模式')
    fireEvent.click(screen.getByRole('option', { name: '手动选定' }))
    expect(useTheme.getState().mode).toBe('single')
  })

  it('dual 模式下，浅色主题下拉选一个不同的主题：写进 lightThemeId', () => {
    render(<AppearanceSection />) // 起点 catppuccin-latte，目标 Gruvbox Light 不同
    openSelect('浅色主题')
    fireEvent.click(screen.getByRole('option', { name: 'Gruvbox Light' }))
    expect(useTheme.getState().lightThemeId).toBe('gruvbox-light')
  })

  it('dual 模式下，深色主题下拉选一个不同的主题：写进 darkThemeId', () => {
    render(<AppearanceSection />) // 起点 tokyo-night，目标 Dracula 不同
    openSelect('深色主题')
    fireEvent.click(screen.getByRole('option', { name: 'Dracula' }))
    expect(useTheme.getState().darkThemeId).toBe('dracula')
  })

  it('single 模式下，指定主题下拉选一个不同的主题：写进 singleThemeId', () => {
    useTheme.setState({ mode: 'single', singleThemeId: 'nord' }) // 起点 nord，目标 Gruvbox Dark 不同
    render(<AppearanceSection />)
    openSelect('指定主题')
    fireEvent.click(screen.getByRole('option', { name: 'Gruvbox Dark' }))
    expect(useTheme.getState().singleThemeId).toBe('gruvbox-dark')
  })

  // --- 切模式会强制收起当时展开着的、不再适用的下拉（SettingSelect 自身的 disabled 副作用）---

  it('展开着"浅色主题"下拉时把模式切成 single：该下拉的选项列表消失', () => {
    render(<AppearanceSection />) // dual 模式，浅色主题可展开
    openSelect('浅色主题')
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
    openSelect('主题模式')
    fireEvent.click(screen.getByRole('option', { name: '手动选定' }))
    // 切到 single 后，浅色主题整行禁用，之前展开的列表不应该还挂着。
    expect(screen.queryAllByRole('option', { name: 'Gruvbox Light' }).length).toBe(0)
  })
})
