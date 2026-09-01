import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AppearanceSection } from '../components/settings/AppearanceSection'
import { useTheme } from '../store/theme'

describe('AppearanceSection', () => {
  beforeEach(() => {
    useTheme.setState({ mode: 'dual', lightThemeId: 'catppuccin-latte', darkThemeId: 'tokyo-night' })
  })

  it('三个模式按钮都在', () => {
    render(<AppearanceSection />)
    for (const label of ['默认', '双主题跟随系统', '手动选定']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeNull()
    }
  })

  it('点模式按钮改变 store', () => {
    render(<AppearanceSection />)
    fireEvent.click(screen.getByRole('button', { name: '手动选定' }))
    expect(useTheme.getState().mode).toBe('single')
  })

  it('dual 模式显示亮色与暗色两个列表', () => {
    render(<AppearanceSection />)
    expect(screen.queryByText('亮色')).not.toBeNull()
    expect(screen.queryByText('暗色')).not.toBeNull()
  })

  it('default 模式不显示主题列表', () => {
    useTheme.setState({ mode: 'default' })
    render(<AppearanceSection />)
    expect(screen.queryByText('亮色')).toBeNull()
    expect(screen.queryByText('暗色')).toBeNull()
    expect(screen.queryByText('主题')).toBeNull()
  })

  // R1 修复：原版断言值（'catppuccin-latte'）与 beforeEach 的初始值
  // （lightThemeId: 'catppuccin-latte'）相同——不管点击有没有真的调用
  // setLightThemeId，断言都成立，是恒真测试。改成点一个与初始值不同的亮色
  // 主题（Gruvbox Light），前后值不同断言才有意义。
  it('选一个亮色主题会写进 store', () => {
    render(<AppearanceSection />)
    fireEvent.click(screen.getByTitle('Gruvbox Light'))
    expect(useTheme.getState().lightThemeId).toBe('gruvbox-light')
  })

  // R1 补充：dual 模式暗色列表选择此前零覆盖。初始 darkThemeId 是 beforeEach 设的
  // 'tokyo-night'，点击一个不同的暗色主题（Dracula），前后值不同。
  it('选一个暗色主题会写进 store', () => {
    render(<AppearanceSection />)
    fireEvent.click(screen.getByTitle('Dracula'))
    expect(useTheme.getState().darkThemeId).toBe('dracula')
  })

  // R1 补充：single 模式列表选择此前零覆盖。显式把 singleThemeId 设成与点击目标
  // 不同的主题（Nord vs. 点击的 Gruvbox Dark），不依赖 store 残留的偶然值。
  it('single 模式选一个主题会写进 store', () => {
    useTheme.setState({ mode: 'single', singleThemeId: 'nord' })
    render(<AppearanceSection />)
    fireEvent.click(screen.getByTitle('Gruvbox Dark'))
    expect(useTheme.getState().singleThemeId).toBe('gruvbox-dark')
  })

  // Task 5 R1 修复：迁移自 ThemeSwitcher.test.tsx 用例③「single 模式展开时只显示
  // 一个主题列表」，原用例断言了四件事，删除 ThemeSwitcher 时只保留了第 4 项
  // （选主题会写进 store，即上面那条），前三项（single 模式下"亮色"/"暗色"不出现、
  // "主题"出现）净丢失了覆盖——若 AppearanceSection.tsx 的 single 分支条件将来被
  // 误写成同时命中 dual 分支（例如 `mode !== 'default'`），这里补上的三条断言能
  // 分别单独抓住这类回归，不依赖"选主题"这条动作型断言（那条即使 dual/single
  // 两块同时渲染也照样能通过，起不到形状检查的作用）。三条断言逐一做过独立变异
  // 验证，见 task-5-report.md「修复轮 R1」。
  it('single 模式只渲染"主题"一个列表，不渲染 dual 模式的"亮色"/"暗色"', () => {
    useTheme.setState({ mode: 'single', singleThemeId: 'nord' })
    render(<AppearanceSection />)
    expect(screen.queryByText('亮色')).toBeNull()
    expect(screen.queryByText('暗色')).toBeNull()
    expect(screen.queryByText('主题')).not.toBeNull()
  })
})
