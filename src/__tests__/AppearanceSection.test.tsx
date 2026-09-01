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

  it('选一个亮色主题会写进 store', () => {
    render(<AppearanceSection />)
    // 从 THEMES 里挑一个确定存在的亮色主题，按其 name 找按钮
    fireEvent.click(screen.getByTitle('Catppuccin Latte'))
    expect(useTheme.getState().lightThemeId).toBe('catppuccin-latte')
  })
})
