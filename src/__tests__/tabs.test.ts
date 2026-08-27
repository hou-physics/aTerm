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
import { buildPaneCloseConfirmMessage, buildTabCloseConfirmMessage, useTabs } from '../store/tabs'
import type { ThreadInfo } from '../ipc'
import { HOME_TAB, makePane, makeTermTab } from './factories'
import { MAX_PANES } from '../paneLayout'

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

// 分屏第二步（真正的多窗格能力）：见
// docs/superpowers/specs/2026-08-27-split-view-design.md §2、§3、§6。
describe('useTabs — addPane：新建窗格上限与等分', () => {
  it('从 1 个窗格新建到 3 个，占比始终保持等分，标题在多窗格时变为「N 个对话」', () => {
    const tab = makeTermTab()
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    const ok1 = useTabs.getState().addPane(tab.id, tab.panes[0].id)
    expect(ok1).toBe(true)
    let t = useTabs.getState().tabs.find((x) => x.id === tab.id)!
    expect(t.panes).toHaveLength(2)
    expect(t.paneWidths).toEqual([0.5, 0.5])
    expect(t.title).toBe('2 个对话')
    // 新窗格插在"指定窗格右侧"，且立即成为焦点窗格（待用户在选择器里选定会话）
    expect(t.activePaneId).toBe(t.panes[1].id)
    expect(t.panes[1].ptyId).toBeUndefined() // 未选定前不占用 PTY

    const ok2 = useTabs.getState().addPane(tab.id, t.panes[0].id)
    expect(ok2).toBe(true)
    t = useTabs.getState().tabs.find((x) => x.id === tab.id)!
    expect(t.panes).toHaveLength(3)
    expect(t.paneWidths).toHaveLength(3)
    t.paneWidths!.forEach((w) => expect(w).toBeCloseTo(1 / 3))
    // 插入点在 panes[0] 右侧，因此新窗格排在原 panes[0] 之后（原 panes[1] 之前）
    expect(t.panes.map((p) => p.id)).toEqual([t.panes[0].id, t.activePaneId, t.panes[2].id])
  })

  it('已有 3 个窗格时拒绝第 4 个，不改变任何状态', () => {
    const panes = [makePane(), makePane(), makePane()]
    const tab = makeTermTab({ panes, activePaneId: panes[0].id, paneWidths: [1 / 3, 1 / 3, 1 / 3] })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })
    expect(tab.panes).toHaveLength(MAX_PANES)

    const ok = useTabs.getState().addPane(tab.id, panes[0].id)

    expect(ok).toBe(false)
    const t = useTabs.getState().tabs.find((x) => x.id === tab.id)!
    expect(t.panes).toHaveLength(3)
    expect(t.panes.map((p) => p.id)).toEqual(panes.map((p) => p.id))
    expect(t.activePaneId).toBe(panes[0].id) // 未被拒绝的调用意外改动焦点
  })

  it('对 home 标签或不存在的标签调用 addPane 是空操作，返回 false', () => {
    useTabs.setState({ tabs: [HOME_TAB], activeId: 'home' })
    expect(useTabs.getState().addPane('home', 'nope')).toBe(false)
    expect(useTabs.getState().addPane('does-not-exist', 'nope')).toBe(false)
    expect(useTabs.getState().tabs).toHaveLength(1)
  })
})

