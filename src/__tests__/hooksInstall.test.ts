import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HooksStatus, InstallOutcome, UninstallOutcome } from '../ipc'

// 与 status.test.ts 同一套 hoisted mock + freshModule() 手法：hooksInstall.ts 在模块
// 加载时就会发起一次 hooks_status() 查询（见该文件顶部注释），vi.resetModules() 保证
// 每个用例拿到一份全新的 store，不被前一个用例遗留的状态污染。
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

function mockThrowingLocalStorage() {
  const ls = {
    getItem: vi.fn(() => { throw new Error('localStorage 不可用') }),
    setItem: vi.fn(() => { throw new Error('localStorage 不可用') }),
    removeItem: vi.fn(),
    clear: vi.fn(),
  }
  vi.stubGlobal('localStorage', ls)
  return ls
}

async function freshModule() {
  vi.resetModules()
  hooksStatusMock.mockClear()
  installHooksMock.mockClear()
  uninstallHooksMock.mockClear()
  const mod = await import('../store/hooksInstall')
  await mod.hooksInstallReady
  return mod
}

beforeEach(() => {
  mockLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('hooksPhase — 汇总 notification/stop 两个 hook 的 installed/upToDate', () => {
  it('status 为 null（尚未查到）：返回 null，不猜测', async () => {
    const { hooksPhase } = await freshModule()
    expect(hooksPhase(null)).toBeNull()
  })

  it('两个 hook 都未安装：notInstalled', async () => {
    const { hooksPhase } = await freshModule()
    expect(hooksPhase(NOT_INSTALLED)).toBe('notInstalled')
  })

  it('只有一个 hook 安装了：仍算 notInstalled（install_hooks 是幂等的，点安装会补全）', async () => {
    const { hooksPhase } = await freshModule()
    expect(hooksPhase({
      notification: { installed: true, upToDate: true },
      stop: { installed: false, upToDate: false },
    })).toBe('notInstalled')
  })

  it('都安装了，但至少一个不是最新：outdated', async () => {
    const { hooksPhase } = await freshModule()
    expect(hooksPhase(OUTDATED)).toBe('outdated')
  })

  it('都安装且都最新：upToDate', async () => {
    const { hooksPhase } = await freshModule()
    expect(hooksPhase(UP_TO_DATE)).toBe('upToDate')
  })
})

describe('store/hooksInstall — refresh（模块加载即查询一次，不轮询）', () => {
  it('模块加载时自动调用一次 hooks_status()，结果写入 status', async () => {
    hooksStatusMock.mockResolvedValueOnce(NOT_INSTALLED)
    const { useHooksInstall } = await freshModule()

    expect(hooksStatusMock).toHaveBeenCalledTimes(1)
    expect(useHooksInstall.getState().status).toEqual(NOT_INSTALLED)
  })

  it('hooks_status() 查询失败：不抛出、status 保持 null（不是"未安装"以外的任何猜测）', async () => {
    hooksStatusMock.mockRejectedValueOnce('IPC 层失败')
    const { useHooksInstall, hooksInstallReady } = await freshModule()

    await expect(hooksInstallReady).resolves.toBeUndefined() // 绝不 reject，见文件顶部注释
    expect(useHooksInstall.getState().status).toBeNull()
  })
})

describe('store/hooksInstall — install()', () => {
  it('成功：调用 install_hooks() 后自动 refresh 一次，pending 收尾为 false，error 清空', async () => {
    hooksStatusMock.mockResolvedValueOnce(NOT_INSTALLED).mockResolvedValueOnce(UP_TO_DATE)
    installHooksMock.mockResolvedValueOnce({ backupPath: '/tmp/backup.bak' })
    const { useHooksInstall } = await freshModule()

    const pendingDuring = useHooksInstall.getState().install()
    expect(useHooksInstall.getState().pending).toBe(true) // 请求发出后立即进入 pending
    await pendingDuring

    expect(installHooksMock).toHaveBeenCalledTimes(1)
    expect(hooksStatusMock).toHaveBeenCalledTimes(2) // 模块加载一次 + 安装成功后再一次
    expect(useHooksInstall.getState().pending).toBe(false)
    expect(useHooksInstall.getState().error).toBeNull()
    expect(useHooksInstall.getState().status).toEqual(UP_TO_DATE)
  })

  it('失败：error 原样保留后端返回的字符串（verbatim），不会再触发 refresh', async () => {
    const backendError = '找不到 /Users/x/.claude/settings.json，请先启动一次 Claude Code 让它生成这个文件，或手动创建后重试；未做任何修改。'
    hooksStatusMock.mockResolvedValueOnce(NOT_INSTALLED)
    installHooksMock.mockRejectedValueOnce(backendError)
    const { useHooksInstall } = await freshModule()

    await useHooksInstall.getState().install()

    expect(useHooksInstall.getState().error).toBe(backendError)
    expect(useHooksInstall.getState().pending).toBe(false)
    expect(hooksStatusMock).toHaveBeenCalledTimes(1) // 失败不触发额外 refresh
  })

  it('失败：拒绝值是 Error 实例时取 .message，同样不是 "[object Object]" 之类的乱码', async () => {
    hooksStatusMock.mockResolvedValueOnce(NOT_INSTALLED)
    installHooksMock.mockRejectedValueOnce(new Error('意外的传输层错误'))
    const { useHooksInstall } = await freshModule()

    await useHooksInstall.getState().install()

    expect(useHooksInstall.getState().error).toBe('意外的传输层错误')
  })
})

describe('store/hooksInstall — uninstall()', () => {
  it('成功：调用 uninstall_hooks() 后自动 refresh 一次', async () => {
    hooksStatusMock.mockResolvedValueOnce(UP_TO_DATE).mockResolvedValueOnce(NOT_INSTALLED)
    uninstallHooksMock.mockResolvedValueOnce({ backupPath: '/tmp/backup.bak', removed: true })
    const { useHooksInstall } = await freshModule()

    await useHooksInstall.getState().uninstall()

    expect(uninstallHooksMock).toHaveBeenCalledTimes(1)
    expect(useHooksInstall.getState().status).toEqual(NOT_INSTALLED)
    expect(useHooksInstall.getState().pending).toBe(false)
  })

  it('失败：error 原样保留后端返回的字符串', async () => {
    hooksStatusMock.mockResolvedValueOnce(UP_TO_DATE)
    uninstallHooksMock.mockRejectedValueOnce('settings.json 不是合法的 JSON，为避免损坏你的配置已放弃写入；文件未被改动。')
    const { useHooksInstall } = await freshModule()

    await useHooksInstall.getState().uninstall()

    expect(useHooksInstall.getState().error).toBe('settings.json 不是合法的 JSON，为避免损坏你的配置已放弃写入；文件未被改动。')
  })
})

describe('store/hooksInstall — dismiss（提示条关闭状态持久化）', () => {
  it('dismiss() 写入 localStorage 并更新内存状态', async () => {
    const ls = mockLocalStorage()
    hooksStatusMock.mockResolvedValueOnce(NOT_INSTALLED)
    const { useHooksInstall } = await freshModule()

    expect(useHooksInstall.getState().dismissed).toBe(false)
    useHooksInstall.getState().dismiss()

    expect(useHooksInstall.getState().dismissed).toBe(true)
    expect(ls.setItem).toHaveBeenCalledWith('aterm-hooks-prompt-dismissed', '1')
  })

  it('已持久化的关闭状态在下次模块加载（模拟重启）时作为初始值生效', async () => {
    mockLocalStorage({ 'aterm-hooks-prompt-dismissed': '1' })
    hooksStatusMock.mockResolvedValueOnce(NOT_INSTALLED)
    const { useHooksInstall } = await freshModule()

    expect(useHooksInstall.getState().dismissed).toBe(true)
  })

  it('dismiss() 不影响 install/uninstall 是否可调用——关闭提示条之后仍能手动安装', async () => {
    mockLocalStorage({ 'aterm-hooks-prompt-dismissed': '1' })
    hooksStatusMock.mockResolvedValueOnce(NOT_INSTALLED).mockResolvedValueOnce(UP_TO_DATE)
    installHooksMock.mockResolvedValueOnce({ backupPath: '/tmp/backup.bak' })
    const { useHooksInstall } = await freshModule()

    expect(useHooksInstall.getState().dismissed).toBe(true)
    await useHooksInstall.getState().install()

    expect(installHooksMock).toHaveBeenCalledTimes(1)
    expect(useHooksInstall.getState().status).toEqual(UP_TO_DATE)
  })

  it('localStorage 读取抛异常时降级为未关闭（dismissed = false）', async () => {
    mockThrowingLocalStorage()
    hooksStatusMock.mockResolvedValueOnce(NOT_INSTALLED)
    const { useHooksInstall } = await freshModule()

    expect(useHooksInstall.getState().dismissed).toBe(false)
  })

  it('localStorage 写入抛异常时 dismiss() 仍能更新内存状态，不抛错', async () => {
    mockThrowingLocalStorage()
    hooksStatusMock.mockResolvedValueOnce(NOT_INSTALLED)
    const { useHooksInstall } = await freshModule()

    expect(() => useHooksInstall.getState().dismiss()).not.toThrow()
    expect(useHooksInstall.getState().dismissed).toBe(true)
  })
})
