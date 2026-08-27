import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({
  ptySpawn: vi.fn(async () => 'pty-9'),
  ptyIsAlive: vi.fn(async () => true),
  ptyKill: vi.fn(async () => {}),
  listProjects: vi.fn(async () => []),
}))
vi.mock('../ptyBuffer', () => ({ ptyEventsReady: Promise.resolve(), attachPty: vi.fn() }))
import * as ipc from '../ipc'
import { resumeThread } from '../actions'
import { useTabs } from '../store/tabs'
import type { ThreadInfo } from '../ipc'

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  vi.clearAllMocks()
})

describe('useTabs', () => {
  it('openTerminal 生成 term 标签并激活', async () => {
    await useTabs.getState().openTerminal({ title: '修复登录', cwd: '/tmp/p', inject: 'claude --resume abc' })
    const { tabs, activeId } = useTabs.getState()
    expect(tabs).toHaveLength(2)
    // ptyId 现在挂在该标签唯一的 pane 上，不再直接挂在 Tab 上（见 store/tabs.ts 的 Pane 类型）。
    expect(tabs[1]).toMatchObject({ kind: 'term', title: '修复登录' })
    expect(tabs[1].panes[0]).toMatchObject({ ptyId: 'pty-9' })
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
  it('home 不可关闭（⌘W 作用于 home 时应为空操作，无需确认弹窗）', async () => {
    const confirmFn = vi.fn(async () => true)
    await useTabs.getState().closeTab('home', confirmFn)
    expect(useTabs.getState().tabs).toHaveLength(1)
    expect(useTabs.getState().activeId).toBe('home')
    expect(confirmFn).not.toHaveBeenCalled()
    expect(ipc.ptyKill).not.toHaveBeenCalled()
  })
  it('focusThread：已存在的 threadKey 激活原标签且不重新 spawn，未知 key 返回 false', async () => {
    // threadKey 采用「项目:会话」复合键格式（见 resumeThread），store 层本身按不透明字符串处理
    await useTabs.getState().openTerminal({ title: '修复登录', cwd: '/tmp/p', inject: 'claude --resume abc', threadKey: 'proj-a:thread-abc' })
    const tabId = useTabs.getState().tabs[1].id
    useTabs.getState().setActive('home')
    vi.clearAllMocks()

    const found = useTabs.getState().focusThread('proj-a:thread-abc')
    expect(found).toBe(true)
    expect(useTabs.getState().activeId).toBe(tabId)
    expect(useTabs.getState().tabs).toHaveLength(2)
    expect(ipc.ptySpawn).not.toHaveBeenCalled()

    const missing = useTabs.getState().focusThread('proj-b:thread-abc')
    expect(missing).toBe(false)
  })
  it('resumeThread：相同 rootKey 在不同项目下不互相误切，各自独立开标签', async () => {
    const threadA: ThreadInfo = { rootKey: 'r1', resumeSessionId: 'sid-a', title: '会话A', cwd: '/proj-a', lastActivityMs: 0, fileCount: 1 }
    const threadB: ThreadInfo = { rootKey: 'r1', resumeSessionId: 'sid-b', title: '会话B', cwd: '/proj-b', lastActivityMs: 0, fileCount: 1 }

    await resumeThread('proj-a', '/proj-a', threadA)
    await resumeThread('proj-b', '/proj-b', threadB)

    const { tabs } = useTabs.getState()
    expect(tabs).toHaveLength(3)
    // threadKey 现在挂在 pane 上（见上面 tabs[1]/tabs[2] 的 panes[0]），不再直接挂在 Tab 上。
    expect(tabs[1].panes[0].threadKey).toBe('proj-a:r1')
    expect(tabs[2].panes[0].threadKey).toBe('proj-b:r1')
    expect(ipc.ptySpawn).toHaveBeenCalledTimes(2)

    // 再次 resumeThread 同一项目同一 rootKey 应命中原标签而非新开
    vi.clearAllMocks()
    await resumeThread('proj-a', '/proj-a', threadA)
    expect(useTabs.getState().tabs).toHaveLength(3)
    expect(useTabs.getState().activeId).toBe(tabs[1].id)
    expect(ipc.ptySpawn).not.toHaveBeenCalled()
  })
})

// 分屏第一步（等价重构）新增的 pane 层测试：Tab 现在持有 panes 数组，但本步骤恒为 1 个，
// 见 docs/superpowers/specs/2026-08-27-split-view-design.md §2、§10。
describe('useTabs — pane 层（单窗格等价重构）', () => {
  it('openTerminal 生成的标签恰好持有一个 pane，并设置 activePaneId', async () => {
    await useTabs.getState().openTerminal({ title: '修复登录', cwd: '/tmp/p' })
    const tab = useTabs.getState().tabs[1]
    expect(tab.panes).toHaveLength(1)
    expect(tab.panes[0]).toMatchObject({ ptyId: 'pty-9', title: '修复登录' })
    expect(tab.activePaneId).toBe(tab.panes[0].id)
  })

  it('focusThread 命中非激活标签中的 pane 时，同时切换 activeId 与该标签的 activePaneId', async () => {
    await useTabs.getState().openTerminal({ title: 'A', cwd: '/tmp/a', threadKey: 'proj:a' })
    await useTabs.getState().openTerminal({ title: 'B', cwd: '/tmp/b', threadKey: 'proj:b' })
    const tabA = useTabs.getState().tabs[1]
    useTabs.getState().setActive('home') // 切到与 A、B 都无关的标签，确保 A 此刻不是激活标签
    vi.clearAllMocks()

    const found = useTabs.getState().focusThread('proj:a')
    expect(found).toBe(true)
    const { activeId, tabs } = useTabs.getState()
    expect(activeId).toBe(tabA.id)
    const refreshedTabA = tabs.find((t) => t.id === tabA.id)!
    expect(refreshedTabA.activePaneId).toBe(refreshedTabA.panes[0].id)
    expect(ipc.ptySpawn).not.toHaveBeenCalled() // 命中已有 pane，不重新 spawn
  })

  it('closeTab 终止该标签下 pane 的 PTY', async () => {
    await useTabs.getState().openTerminal({ title: 't' })
    const tab = useTabs.getState().tabs[1]
    const paneId = tab.panes[0].id
    const ptyId = tab.panes[0].ptyId
    expect(paneId).toBeTruthy()

    await useTabs.getState().closeTab(tab.id, async () => true)

    expect(ipc.ptyKill).toHaveBeenCalledWith(ptyId)
    expect(useTabs.getState().tabs.find((t) => t.id === tab.id)).toBeUndefined()
  })
})
