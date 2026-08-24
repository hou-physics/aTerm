import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-9'),
  ptyIsAlive: vi.fn(async () => true),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
}))
import * as ipc from '../ipc'
import { useTabs } from '../store/tabs'

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页' }], activeId: 'home' })
  vi.clearAllMocks()
})

describe('useTabs', () => {
  it('openTerminal 生成 term 标签并激活', async () => {
    await useTabs.getState().openTerminal({ title: '修复登录', cwd: '/tmp/p', inject: 'claude --resume abc' })
    const { tabs, activeId } = useTabs.getState()
    expect(tabs).toHaveLength(2)
    expect(tabs[1]).toMatchObject({ kind: 'term', title: '修复登录', ptyId: 'pty-9' })
    expect(activeId).toBe(tabs[1].id)
    expect(ipc.ptySpawn).toHaveBeenCalledWith({ cwd: '/tmp/p', inject: 'claude --resume abc', cols: 80, rows: 24 })
  })
  it('closeTab：存活 PTY 需确认，拒绝则不关', async () => {
    await useTabs.getState().openTerminal({ title: 't' })
    const id = useTabs.getState().tabs[1].id
    await useTabs.getState().closeTab(id, async () => false)
    expect(useTabs.getState().tabs).toHaveLength(2)
    await useTabs.getState().closeTab(id, async () => true)
    expect(useTabs.getState().tabs).toHaveLength(1)
    expect(ipc.ptyKill).toHaveBeenCalledWith('pty-9')
    expect(useTabs.getState().activeId).toBe('home')
  })
  it('home 不可关闭', async () => {
    await useTabs.getState().closeTab('home', async () => true)
    expect(useTabs.getState().tabs).toHaveLength(1)
  })
})
