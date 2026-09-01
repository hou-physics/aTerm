import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TerminalSection } from '../components/settings/TerminalSection'
import { ProjectsSection } from '../components/settings/ProjectsSection'
import { HooksSection } from '../components/settings/HooksSection'
import { useLayout, WHEEL_MULTIPLIER_DEFAULT } from '../store/layout'
import { useLibrary } from '../store/library'
import { useHooksInstall } from '../store/hooksInstall'
import type { HooksStatus, InstallOutcome, UninstallOutcome } from '../ipc'

// 只给 HooksSection 的「点击『卸载』」用例用——其余用例（TerminalSection/
// ProjectsSection/HooksSection 的三条状态展示）都不触碰 ipc，mock 对它们无影响
// （store/layout.ts、store/library.ts、settings/TerminalSection.tsx、
// settings/ProjectsSection.tsx 均不 import '../ipc'）。
// 迁移自 src/__tests__/HooksInstall.test.tsx 的 HooksControl 描述块（评审要求：
// Task 5 删除 HooksControl 前，这条"点击按钮 → 调到 store action → 调到 IPC"的完整
// 路径必须先在 HooksSection 上落地，否则整个代码库会丢失这条路径的覆盖）。
const { hooksStatusMock, installHooksMock, uninstallHooksMock } = vi.hoisted(() => ({
  hooksStatusMock: vi.fn<() => Promise<HooksStatus>>(),
  installHooksMock: vi.fn<() => Promise<InstallOutcome>>(),
  uninstallHooksMock: vi.fn<() => Promise<UninstallOutcome>>(),
}))

vi.mock('../ipc', () => ({
  hooksStatus: hooksStatusMock,
  installHooks: installHooksMock,
  uninstallHooks: uninstallHooksMock,
}))

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
    // 直接改 store（不经滑块 DOM 事件）必须包 act()——否则触发的重渲染发生在
    // React 认知的更新批次之外，会打一条 act() 警告（brief 里评审已指出的缺陷）。
    act(() => { useLayout.getState().setWheelMultiplier(99) })
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

// Hooks 分区：直接摆 useHooksInstall 的状态（除下面「点击『卸载』」那条外，其余
// 用例不 mock ipc、不 resetModules）——hooksPhase 是纯函数，组件只读
// status/pending/error 三个字段，setState 覆盖后组件下一次渲染即拿到新状态，与
// TerminalSection/ProjectsSection 直接摆 useLayout/useLibrary 状态同一手法。三种
// phase 各自的文案/按钮见 src/components/settings/HooksSection.tsx 的 STATE_LABEL
// 与 src/store/hooksInstall.ts 的 hooksPhase 真实行为（HooksSection 原是从
// src/components/HooksInstall.tsx 的 HooksControl 复制而来，Task 5 删除
// HooksControl 后，HooksSection 就是唯一实现，不再是"复制品"）。
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
  beforeEach(() => {
    useHooksInstall.setState({ status: null, pending: false, error: null })
    hooksStatusMock.mockReset()
    installHooksMock.mockReset()
    uninstallHooksMock.mockReset()
  })

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

  // 迁移自 HooksInstall.test.tsx 的「HooksControl — 设置区常驻手动入口」描述块。
  // 与上面三条「状态展示」用例不同——那三条只断言渲染结果，从没点过按钮；这一条
  // 真正 fireEvent.click，验证完整的「点击 → useHooksInstall.uninstall() → ipc.
  // uninstallHooks() → 内部 refresh() → ipc.hooksStatus() → UI 按新状态刷新」链路，
  // 不 mock store 本身，只在 ipc 边界打桩（与原 HooksControl 测试同一手法）。
  it('点击「卸载」调用 uninstall_hooks()，随后状态按最新结果刷新', async () => {
    hooksStatusMock.mockResolvedValueOnce(NOT_INSTALLED)
    uninstallHooksMock.mockResolvedValueOnce({ backupPath: '/tmp/backup.bak', removed: true })
    useHooksInstall.setState({ status: UP_TO_DATE, pending: false, error: null })
    render(<HooksSection />)

    fireEvent.click(screen.getByRole('button', { name: '卸载' }))

    await waitFor(() => {
      expect(uninstallHooksMock).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(screen.getByText(/未安装/)).toBeTruthy()
      expect(screen.getByRole('button', { name: '安装' })).toBeTruthy()
    })
  })
})
