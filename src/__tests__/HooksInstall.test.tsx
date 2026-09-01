import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HooksStatus, InstallOutcome, UninstallOutcome } from '../ipc'

// 真实组件 + 真实 store（不 mock store/hooksInstall 本身），只 mock ipc 边界——与
// statusUI.test.tsx 同一思路：验证的是"状态真的到达后，DOM 真的按预期变化"，不是
// "某个函数被调用过"。
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

function mockLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  const ls = {
    getItem: vi.fn((k: string) => (store.has(k) ? store.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => { store.set(k, v) }),
    removeItem: vi.fn((k: string) => { store.delete(k) }),
    clear: vi.fn(() => store.clear()),
  }
  vi.stubGlobal('localStorage', ls)
  return ls
}

// 每个用例都要一份全新的 store（否则模块级的初始 refresh() 只会在第一个用例里真正
// 执行一次），与 statusUI.test.tsx 的 freshModules() 同一手法。
async function freshComponents() {
  vi.resetModules()
  const hooksMod = await import('../store/hooksInstall')
  await hooksMod.hooksInstallReady
  const componentsMod = await import('../components/HooksInstall')
  return { ...hooksMod, ...componentsMod }
}

beforeEach(() => {
  hooksStatusMock.mockReset()
  installHooksMock.mockReset()
  uninstallHooksMock.mockReset()
  mockLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HooksPromptBar — 只在未安装/已过期时出现（spec §6）', () => {
  it('已安装且最新：不渲染提示条', async () => {
    hooksStatusMock.mockResolvedValueOnce(UP_TO_DATE)
    const { HooksPromptBar } = await freshComponents()

    render(<HooksPromptBar />)

    expect(screen.queryByRole('button', { name: '安装' })).toBeNull()
    expect(screen.queryByRole('button', { name: '更新' })).toBeNull()
  })

  it('未安装：渲染一句中文说明 + 「安装」按钮', async () => {
    hooksStatusMock.mockResolvedValueOnce(NOT_INSTALLED)
    const { HooksPromptBar } = await freshComponents()

    render(<HooksPromptBar />)

    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy()
    expect(screen.getByText(/不再依赖启发式猜测/)).toBeTruthy()
  })

  it('已安装但版本过期：文案与按钮都是「更新」而不是「安装」', async () => {
    hooksStatusMock.mockResolvedValueOnce(OUTDATED)
    const { HooksPromptBar } = await freshComponents()

    render(<HooksPromptBar />)

    expect(screen.getByRole('button', { name: '更新' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull()
    expect(screen.getByText(/版本已过期/)).toBeTruthy()
  })

  it('点击「安装」调用 install_hooks()，成功后状态刷新为已安装，提示条随之消失', async () => {
    hooksStatusMock.mockResolvedValueOnce(NOT_INSTALLED).mockResolvedValueOnce(UP_TO_DATE)
    installHooksMock.mockResolvedValueOnce({ backupPath: '/tmp/backup.bak' })
    const { HooksPromptBar } = await freshComponents()
    render(<HooksPromptBar />)

    fireEvent.click(screen.getByRole('button', { name: '安装' }))

    await waitFor(() => {
      expect(installHooksMock).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '安装' })).toBeNull()
    })
  })

  it('安装失败：提示条保留，原样展示后端返回的中文错误信息', async () => {
    const backendError = '找不到 /Users/x/.claude/settings.json，请先启动一次 Claude Code 让它生成这个文件，或手动创建后重试；未做任何修改。'
    hooksStatusMock.mockResolvedValueOnce(NOT_INSTALLED)
    installHooksMock.mockRejectedValueOnce(backendError)
    const { HooksPromptBar } = await freshComponents()
    render(<HooksPromptBar />)

    fireEvent.click(screen.getByRole('button', { name: '安装' }))

    await waitFor(() => {
      expect(screen.getByText(backendError)).toBeTruthy()
    })
    // 提示条本身仍在，且按钮恢复成可再次点击的「安装」（不是卡在"安装中…"）
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy()
  })

  it('关闭提示条后持久化到 localStorage；模拟重新加载后提示条仍保持隐藏', async () => {
    const ls = mockLocalStorage()
    hooksStatusMock.mockResolvedValue(NOT_INSTALLED)
    const first = await freshComponents()
    const { unmount } = render(<first.HooksPromptBar />)
    expect(screen.getByRole('button', { name: '安装' })).toBeTruthy()

    fireEvent.click(screen.getByLabelText('关闭提示'))

    expect(ls.setItem).toHaveBeenCalledWith('aterm-hooks-prompt-dismissed', '1')
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull()
    unmount()

    // 模拟重新加载：清空模块注册表、重新 import store + 组件；localStorage（同一个
    // stub，没有被 unstubAllGlobals）里的关闭记录依旧在，"重启后不再打扰"由此验证。
    const second = await freshComponents()
    render(<second.HooksPromptBar />)

    expect(screen.queryByRole('button', { name: '安装' })).toBeNull()
    expect(screen.queryByLabelText('关闭提示')).toBeNull() // 提示条整体没有渲染
  })
})

// HooksControl（设置区常驻手动入口）连同它这一整块测试已在 Task 5 删除：组件迁到
// settings/HooksSection.tsx（整体复制，行为/文案/状态标签逐字不变），三条「状态
// 展示」用例已经在 SettingsSections.test.tsx 的 HooksSection 描述块里有逐字等价的
// 覆盖（Task 4 就已经加上，与本文件删掉的三条只是渲染对象从 HooksControl 换成
// HooksSection）；「点击『卸载』调用 uninstall_hooks()」这条评审点名要求先迁移、
// 确认非恒真后才允许删除本处旧版——已迁入 SettingsSections.test.tsx 的 HooksSection
// 描述块，验证过程见 task-5-report.md。「提示条关闭后设置区入口仍可用」那条组合
// 用例没有迁移：它验证的是 HooksControl 不读 dismissed 字段，而 HooksSection 从
// HooksControl 整体复制而来，同样从未读取 dismissed（可查 settings/HooksSection.tsx
// 全文——没有任何地方出现这个标识符），这一点不是运行时行为、是组件从不消费该字段
// 这一结构性事实，不需要单独用例断言；HooksPromptBar 与 HooksSection 现在也不再
// 出现在同一处 DOM 里（前者在 HomePage.tsx，后者在 SettingsPanel.tsx），组合渲染
// 两者本身也不再反映真实使用场景。