describe('useTabs — startPaneTerminal：窗格选择器选定会话后补上终端', () => {
  it('为待选窗格 spawn 一个 PTY，填入标题/threadKey/dirName/rootKey', async () => {
    vi.mocked(ipc.ptySpawn).mockResolvedValueOnce('pty-picked')
    const base = makePane({ ptyId: undefined, title: '新窗格' })
    const tab = makeTermTab({ panes: [base], activePaneId: base.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    await useTabs.getState().startPaneTerminal(tab.id, base.id, {
      title: '修复登录', cwd: '/proj', inject: 'claude --resume abc', threadKey: 'proj:abc', dirName: 'proj', rootKey: 'abc',
    })

    const pane = useTabs.getState().tabs.find((t) => t.id === tab.id)!.panes[0]
    expect(pane).toMatchObject({ ptyId: 'pty-picked', title: '修复登录', threadKey: 'proj:abc', dirName: 'proj', rootKey: 'abc' })
    expect(ipc.ptySpawn).toHaveBeenCalledWith({ cwd: '/proj', inject: 'claude --resume abc', cols: 80, rows: 24 })
  })
})

describe('useTabs — closePane：关窗格 vs 关标签', () => {
  it('多窗格标签：关闭一个窗格不弹确认（该窗格从未 spawn 过 PTY），只从数组移除并重新等分', async () => {
    const p1 = makePane({ ptyId: undefined }) // 待选窗格，从未 spawn
    const p2 = makePane()
    const tab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })
    const confirmFn = vi.fn(async () => true)

    await useTabs.getState().closePane(tab.id, p1.id, confirmFn)

    expect(confirmFn).not.toHaveBeenCalled()
    const t = useTabs.getState().tabs.find((x) => x.id === tab.id)!
    expect(t.panes.map((p) => p.id)).toEqual([p2.id])
    expect(t.paneWidths).toEqual([1])
    expect(t.activePaneId).toBe(p2.id) // 关掉的正是焦点窗格，焦点转移到剩下那个
    expect(t.title).toBe(p2.title) // 回到单窗格，标题跟随剩下的窗格
  })

  it('多窗格标签：关闭一个存活 PTY 的窗格需要确认；拒绝则不关闭', async () => {
    vi.mocked(ipc.ptyIsAlive).mockResolvedValue(true)
    const p1 = makePane()
    const p2 = makePane()
    const tab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    await useTabs.getState().closePane(tab.id, p1.id, async () => false)
    expect(useTabs.getState().tabs.find((x) => x.id === tab.id)!.panes).toHaveLength(2)
    expect(ipc.ptyKill).not.toHaveBeenCalled()

    await useTabs.getState().closePane(tab.id, p1.id, async () => true)
    const t = useTabs.getState().tabs.find((x) => x.id === tab.id)!
    expect(t.panes.map((p) => p.id)).toEqual([p2.id])
    expect(ipc.ptyKill).toHaveBeenCalledWith(p1.ptyId)
  })

  it('关闭非焦点窗格时，焦点窗格保持不变', async () => {
    const p1 = makePane()
    const p2 = makePane({ ptyId: undefined })
    const tab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    await useTabs.getState().closePane(tab.id, p2.id, async () => true)

    const t = useTabs.getState().tabs.find((x) => x.id === tab.id)!
    expect(t.activePaneId).toBe(p1.id)
    expect(t.panes.map((p) => p.id)).toEqual([p1.id])
  })

  it('标签只剩一个窗格时，closePane 等同 closeTab（沿用其确认与整标签移除）', async () => {
    vi.mocked(ipc.ptyIsAlive).mockResolvedValue(true)
    const p1 = makePane()
    const tab = makeTermTab({ panes: [p1], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    await useTabs.getState().closePane(tab.id, p1.id, async () => false)
    expect(useTabs.getState().tabs.find((x) => x.id === tab.id)).toBeTruthy() // 拒绝确认，标签还在

    await useTabs.getState().closePane(tab.id, p1.id, async () => true)
    expect(useTabs.getState().tabs.find((x) => x.id === tab.id)).toBeUndefined() // 整个标签被关闭
    expect(useTabs.getState().activeId).toBe('home')
  })
})

describe('useTabs — focusPane：直接设置某标签的焦点窗格', () => {
  it('设置存在的窗格为焦点', () => {
    const p1 = makePane()
    const p2 = makePane()
    const tab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    useTabs.getState().focusPane(tab.id, p2.id)

    expect(useTabs.getState().tabs.find((x) => x.id === tab.id)!.activePaneId).toBe(p2.id)
  })

  it('目标窗格不存在时忽略，不改变 activePaneId', () => {
    const p1 = makePane()
    const tab = makeTermTab({ panes: [p1], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    useTabs.getState().focusPane(tab.id, 'not-a-real-pane')

    expect(useTabs.getState().tabs.find((x) => x.id === tab.id)!.activePaneId).toBe(p1.id)
  })
})

describe('useTabs — setPaneWidths：拖拽分隔条时的内存态占比更新', () => {
  it('更新指定标签的 paneWidths，不影响其他标签', () => {
    const tabA = makeTermTab({ panes: [makePane(), makePane()], paneWidths: [0.5, 0.5] })
    const tabB = makeTermTab({ panes: [makePane(), makePane()], paneWidths: [0.5, 0.5] })
    useTabs.setState({ tabs: [HOME_TAB, tabA, tabB], activeId: tabA.id })

    useTabs.getState().setPaneWidths(tabA.id, [0.7, 0.3])

    expect(useTabs.getState().tabs.find((t) => t.id === tabA.id)!.paneWidths).toEqual([0.7, 0.3])
    expect(useTabs.getState().tabs.find((t) => t.id === tabB.id)!.paneWidths).toEqual([0.5, 0.5])
  })
})

describe('useTabs — focusThread：同一会话可能被开在多个窗格时，优先命中当前激活标签', () => {
  it('激活标签内本身就有匹配的窗格：只切窗格焦点，不切标签（哪怕别的标签也有同一 threadKey）', () => {
    const paneOther = makePane({ threadKey: 'proj:dup' })
    const tabOther = makeTermTab({ panes: [paneOther], activePaneId: paneOther.id })
    const paneHere1 = makePane()
    const paneHere2 = makePane({ threadKey: 'proj:dup' })
    const tabHere = makeTermTab({ panes: [paneHere1, paneHere2], activePaneId: paneHere1.id })
    useTabs.setState({ tabs: [HOME_TAB, tabOther, tabHere], activeId: tabHere.id })

    const found = useTabs.getState().focusThread('proj:dup')

    expect(found).toBe(true)
    expect(useTabs.getState().activeId).toBe(tabHere.id) // 没有跳到 tabOther
    expect(useTabs.getState().tabs.find((t) => t.id === tabHere.id)!.activePaneId).toBe(paneHere2.id)
    expect(useTabs.getState().tabs.find((t) => t.id === tabOther.id)!.activePaneId).toBe(paneOther.id) // 未被触碰
  })

  it('激活标签内没有匹配时，退回遍历全部标签、命中第一个的原语义', () => {
    const paneA = makePane({ threadKey: 'proj:x' })
    const tabA = makeTermTab({ panes: [paneA], activePaneId: paneA.id })
    const paneB = makePane({ threadKey: 'proj:x' })
    const tabB = makeTermTab({ panes: [paneB], activePaneId: paneB.id })
    const paneHere = makePane() // 与目标 threadKey 无关
    const tabHere = makeTermTab({ panes: [paneHere], activePaneId: paneHere.id })
    useTabs.setState({ tabs: [HOME_TAB, tabA, tabB, tabHere], activeId: tabHere.id })

    const found = useTabs.getState().focusThread('proj:x')

    expect(found).toBe(true)
    expect(useTabs.getState().activeId).toBe(tabA.id) // 数组顺序里第一个命中的标签
  })
})

describe('buildTabCloseConfirmMessage / buildPaneCloseConfirmMessage（纯函数）', () => {
  it('关标签：0 或 1 个存活会话用固定单数写法（与原有文案字面一致，兼容既有断言习惯）', () => {
    expect(buildTabCloseConfirmMessage(1)).toBe('进程仍在运行，关闭标签将终止它。确认关闭？')
  })
  it('关标签：多个存活会话时报出具体数量', () => {
    expect(buildTabCloseConfirmMessage(3)).toBe('还有 3 个会话在运行，关闭标签将全部终止。确认关闭？')
  })
  it('关窗格：固定单数写法（一次只可能终止一个窗格自己的 PTY）', () => {
    expect(buildPaneCloseConfirmMessage()).toBe('进程仍在运行，关闭窗格将终止它。确认关闭？')
  })
})
