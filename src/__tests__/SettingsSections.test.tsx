import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TerminalSection } from '../components/settings/TerminalSection'
import { ProjectsSection } from '../components/settings/ProjectsSection'
import { HooksSection } from '../components/settings/HooksSection'
import { useLayout, WHEEL_MULTIPLIER_DEFAULT } from '../store/layout'
import { useLibrary } from '../store/library'
import { useHooksInstall } from '../store/hooksInstall'
import type { HooksStatus } from '../ipc'

describe('TerminalSection', () => {
  beforeEach(() => { useLayout.setState({ wheelMultiplier: WHEEL_MULTIPLIER_DEFAULT }) })

  it('拖动滑块改变 store', () => {
    render(<TerminalSection />)
    const slider = screen.getByRole('slider', { name: '滚动速度' })
    fireEvent.change(slider, { target: { value: '3' } })
    expect(useLayout.getState().wheelMultiplier).toBe(3)
  })

  it('超出上限的值被 clamp 到 6', () => {
    render(<TerminalSection />)
    useLayout.getState().setWheelMultiplier(99)
    expect(useLayout.getState().wheelMultiplier).toBe(6)
  })
})

describe('ProjectsSection', () => {
  beforeEach(() => { useLibrary.setState({ hiddenProjects: {}, removedSessions: {}, aliases: {} }) })

  it('隐藏项目为空时显示说明而不是空框', () => {
    render(<ProjectsSection />)
    expect(screen.queryByText('没有隐藏的项目')).not.toBeNull()
  })

  it('列出隐藏的项目，点「取消隐藏」后从 store 消失', () => {
    useLibrary.setState({ hiddenProjects: { '-Users-me-proj': true } })
    render(<ProjectsSection />)
    expect(screen.queryByText('-Users-me-proj')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '取消隐藏 -Users-me-proj' }))
    expect(useLibrary.getState().hiddenProjects['-Users-me-proj']).toBeUndefined()
  })

  it('已移除的会话优先显示别名', () => {
    const key = '-Users-me-proj::abc123'
    useLibrary.setState({ removedSessions: { [key]: 1 }, aliases: { [key]: '我的会话' } })
    render(<ProjectsSection />)
    expect(screen.queryByText('我的会话')).not.toBeNull()
  })

  it('已移除的会话没有别名时展示 key 本身', () => {
    const key = '-Users-me-proj::abc123'
    useLibrary.setState({ removedSessions: { [key]: 1 } })
    render(<ProjectsSection />)
    expect(screen.queryByText(key)).not.toBeNull()
  })

  it('点「恢复」后会话从 removedSessions 消失', () => {
    const key = '-Users-me-proj::abc123'
    useLibrary.setState({ removedSessions: { [key]: 1 } })
    render(<ProjectsSection />)
    fireEvent.click(screen.getByRole('button', { name: `恢复 ${key}` }))
    expect(useLibrary.getState().removedSessions[key]).toBeUndefined()
  })

  it('已移除会话为空时显示说明而不是空框', () => {
    render(<ProjectsSection />)
    expect(screen.queryByText('没有移除的会话')).not.toBeNull()
  })
})

// Hooks 分区：直接摆 useHooksInstall 的状态（不 mock ipc、不 resetModules）——
// hooksPhase 是纯函数，组件只读 status/pending/error 三个字段，setState 覆盖后
// 组件下一次渲染即拿到新状态，与 TerminalSection/ProjectsSection 直接摆
// useLayout/useLibrary 状态同一手法。三种 phase 各自的文案/按钮见
// src/components/HooksInstall.tsx 的 HooksControl（真源）与
// src/store/hooksInstall.ts 的 hooksPhase/STATE_LABEL 真实行为。
const NOT_INSTALLED: HooksStatus = {
  notification: { installed: false, upToDate: false },
  stop: { installed: false, upToDate: false },
}
const OUTDATED: HooksStatus = {
  notification: { installed: true, upToDate: false },
  stop: { installed: true, upToDate: true },
}
const UP_TO_DATE: HooksStatus = {
  notification: { installed: true, upToDate: true },
  stop: { installed: true, upToDate: true },
}

describe('HooksSection', () => {
  beforeEach(() => { useHooksInstall.setState({ status: null, pending: false, error: null }) })

  it('未安装：显示「未安装」与「安装」按钮', () => {
    useHooksInstall.setState({ status: NOT_INSTALLED })
    render(<HooksSection />)
    expect(screen.getByText(/未安装/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy()
  })

  it('待更新：显示「待更新」与「更新」按钮', () => {
    useHooksInstall.setState({ status: OUTDATED })
    render(<HooksSection />)
    expect(screen.getByText(/待更新/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '更新' })).toBeTruthy()
  })

  it('已安装：显示「已安装」与「卸载」按钮', () => {
    useHooksInstall.setState({ status: UP_TO_DATE })
    render(<HooksSection />)
    expect(screen.getByText(/已安装/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '卸载' })).toBeTruthy()
  })
})
