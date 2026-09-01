import { describe, expect, it, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { SettingsPanel } from '../components/SettingsPanel'
import { useSettings } from '../store/settings'

describe('SettingsPanel', () => {
  beforeEach(() => { useSettings.setState({ open: false }) })

  it('关闭时不渲染任何内容', () => {
    const { container } = render(<SettingsPanel />)
    expect(container.firstChild).toBeNull()
  })

  it('打开时渲染面板', () => {
    useSettings.setState({ open: true })
    render(<SettingsPanel />)
    expect(screen.queryByRole('dialog')).not.toBeNull()
  })

  it('按 Esc 关闭', () => {
    useSettings.setState({ open: true })
    render(<SettingsPanel />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useSettings.getState().open).toBe(false)
  })

  it('点遮罩关闭', () => {
    useSettings.setState({ open: true })
    const { container } = render(<SettingsPanel />)
    const scrim = container.querySelector('.settings-scrim')!
    fireEvent.click(scrim)
    expect(useSettings.getState().open).toBe(false)
  })

  it('点面板内部不关闭', () => {
    useSettings.setState({ open: true })
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('dialog'))
    expect(useSettings.getState().open).toBe(true)
  })

  it('点关闭按钮关闭', () => {
    useSettings.setState({ open: true })
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(useSettings.getState().open).toBe(false)
  })

  it('打开时把焦点移进面板', () => {
    useSettings.setState({ open: true })
    render(<SettingsPanel />)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })

  it('关闭后把焦点还给打开它的触发元素', () => {
    const trigger = document.createElement('button')
    trigger.textContent = '打开设置'
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    useSettings.setState({ open: true })
    const { rerender } = render(<SettingsPanel />)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))

    act(() => { useSettings.setState({ open: false }) })
    rerender(<SettingsPanel />)
    expect(document.activeElement).toBe(trigger)

    trigger.remove()
  })
})
