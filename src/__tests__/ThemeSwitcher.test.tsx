import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import { useTheme, DEFAULT_THEME } from '../store/theme'

beforeEach(() => {
  useTheme.getState().setMode('dual')
  useTheme.getState().setLightThemeId('github-light')
  useTheme.getState().setDarkThemeId('dracula')
  useTheme.getState().setSingleThemeId('nord')
  vi.clearAllMocks()
})

describe('ThemeSwitcher', () => {
  it('触发按钮显示当前主题名与模式标签（中文），点击后展开选择器', () => {
    render(<ThemeSwitcher />)
    expect(screen.getByText(useTheme.getState().activeTheme.name)).toBeTruthy()
    expect(screen.getByText('双主题跟随系统')).toBeTruthy()
    expect(screen.queryByText('默认')).toBeNull() // 面板收起时看不到模式选项
    fireEvent.click(screen.getByRole('button', { name: /双主题跟随系统/ }))
    expect(screen.getByText('默认')).toBeTruthy()
  })

  it('dual 模式展开时显示"亮色"与"暗色"两个分组', () => {
    render(<ThemeSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /双主题跟随系统/ }))
    expect(screen.getByText('亮色')).toBeTruthy()
    expect(screen.getByText('暗色')).toBeTruthy()
    expect(screen.getByTitle('GitHub Light')).toBeTruthy()
    expect(screen.getByTitle('Dracula')).toBeTruthy()
  })

  it('single 模式展开时只显示一个主题列表，点击某一行会切换 singleThemeId', () => {
    useTheme.getState().setMode('single')
    render(<ThemeSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /手动选定/ }))
    expect(screen.queryByText('亮色')).toBeNull()
    expect(screen.queryByText('暗色')).toBeNull()
    expect(screen.getByText('主题')).toBeTruthy()
    fireEvent.click(screen.getByTitle('Gruvbox Dark'))
    expect(useTheme.getState().singleThemeId).toBe('gruvbox-dark')
    expect(useTheme.getState().activeTheme.id).toBe('gruvbox-dark')
  })

  it('default 模式展开时不显示任何主题列表', () => {
    useTheme.getState().setMode('default')
    render(<ThemeSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /默认/ }))
    expect(screen.queryByText('亮色')).toBeNull()
    expect(screen.queryByText('暗色')).toBeNull()
    expect(screen.queryByText('主题')).toBeNull()
    expect(useTheme.getState().activeTheme).toBe(DEFAULT_THEME)
  })

  it('点击模式按钮切换模式', () => {
    render(<ThemeSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /双主题跟随系统/ }))
    fireEvent.click(screen.getByRole('button', { name: '手动选定' }))
    expect(useTheme.getState().mode).toBe('single')
  })

  it('点击外部区域会收起面板', () => {
    render(<div><ThemeSwitcher /><button type="button">outside</button></div>)
    fireEvent.click(screen.getByRole('button', { name: /双主题跟随系统/ }))
    expect(screen.getByText('默认')).toBeTruthy()
    fireEvent.pointerDown(screen.getByText('outside'))
    expect(screen.queryByText('默认')).toBeNull()
  })
})
