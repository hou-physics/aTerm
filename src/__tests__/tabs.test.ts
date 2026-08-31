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
import { buildPaneCloseConfirmMessage, buildTabCloseConfirmMessage, moveArrayItem, reorderInsertIndex, useTabs } from '../store/tabs'
import type { ThreadInfo } from '../ipc'
import { HOME_TAB, makePane, makeTermTab, makeThread } from './factories'
import { MAX_PANES } from '../paneLayout'
import { useOverviewStore } from '../store/overview'

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }], activeId: 'home' })
  useOverviewStore.setState({ order: {} })
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
    const threadA: ThreadInfo = makeThread({ rootKey: 'r1' })
    const threadB: ThreadInfo = makeThread({ rootKey: 'r1' })

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

// 拖放新建窗格（设计文档 §5-B 场景 B："从侧边栏拖入"）：insertPaneAt 与 addPane 同一套
// 上限/等分/标题规则，唯一区别是按下标而不是"某窗格右侧"插入——覆盖 addPane 表达不了
// 的"插在第一个窗格左边"（下标 0）这种落点。
describe('useTabs — insertPaneAt：按下标插入新窗格（拖放新建）', () => {
  it('插在下标 0（第一个窗格左边）：新窗格排在最前面，其余窗格顺序不变', () => {
    const p1 = makePane()
    const p2 = makePane()
    const tab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    const newId = useTabs.getState().insertPaneAt(tab.id, 0)

    expect(newId).toBeTruthy()
    const t = useTabs.getState().tabs.find((x) => x.id === tab.id)!
    expect(t.panes.map((p) => p.id)).toEqual([newId, p1.id, p2.id])
    expect(t.activePaneId).toBe(newId) // 新窗格立即成为焦点，供调用方紧接着 startPaneTerminal
    expect(t.paneWidths).toHaveLength(3)
    t.paneWidths!.forEach((w) => expect(w).toBeCloseTo(1 / 3))
    expect(t.title).toBe('3 个对话')
  })

  it('插在末尾下标：等同追加到数组末尾', () => {
    const p1 = makePane()
    const tab = makeTermTab({ panes: [p1], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    const newId = useTabs.getState().insertPaneAt(tab.id, 1)

    const t = useTabs.getState().tabs.find((x) => x.id === tab.id)!
    expect(t.panes.map((p) => p.id)).toEqual([p1.id, newId])
  })

  it('已有 3 个窗格时拒绝，返回 null，不改变任何状态', () => {
    const panes = [makePane(), makePane(), makePane()]
    const tab = makeTermTab({ panes, activePaneId: panes[0].id, paneWidths: [1 / 3, 1 / 3, 1 / 3] })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    const result = useTabs.getState().insertPaneAt(tab.id, 0)

    expect(result).toBeNull()
    const t = useTabs.getState().tabs.find((x) => x.id === tab.id)!
    expect(t.panes.map((p) => p.id)).toEqual(panes.map((p) => p.id))
    expect(t.activePaneId).toBe(panes[0].id)
  })

  it('对 home 标签或不存在的标签调用是空操作，返回 null', () => {
    useTabs.setState({ tabs: [HOME_TAB], activeId: 'home' })
    expect(useTabs.getState().insertPaneAt('home', 0)).toBeNull()
    expect(useTabs.getState().insertPaneAt('does-not-exist', 0)).toBeNull()
    expect(useTabs.getState().tabs).toHaveLength(1)
  })
})

// 跨标签移动窗格（设计文档 §5-B 场景 A："把已打开的标签拖进窗格区"）：核心不变量是
// 窗格对象的 id/ptyId 原样保留（见任务描述"terminal 层按 pane.id 做 key"），源标签
// 整体移除且不经过 closeTab 的确认流程。DOM 节点身份（xterm 实例不因移动被卸载重挂）
// 在 TerminalLayer.test.tsx 里用真实渲染的 <App> 单独验证；这里只测 store 状态本身。
describe('useTabs — movePanesToTab：跨标签移动窗格（拖拽落点）', () => {
  it('单窗格标签拖入另一个标签：pane 对象的 id/ptyId 原样不变，源标签被移除', () => {
    const sourcePane = makePane({ title: '源窗格' })
    const sourceTab = makeTermTab({ panes: [sourcePane], activePaneId: sourcePane.id })
    const targetPane = makePane({ title: '目标窗格' })
    const targetTab = makeTermTab({ panes: [targetPane], activePaneId: targetPane.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, targetTab], activeId: targetTab.id })
    const originalId = sourcePane.id
    const originalPtyId = sourcePane.ptyId

    const ok = useTabs.getState().movePanesToTab(sourceTab.id, targetTab.id, { paneId: targetPane.id, side: 'right' })

    expect(ok).toBe(true)
    expect(useTabs.getState().tabs.find((t) => t.id === sourceTab.id)).toBeUndefined() // 源标签整体移除
    const t = useTabs.getState().tabs.find((x) => x.id === targetTab.id)!
    expect(t.panes.map((p) => p.id)).toEqual([targetPane.id, sourcePane.id])
    const moved = t.panes.find((p) => p.id === originalId)!
    expect(moved.id).toBe(originalId) // id 原样不变
    expect(moved.ptyId).toBe(originalPtyId) // ptyId 原样不变（同一个 PTY，未重新 spawn）
    expect(moved.title).toBe('源窗格') // 整个 pane 对象原样保留，不是重新创建的
    expect(t.activePaneId).toBe(sourcePane.id) // 移入的窗格（源标签原焦点）成为新焦点
    expect(t.paneWidths).toEqual([0.5, 0.5])
    expect(t.title).toBe('2 个对话')
  })

  it('落点 side=left：插在目标窗格左边而不是右边', () => {
    const sourcePane = makePane()
    const sourceTab = makeTermTab({ panes: [sourcePane], activePaneId: sourcePane.id })
    const targetPane = makePane()
    const targetTab = makeTermTab({ panes: [targetPane], activePaneId: targetPane.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, targetTab], activeId: targetTab.id })

    useTabs.getState().movePanesToTab(sourceTab.id, targetTab.id, { paneId: targetPane.id, side: 'left' })

    const t = useTabs.getState().tabs.find((x) => x.id === targetTab.id)!
    expect(t.panes.map((p) => p.id)).toEqual([sourcePane.id, targetPane.id])
  })

  it('多窗格标签整体移动：全部窗格一起搬走，顺序保持不变，不做部分移动', () => {
    const s1 = makePane({ title: 'S1' })
    const s2 = makePane({ title: 'S2' })
    const sourceTab = makeTermTab({ panes: [s1, s2], activePaneId: s2.id })
    const targetPane = makePane()
    const targetTab = makeTermTab({ panes: [targetPane], activePaneId: targetPane.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, targetTab], activeId: targetTab.id })

    const ok = useTabs.getState().movePanesToTab(sourceTab.id, targetTab.id, { paneId: targetPane.id, side: 'right' })

    expect(ok).toBe(true)
    const t = useTabs.getState().tabs.find((x) => x.id === targetTab.id)!
    expect(t.panes.map((p) => p.id)).toEqual([targetPane.id, s1.id, s2.id]) // s1/s2 顺序不变
    expect(t.activePaneId).toBe(s2.id) // 源标签原焦点（s2）成为新焦点
    expect(t.paneWidths).toHaveLength(3)
  })

  it('移入后总数会超过上限（3）：拒绝，返回 false，两个标签都不受影响', () => {
    const s1 = makePane()
    const s2 = makePane()
    const sourceTab = makeTermTab({ panes: [s1, s2], activePaneId: s1.id })
    const t1 = makePane()
    const t2 = makePane()
    const targetTab = makeTermTab({ panes: [t1, t2], activePaneId: t1.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, targetTab], activeId: targetTab.id })

    const ok = useTabs.getState().movePanesToTab(sourceTab.id, targetTab.id, { paneId: t1.id, side: 'left' })

    expect(ok).toBe(false)
    expect(useTabs.getState().tabs.find((t) => t.id === sourceTab.id)).toBeTruthy() // 源标签还在
    const t = useTabs.getState().tabs.find((x) => x.id === targetTab.id)!
    expect(t.panes.map((p) => p.id)).toEqual([t1.id, t2.id]) // 目标标签未被改动
  })

  it('拖到自己标签的窗格区：no-op，不做任何状态变更（设计文档明确要求）', () => {
    const p1 = makePane()
    const p2 = makePane()
    const tab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })
    const before = useTabs.getState().tabs

    const ok = useTabs.getState().movePanesToTab(tab.id, tab.id, { paneId: p2.id, side: 'left' })

    expect(ok).toBe(false)
    expect(useTabs.getState().tabs).toBe(before) // 连数组引用都没变——真正的空操作
  })

  it('源/目标标签之一不存在，或是 home 标签：拒绝，不做任何状态变更', () => {
    const p1 = makePane()
    const tab = makeTermTab({ panes: [p1], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    expect(useTabs.getState().movePanesToTab('does-not-exist', tab.id, { paneId: p1.id, side: 'left' })).toBe(false)
    expect(useTabs.getState().movePanesToTab(tab.id, 'does-not-exist', { paneId: p1.id, side: 'left' })).toBe(false)
    expect(useTabs.getState().movePanesToTab('home', tab.id, { paneId: p1.id, side: 'left' })).toBe(false)
  })

  it('源标签恰好是当前激活标签时，移动后 activeId 跟随窗格转移到目标标签', () => {
    const sourcePane = makePane()
    const sourceTab = makeTermTab({ panes: [sourcePane], activePaneId: sourcePane.id })
    const targetPane = makePane()
    const targetTab = makeTermTab({ panes: [targetPane], activePaneId: targetPane.id })
    // 故意把 activeId 设成源标签（正常拖拽流程里不会发生，见 movePanesToTab 注释），
    // 验证这条兜底分支本身确实生效，不留一个死代码路径没被测到。
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, targetTab], activeId: sourceTab.id })

    useTabs.getState().movePanesToTab(sourceTab.id, targetTab.id, { paneId: targetPane.id, side: 'right' })

    expect(useTabs.getState().activeId).toBe(targetTab.id)
  })
})

// 拖到空槽窗格（本次修复的设计间隙）：目标窗格没有 ptyId 时，拖放应该"填充"这个
// 槽位（源标签全部窗格取代它的位置，总数不增）而不是像 movePanesToTab 那样在旁边
// "插入"（总数 +N）。核心不变量与 movePanesToTab 相同——被移动的 Pane 对象原样保留，
// 源标签整体移除；DOM 节点身份在 TerminalLayer.test.tsx 里单独验证，这里只测 store
// 状态本身。
describe('useTabs — fillEmptyPane：把源标签的全部窗格填进目标标签的空槽窗格', () => {
  it('目标窗格没有 ptyId：源窗格取代它的位置，结果窗格数等于目标原数（不增），pane id/ptyId 原样不变', () => {
    const sourcePane = makePane({ title: '源窗格' })
    const sourceTab = makeTermTab({ panes: [sourcePane], activePaneId: sourcePane.id })
    const keptPane = makePane({ title: '已有窗格' })
    const emptyPane = makePane({ ptyId: undefined, title: '新窗格' })
    const targetTab = makeTermTab({ panes: [keptPane, emptyPane], activePaneId: keptPane.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, targetTab], activeId: targetTab.id })
    const originalId = sourcePane.id
    const originalPtyId = sourcePane.ptyId

    const ok = useTabs.getState().fillEmptyPane(sourceTab.id, targetTab.id, emptyPane.id)

    expect(ok).toBe(true)
    expect(useTabs.getState().tabs.find((t) => t.id === sourceTab.id)).toBeUndefined() // 源标签整体移除
    const t = useTabs.getState().tabs.find((x) => x.id === targetTab.id)!
    expect(t.panes.map((p) => p.id)).toEqual([keptPane.id, sourcePane.id]) // 空槽被取代，位置不变
    expect(t.panes).toHaveLength(2) // 结果数 = 目标原数（2），不是 2-1+1=2 也不是 2+1=3 的巧合——见下一条用例
    const moved = t.panes.find((p) => p.id === originalId)!
    expect(moved.id).toBe(originalId)
    expect(moved.ptyId).toBe(originalPtyId) // ptyId 原样不变，未重新 spawn
    expect(moved.title).toBe('源窗格') // 整个 pane 对象原样保留
    expect(t.activePaneId).toBe(sourcePane.id) // 移入的窗格成为新焦点
    expect(t.paneWidths).toEqual([0.5, 0.5])
  })

  it('目标标签已有 2 个窗格（其中一个空槽），源标签 1 个窗格：结果数是 2，不是 3——填充不增加总数', () => {
    const sourcePane = makePane()
    const sourceTab = makeTermTab({ panes: [sourcePane], activePaneId: sourcePane.id })
    const keptPane = makePane()
    const emptyPane = makePane({ ptyId: undefined })
    const targetTab = makeTermTab({ panes: [keptPane, emptyPane], activePaneId: keptPane.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, targetTab], activeId: targetTab.id })

    const ok = useTabs.getState().fillEmptyPane(sourceTab.id, targetTab.id, emptyPane.id)

    expect(ok).toBe(true)
    expect(useTabs.getState().tabs.find((x) => x.id === targetTab.id)!.panes).toHaveLength(2)
  })

  it('多窗格标签整体填入：全部窗格一起取代空槽的位置，顺序保持不变', () => {
    const s1 = makePane({ title: 'S1' })
    const s2 = makePane({ title: 'S2' })
    const sourceTab = makeTermTab({ panes: [s1, s2], activePaneId: s2.id })
    const emptyPane = makePane({ ptyId: undefined })
    const targetTab = makeTermTab({ panes: [emptyPane], activePaneId: emptyPane.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, targetTab], activeId: targetTab.id })

    const ok = useTabs.getState().fillEmptyPane(sourceTab.id, targetTab.id, emptyPane.id)

    expect(ok).toBe(true)
    const t = useTabs.getState().tabs.find((x) => x.id === targetTab.id)!
    expect(t.panes.map((p) => p.id)).toEqual([s1.id, s2.id]) // s1/s2 顺序不变，空槽被整个替换掉
    expect(t.activePaneId).toBe(s2.id) // 源标签原焦点成为新焦点
  })

  it('目标窗格已有 ptyId（不是空槽）：拒绝，返回 false，不做任何状态变更', () => {
    const sourcePane = makePane()
    const sourceTab = makeTermTab({ panes: [sourcePane], activePaneId: sourcePane.id })
    const targetPane = makePane() // 有 ptyId
    const targetTab = makeTermTab({ panes: [targetPane], activePaneId: targetPane.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, targetTab], activeId: targetTab.id })
    const before = useTabs.getState().tabs

    const ok = useTabs.getState().fillEmptyPane(sourceTab.id, targetTab.id, targetPane.id)

    expect(ok).toBe(false)
    expect(useTabs.getState().tabs).toBe(before)
  })

  it('目标窗格不属于目标标签、源/目标标签之一不存在或非 term、源即目标：拒绝，返回 false', () => {
    const sourcePane = makePane()
    const sourceTab = makeTermTab({ panes: [sourcePane], activePaneId: sourcePane.id })
    const emptyPane = makePane({ ptyId: undefined })
    const targetTab = makeTermTab({ panes: [emptyPane], activePaneId: emptyPane.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, targetTab], activeId: targetTab.id })

    expect(useTabs.getState().fillEmptyPane(sourceTab.id, targetTab.id, 'not-a-real-pane')).toBe(false)
    expect(useTabs.getState().fillEmptyPane('does-not-exist', targetTab.id, emptyPane.id)).toBe(false)
    expect(useTabs.getState().fillEmptyPane(sourceTab.id, 'does-not-exist', emptyPane.id)).toBe(false)
    expect(useTabs.getState().fillEmptyPane('home', targetTab.id, emptyPane.id)).toBe(false)
    expect(useTabs.getState().fillEmptyPane(sourceTab.id, sourceTab.id, sourcePane.id)).toBe(false)
  })

  it('结果窗格数会超过上限（防御性兜底，正常流程调用方已用 previewPaneDrop 挡住）：拒绝，不做任何状态变更', () => {
    const s1 = makePane()
    const s2 = makePane()
    const s3 = makePane()
    const sourceTab = makeTermTab({ panes: [s1, s2, s3], activePaneId: s1.id }) // 3 个
    const emptyPane = makePane({ ptyId: undefined })
    const kept1 = makePane()
    const kept2 = makePane()
    const targetTab = makeTermTab({ panes: [kept1, kept2, emptyPane], activePaneId: kept1.id }) // 目标原本已是 3 个
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, targetTab], activeId: targetTab.id })
    const before = useTabs.getState().tabs

    // 结果数 = 3(目标) - 1(丢弃空槽) + 3(源) = 5 > MAX_PANES
    const ok = useTabs.getState().fillEmptyPane(sourceTab.id, targetTab.id, emptyPane.id)

    expect(ok).toBe(false)
    expect(useTabs.getState().tabs).toBe(before)
  })
})

// 本次修复（用户反馈"把标签拖进分屏后，标签名没有更新"）：deriveTabTitle 在六处
// "窗格数量变化"的调用点（insertPaneAtIndex/movePanesToTab/fillEmptyPane/
// detachPaneToNewTab/splitTabPanes/closePane）里其实早已逐一正确重算——上面
// fillEmptyPane 那个 describe 块的每条用例都从未断言过 `.title`，这里补上，覆盖
// 用户描述的具体路径：填充、插入、拆出窗格、关到剩一个、整体拆分。fillEmptyPane
// 本身"结果窗格数 = 目标原数"这条规则决定了——若填充前目标标签已经是多窗格
// （常见的"先 ⌘D 开一个空槽，再拖别的标签进来填"），填充前后都落在 deriveTabTitle
// 的"多窗格→固定文案"分支，字符串本就不含具体内容、填充前后完全相同——这是既有
// 多窗格标题惯例本身的表现（movePanesToTab 同样如此），不是标题没有重算；真正会
// 让标题文本发生变化的是"结果窗格数跨过 1 这条界线"（本描述块第一条用例）。
// 目前代码库里没有"用户重命名标签"这个功能（deriveTabTitle 顶部注释明确写着
// "不做'用户重命名'——不在本步骤范围"，全仓库也搜不到任何重命名入口），因此这里
// 不需要、也没有"保留用户自定义标题"这一分支要测。
describe('useTabs — 标题在窗格数变化后始终重算（fill/insert/detach/close/split 五条路径）', () => {
  it('fillEmptyPane：单空槽窗格标签被整个替换，标题从空槽占位符变为新内容的标题', () => {
    const emptyPane = makePane({ ptyId: undefined, title: '新窗格' })
    const targetTab = makeTermTab({ panes: [emptyPane], activePaneId: emptyPane.id, title: '新窗格' })
    const sourcePane = makePane({ title: '我的会话' })
    const sourceTab = makeTermTab({ panes: [sourcePane], activePaneId: sourcePane.id, title: '我的会话' })
    useTabs.setState({ tabs: [HOME_TAB, targetTab, sourceTab], activeId: targetTab.id })

    useTabs.getState().fillEmptyPane(sourceTab.id, targetTab.id, emptyPane.id)

    expect(useTabs.getState().tabs.find((t) => t.id === targetTab.id)!.title).toBe('我的会话')
  })

  it('fillEmptyPane：目标标签填充前后都停留在多窗格（结果数不变），标题按既有「N 个对话」惯例，与填充前文本相同——这是惯例本身，不是重算失效', () => {
    const kept = makePane({ title: '已有窗格' })
    const emptyPane = makePane({ ptyId: undefined, title: '新窗格' })
    const targetTab = makeTermTab({ panes: [kept, emptyPane], activePaneId: kept.id, title: '2 个对话' })
    const sourcePane = makePane({ title: '新内容' })
    const sourceTab = makeTermTab({ panes: [sourcePane], activePaneId: sourcePane.id, title: '新内容' })
    useTabs.setState({ tabs: [HOME_TAB, targetTab, sourceTab], activeId: targetTab.id })

    useTabs.getState().fillEmptyPane(sourceTab.id, targetTab.id, emptyPane.id)

    const t = useTabs.getState().tabs.find((x) => x.id === targetTab.id)!
    expect(t.panes.map((p) => p.id)).toEqual([kept.id, sourcePane.id]) // 内容确实换了
    expect(t.title).toBe('2 个对话') // 标题按数量惯例重算，恰好与填充前文本相同
  })

  it('movePanesToTab（插在旁边）：单窗格标签变成两窗格，标题从原标题变为「2 个对话」', () => {
    const targetPane = makePane({ title: '原标题' })
    const targetTab = makeTermTab({ panes: [targetPane], activePaneId: targetPane.id, title: '原标题' })
    const sourcePane = makePane()
    const sourceTab = makeTermTab({ panes: [sourcePane], activePaneId: sourcePane.id })
    useTabs.setState({ tabs: [HOME_TAB, targetTab, sourceTab], activeId: targetTab.id })

    useTabs.getState().movePanesToTab(sourceTab.id, targetTab.id, { paneId: targetPane.id, side: 'right' })

    expect(useTabs.getState().tabs.find((t) => t.id === targetTab.id)!.title).toBe('2 个对话')
  })

  it('detachPaneToNewTab：拆出的新标签标题跟随该窗格自己的标题，原标签回到单窗格后标题也跟随剩下的窗格', () => {
    const p1 = makePane({ title: '窗格甲' })
    const p2 = makePane({ title: '窗格乙' })
    const sourceTab = makeTermTab({ panes: [p1, p2], activePaneId: p2.id, title: '2 个对话' })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab], activeId: sourceTab.id })

    const newTabId = useTabs.getState().detachPaneToNewTab(sourceTab.id, p2.id)

    expect(useTabs.getState().tabs.find((t) => t.id === newTabId)!.title).toBe('窗格乙')
    expect(useTabs.getState().tabs.find((t) => t.id === sourceTab.id)!.title).toBe('窗格甲')
  })

  it('closePane：从两窗格关到剩一个，标题从「2 个对话」变回剩下那个窗格自己的标题', async () => {
    const p1 = makePane({ title: 'A' })
    const p2 = makePane({ ptyId: undefined, title: 'B' })
    const tab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id, title: '2 个对话' })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    await useTabs.getState().closePane(tab.id, p2.id, async () => true)

    expect(useTabs.getState().tabs.find((t) => t.id === tab.id)!.title).toBe('A')
  })

  it('splitTabPanes：拆分出的每个新标签标题都跟随各自唯一窗格的标题，不是「N 个对话」的残留', () => {
    const p1 = makePane({ title: '窗格甲' })
    const p2 = makePane({ title: '窗格乙' })
    const sourceTab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id, title: '2 个对话' })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab], activeId: sourceTab.id })

    const newTabIds = useTabs.getState().splitTabPanes(sourceTab.id)!

    const titles = newTabIds.map((id) => useTabs.getState().tabs.find((t) => t.id === id)!.title)
    expect(titles).toEqual(['窗格甲', '窗格乙'])
  })
})

// 把窗格拖出成独立标签（设计文档 §5-C"拖出去/右键菜单"）：movePanesToTab 的反方向。
// 核心不变量同样是 pane 对象的 id/ptyId 原样保留——TerminalLayer.test.tsx 用真实渲染
// 的 <App> 单独验证 DOM 节点身份；这里只测 store 状态本身。
describe('useTabs — detachPaneToNewTab：把窗格拆出成独立标签（拖出去 / 右键菜单）', () => {
  it('多窗格标签拆出其中一个：新标签持有该窗格（id/ptyId 原样不变），源标签保留其余窗格并重新等分', () => {
    const p1 = makePane({ title: '窗格甲' })
    const p2 = makePane({ title: '窗格乙' })
    const sourceTab = makeTermTab({ panes: [p1, p2], activePaneId: p2.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab], activeId: sourceTab.id })
    const originalId = p2.id
    const originalPtyId = p2.ptyId

    const newTabId = useTabs.getState().detachPaneToNewTab(sourceTab.id, p2.id)

    expect(newTabId).toBeTruthy()
    const { tabs, activeId } = useTabs.getState()
    expect(activeId).toBe(newTabId) // 新标签成为激活标签

    const newTab = tabs.find((t) => t.id === newTabId)!
    expect(newTab.panes).toHaveLength(1)
    expect(newTab.panes[0].id).toBe(originalId) // id 原样不变
    expect(newTab.panes[0].ptyId).toBe(originalPtyId) // ptyId 原样不变，未重新 spawn
    expect(newTab.panes[0].title).toBe('窗格乙') // 整个 pane 对象原样保留
    expect(newTab.activePaneId).toBe(originalId) // 该窗格是新标签的焦点

    const source = tabs.find((t) => t.id === sourceTab.id)!
    expect(source.panes.map((p) => p.id)).toEqual([p1.id]) // 源标签只剩其余窗格
    expect(source.paneWidths).toEqual([1]) // 重新等分
    expect(source.title).toBe('窗格甲') // 回到单窗格，标题跟随剩下的窗格
    expect(source.activePaneId).toBe(p1.id) // 被拆出的正是原焦点窗格，焦点落到剩下的窗格
  })

  it('三窗格标签拆出中间一个：其余两个窗格顺序不变，重新等分为两半', () => {
    const p1 = makePane()
    const p2 = makePane()
    const p3 = makePane()
    const sourceTab = makeTermTab({ panes: [p1, p2, p3], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab], activeId: sourceTab.id })

    useTabs.getState().detachPaneToNewTab(sourceTab.id, p2.id)

    const source = useTabs.getState().tabs.find((t) => t.id === sourceTab.id)!
    expect(source.panes.map((p) => p.id)).toEqual([p1.id, p3.id])
    expect(source.paneWidths).toEqual([0.5, 0.5])
    expect(source.activePaneId).toBe(p1.id) // 拆出的不是焦点窗格，焦点原样不变
  })

  it('缺省 insertAt：新标签追加到 tabs 数组末尾', () => {
    const p1 = makePane()
    const p2 = makePane()
    const sourceTab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id })
    const otherTab = makeTermTab()
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, otherTab], activeId: sourceTab.id })

    const newTabId = useTabs.getState().detachPaneToNewTab(sourceTab.id, p2.id)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([HOME_TAB.id, sourceTab.id, otherTab.id, newTabId])
  })

  it('提供 insertAt：新标签插在该下标（拖到标签栏具体位置）', () => {
    const p1 = makePane()
    const p2 = makePane()
    const sourceTab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id })
    const otherTab = makeTermTab()
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, otherTab], activeId: sourceTab.id })

    const newTabId = useTabs.getState().detachPaneToNewTab(sourceTab.id, p2.id, 1)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([HOME_TAB.id, newTabId, sourceTab.id, otherTab.id])
  })

  it('insertAt 被 clamp 到至少 1：不能插在主页标签前面', () => {
    const p1 = makePane()
    const p2 = makePane()
    const sourceTab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab], activeId: sourceTab.id })

    const newTabId = useTabs.getState().detachPaneToNewTab(sourceTab.id, p2.id, 0)

    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([HOME_TAB.id, newTabId, sourceTab.id])
  })

  it('源标签只剩这一个窗格：no-op，返回 null，不做任何状态变更（不能拆出一个标签唯一的窗格）', () => {
    const p1 = makePane()
    const sourceTab = makeTermTab({ panes: [p1], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab], activeId: sourceTab.id })
    const before = useTabs.getState().tabs

    const result = useTabs.getState().detachPaneToNewTab(sourceTab.id, p1.id)

    expect(result).toBeNull()
    expect(useTabs.getState().tabs).toBe(before) // 连数组引用都没变
  })

  it('标签不存在、是 home 标签、或窗格不属于该标签：拒绝，返回 null', () => {
    const p1 = makePane()
    const p2 = makePane()
    const sourceTab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab], activeId: sourceTab.id })

    expect(useTabs.getState().detachPaneToNewTab('does-not-exist', p1.id)).toBeNull()
    expect(useTabs.getState().detachPaneToNewTab('home', p1.id)).toBeNull()
    expect(useTabs.getState().detachPaneToNewTab(sourceTab.id, 'not-a-real-pane')).toBeNull()
    expect(useTabs.getState().tabs.find((t) => t.id === sourceTab.id)!.panes).toHaveLength(2) // 未受影响
  })
})

// 标签栏右键菜单「拆分为独立标签」（把已合并的多窗格标签重新拆回一个个独立标签，
// movePanesToTab 的反方向——不是拆出"其中一个"，是全部拆开）：核心不变量同样是每个
// Pane 对象的 id/ptyId 原样保留。
describe('useTabs — splitTabPanes：把多窗格标签拆成 N 个独立标签（标签栏右键菜单）', () => {
  it('三窗格标签拆分：产生 3 个各持有一个窗格的新标签，id/ptyId 原样不变，原标签被替换', () => {
    const p1 = makePane({ title: '窗格甲' })
    const p2 = makePane({ title: '窗格乙' })
    const p3 = makePane({ title: '窗格丙' })
    const sourceTab = makeTermTab({ panes: [p1, p2, p3], activePaneId: p2.id })
    const otherTab = makeTermTab()
    useTabs.setState({ tabs: [HOME_TAB, sourceTab, otherTab], activeId: sourceTab.id })

    const newTabIds = useTabs.getState().splitTabPanes(sourceTab.id)

    expect(newTabIds).toHaveLength(3)
    const { tabs, activeId } = useTabs.getState()
    // 原标签被替换在原位，otherTab 的相对位置不受影响
    expect(tabs.map((t) => t.id)).toEqual([HOME_TAB.id, ...newTabIds!, otherTab.id])
    const [t1, t2, t3] = newTabIds!.map((id) => tabs.find((t) => t.id === id)!)
    expect(t1.panes).toEqual([{ id: p1.id, ptyId: p1.ptyId, title: p1.title }])
    expect(t2.panes).toEqual([{ id: p2.id, ptyId: p2.ptyId, title: p2.title }])
    expect(t3.panes).toEqual([{ id: p3.id, ptyId: p3.ptyId, title: p3.title }])
    expect(t1.activePaneId).toBe(p1.id)
    expect(t2.activePaneId).toBe(p2.id)
    expect(t3.activePaneId).toBe(p3.id)
    // 原本聚焦的是 p2，拆分后应聚焦 p2 所在的新标签
    expect(activeId).toBe(t2.id)
  })

  it('单窗格标签：no-op，返回 null，不做任何状态变更（菜单项本就不会渲染，这里是防御性兜底）', () => {
    const p1 = makePane()
    const sourceTab = makeTermTab({ panes: [p1], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, sourceTab], activeId: sourceTab.id })
    const before = useTabs.getState().tabs

    const result = useTabs.getState().splitTabPanes(sourceTab.id)

    expect(result).toBeNull()
    expect(useTabs.getState().tabs).toBe(before)
  })

  it('标签不存在，或是 home 标签：拒绝，返回 null', () => {
    useTabs.setState({ tabs: [HOME_TAB], activeId: 'home' })
    expect(useTabs.getState().splitTabPanes('does-not-exist')).toBeNull()
    expect(useTabs.getState().splitTabPanes('home')).toBeNull()
  })
})

// 标签拖拽排序用到的两个纯函数（见 store/tabs.ts 顶部注释）：reorderInsertIndex 把
// "光标落在哪两个标签中间"这个几何下标换算成"移除拖拽源之后"该插入的下标；
// moveArrayItem 是与业务无关的纯数组挪动。
describe('reorderInsertIndex：几何插入下标换算成"移除拖拽源自身后"的真实插入下标', () => {
  const order = ['home', 'a', 'b', 'c']

  it('目标下标小于源下标：不需要调整，原样返回（钳过 minIndex 之后）', () => {
    expect(reorderInsertIndex(order, 'c', 1)).toBe(1) // c 从下标3挪到1，之前的元素不受影响
  })
  it('目标下标大于源下标：移除源标签后同一条视觉缝隙对应的下标要向前挪一格', () => {
    expect(reorderInsertIndex(order, 'a', 3)).toBe(2) // a 从下标1挪到"原下标3那条缝"，移除a后是2
  })
  it('目标下标等于源下标：换算结果就是原地（调用方据此判断 no-op）', () => {
    expect(reorderInsertIndex(order, 'b', 2)).toBe(2)
  })
  it('钳住不能插到主页标签（下标 0）前面：rawTargetIndex 为 0 时至少是 minIndex（默认 1）', () => {
    expect(reorderInsertIndex(order, 'c', 0)).toBe(1)
  })
  it('sourceId 不在 order 里：退化为只做 minIndex/上限钳位，不做自身移除调整', () => {
    expect(reorderInsertIndex(order, 'not-there', 0)).toBe(1)
    expect(reorderInsertIndex(order, 'not-there', 99)).toBe(order.length)
  })
})

describe('moveArrayItem：纯数组挪动', () => {
  it('把元素从靠前的下标挪到靠后的下标，其余元素顺次补位', () => {
    expect(moveArrayItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })
  it('把元素从靠后的下标挪到靠前的下标', () => {
    expect(moveArrayItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })
  it('fromIndex === toIndex：原样返回同一个数组引用（no-op）', () => {
    const arr = ['a', 'b', 'c']
    expect(moveArrayItem(arr, 1, 1)).toBe(arr)
  })
  it('fromIndex 越界：原样返回同一个数组引用', () => {
    const arr = ['a', 'b', 'c']
    expect(moveArrayItem(arr, -1, 0)).toBe(arr)
    expect(moveArrayItem(arr, 3, 0)).toBe(arr)
  })
})

// 标签栏右键菜单是「拆分为独立标签」，拖拽排序则是"标签栏内拖动标签本身"（与拖去
// 合并进窗格区是同一次手势的两个落点分支，交互层面的接线在 TabBar.test.tsx）：这里
// 只测 store 方法本身的状态变更。
describe('useTabs — reorderTab：标签拖拽排序（纯数组挪动落盘）', () => {
  it('把靠后的标签挪到靠前的位置', () => {
    const a = makeTermTab({ title: 'A' })
    const b = makeTermTab({ title: 'B' })
    const c = makeTermTab({ title: 'C' })
    useTabs.setState({ tabs: [HOME_TAB, a, b, c], activeId: a.id })

    const ok = useTabs.getState().reorderTab(c.id, 1)

    expect(ok).toBe(true)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([HOME_TAB.id, c.id, a.id, b.id])
  })

  it('主页标签：拒绝，返回 false，不做任何状态变更', () => {
    const a = makeTermTab()
    useTabs.setState({ tabs: [HOME_TAB, a], activeId: a.id })
    const before = useTabs.getState().tabs

    const ok = useTabs.getState().reorderTab('home', 1)

    expect(ok).toBe(false)
    expect(useTabs.getState().tabs).toBe(before)
  })

  it('不存在的标签：拒绝，返回 false，不做任何状态变更', () => {
    const a = makeTermTab()
    useTabs.setState({ tabs: [HOME_TAB, a], activeId: a.id })
    const before = useTabs.getState().tabs

    const ok = useTabs.getState().reorderTab('does-not-exist', 1)

    expect(ok).toBe(false)
    expect(useTabs.getState().tabs).toBe(before)
  })

  it('目标下标钳到 0（试图插到主页标签前面）：实际落在主页之后，不会顶替主页', () => {
    const a = makeTermTab()
    const b = makeTermTab()
    useTabs.setState({ tabs: [HOME_TAB, a, b], activeId: a.id })

    useTabs.getState().reorderTab(b.id, 0)

    const ids = useTabs.getState().tabs.map((t) => t.id)
    expect(ids[0]).toBe(HOME_TAB.id) // 主页恒排第一，未被顶替
    expect(ids).toEqual([HOME_TAB.id, b.id, a.id])
  })

  it('换算后落回原位：no-op，连数组引用都不变', () => {
    const a = makeTermTab()
    const b = makeTermTab()
    useTabs.setState({ tabs: [HOME_TAB, a, b], activeId: a.id })
    const before = useTabs.getState().tabs

    // a 目前在下标 1；rawTargetIndex=1 换算后（reorderInsertIndex：1 不大于 srcIdx 1，
    // 原样返回 1）就是原地
    const ok = useTabs.getState().reorderTab(a.id, 1)

    expect(ok).toBe(false)
    expect(useTabs.getState().tabs).toBe(before)
  })
})

// 同标签内拖动窗格标题栏：用户描述的"交换位置"诉求（我拖一个框到右边，两个位置就都
// 自动交换），落地成"把源窗格移到目标窗格当前所在的下标"——两个窗格时这就是严格
// 对调，就是用户描述的效果；三个及以上窗格时是顺次插入（见 TabPanes.tsx 接线处的
// 详细论证）。targetPaneId 是目标窗格的 id 本身，不再是 {paneId, side} 那种带半侧
// 语义的落点——上一轮直接复用了给"跨标签插入新窗格"设计的 resolveDropTarget，产生
// 了用户真机验收报告的"只有拖到某个 critical 位置才能成功"的缺陷（见 paneDrop.ts
// 里 resolveReorderTarget 的注释与 .superpowers/sdd/reorder-and-toggle-fix-report.md）。
// 交互层接线（含"左半/右半/正中结果一致"这条直接对应用户报告的回归用例）在
// PaneDetach.test.tsx。
describe('useTabs — reorderPane：同标签内拖动窗格标题栏按落点重排', () => {
  it('两个窗格：拖 p1 到 p2 身上——对调，下标与 paneWidths 都跟着换，焦点仍是被拖的 p1', () => {
    const p1 = makePane({ title: 'P1' })
    const p2 = makePane({ title: 'P2' })
    const tab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id, paneWidths: [0.4, 0.6] })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    const ok = useTabs.getState().reorderPane(tab.id, p1.id, p2.id)

    expect(ok).toBe(true)
    const t = useTabs.getState().tabs.find((x) => x.id === tab.id)!
    expect(t.panes.map((p) => p.id)).toEqual([p2.id, p1.id])
    expect(t.paneWidths).toEqual([0.6, 0.4])
    expect(t.activePaneId).toBe(p1.id) // 换了位置，但仍是焦点
  })

  it('三个窗格：把第一个拖到第三个身上——顺次前移成 2,3,1，不是与最后一个对调，paneWidths 跟随', () => {
    const p1 = makePane({ title: 'P1' })
    const p2 = makePane({ title: 'P2' })
    const p3 = makePane({ title: 'P3' })
    const tab = makeTermTab({ panes: [p1, p2, p3], activePaneId: p1.id, paneWidths: [0.2, 0.3, 0.5] })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    const ok = useTabs.getState().reorderPane(tab.id, p1.id, p3.id)

    expect(ok).toBe(true)
    const t = useTabs.getState().tabs.find((x) => x.id === tab.id)!
    expect(t.panes.map((p) => p.id)).toEqual([p2.id, p3.id, p1.id])
    expect(t.paneWidths).toEqual([0.3, 0.5, 0.2])
    expect(t.activePaneId).toBe(p1.id)
  })

  it('拖到自己身上：no-op，返回 false，tabs 引用不变', () => {
    const p1 = makePane()
    const p2 = makePane()
    const tab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id, paneWidths: [0.5, 0.5] })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })
    const before = useTabs.getState().tabs

    const ok = useTabs.getState().reorderPane(tab.id, p1.id, p1.id)

    expect(ok).toBe(false)
    expect(useTabs.getState().tabs).toBe(before)
  })

  it('非 term 标签 / 找不到标签 / 找不到源窗格 / 找不到目标窗格：拒绝，返回 false', () => {
    const p1 = makePane()
    const tab = makeTermTab({ panes: [p1], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    expect(useTabs.getState().reorderPane('home', p1.id, p1.id)).toBe(false)
    expect(useTabs.getState().reorderPane('does-not-exist', p1.id, p1.id)).toBe(false)
    expect(useTabs.getState().reorderPane(tab.id, 'does-not-exist', p1.id)).toBe(false)
    expect(useTabs.getState().reorderPane(tab.id, p1.id, 'does-not-exist')).toBe(false)
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

  it('paneId 不属于该标签（陈旧/写错的 id）：即使标签只剩一个窗格，也不会误关整个标签', async () => {
    const p1 = makePane()
    const tab = makeTermTab({ panes: [p1], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })
    const confirmFn = vi.fn(async () => true)

    await useTabs.getState().closePane(tab.id, 'pane-does-not-exist', confirmFn)

    expect(confirmFn).not.toHaveBeenCalled()
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    const t = useTabs.getState().tabs.find((x) => x.id === tab.id)
    expect(t).toBeTruthy() // 标签仍在，没有被误关
    expect(t!.panes.map((p) => p.id)).toEqual([p1.id])
  })
})

describe('useTabs — closeTab：多窗格标签的集成关闭流程（弹窗文案报数与精确 kill 目标）', () => {
  it('3 窗格、2 个存活 PTY：确认文案报数为 2（不是 3 也不是 1），确认后只 kill 这 2 个 PTY', async () => {
    vi.mocked(ipc.ptyIsAlive).mockResolvedValue(true)
    const p1 = makePane() // 有 ptyId，存活
    const p2 = makePane() // 有 ptyId，存活
    const p3 = makePane({ ptyId: undefined }) // 待选窗格，从未 spawn，天然不算存活
    const tab = makeTermTab({ panes: [p1, p2, p3], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })
    const confirmFn = vi.fn(async () => true)

    await useTabs.getState().closeTab(tab.id, confirmFn)

    expect(confirmFn).toHaveBeenCalledTimes(1)
    expect(confirmFn).toHaveBeenCalledWith(buildTabCloseConfirmMessage(2))
    expect(ipc.ptyKill).toHaveBeenCalledTimes(2)
    expect(ipc.ptyKill).toHaveBeenCalledWith(p1.ptyId)
    expect(ipc.ptyKill).toHaveBeenCalledWith(p2.ptyId)
    expect(useTabs.getState().tabs.find((x) => x.id === tab.id)).toBeUndefined() // 整个标签被移除
  })

  it('拒绝确认：不 kill 任何 PTY，标签与其全部窗格原样保留', async () => {
    vi.mocked(ipc.ptyIsAlive).mockResolvedValue(true)
    const p1 = makePane()
    const p2 = makePane()
    const p3 = makePane({ ptyId: undefined })
    const tab = makeTermTab({ panes: [p1, p2, p3], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })

    await useTabs.getState().closeTab(tab.id, async () => false)

    expect(ipc.ptyKill).not.toHaveBeenCalled()
    const t = useTabs.getState().tabs.find((x) => x.id === tab.id)
    expect(t).toBeTruthy()
    expect(t!.panes.map((p) => p.id)).toEqual([p1.id, p2.id, p3.id])
  })

  it('全部窗格都没有存活 PTY：不弹确认，直接关闭', async () => {
    const p1 = makePane({ ptyId: undefined })
    const p2 = makePane({ ptyId: undefined })
    const tab = makeTermTab({ panes: [p1, p2], activePaneId: p1.id })
    useTabs.setState({ tabs: [HOME_TAB, tab], activeId: tab.id })
    const confirmFn = vi.fn(async () => true)

    await useTabs.getState().closeTab(tab.id, confirmFn)

    expect(confirmFn).not.toHaveBeenCalled()
    expect(ipc.ptyIsAlive).not.toHaveBeenCalled()
    expect(ipc.ptyKill).not.toHaveBeenCalled()
    expect(useTabs.getState().tabs.find((x) => x.id === tab.id)).toBeUndefined()
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

describe('overview 标签种类（spec §5.2）', () => {
  it('打开总览页创建 kind=overview 的标签，标题为「▦ 项目名·总览」，且无窗格', () => {
    useTabs.getState().openOverview('-Users-hou-astro-aTerm', 'aTerm')
    const ov = useTabs.getState().tabs.find((t) => t.kind === 'overview')!
    expect(ov).toBeDefined()
    expect(ov.title).toBe('▦ aTerm·总览')
    expect(ov.panes).toEqual([])
    expect(useTabs.getState().activeId).toBe(ov.id)
  })

  it('同一项目重复打开只聚焦已有总览标签，不新建', () => {
    useTabs.getState().openOverview('-dir-a', 'A')
    const firstId = useTabs.getState().tabs.find((t) => t.kind === 'overview')!.id
    useTabs.setState({ activeId: 'home' })
    useTabs.getState().openOverview('-dir-a', 'A')
    expect(useTabs.getState().tabs.filter((t) => t.kind === 'overview')).toHaveLength(1)
    expect(useTabs.getState().activeId).toBe(firstId)
  })

  it('不同项目各有自己的总览标签', () => {
    useTabs.getState().openOverview('-dir-a', 'A')
    useTabs.getState().openOverview('-dir-b', 'B')
    expect(useTabs.getState().tabs.filter((t) => t.kind === 'overview')).toHaveLength(2)
  })

  // closeTab 的 kind === 'home' 守卫问的是"是不是主页"，不是"有没有窗格"：总览标签
  // 同样没有窗格，但它必须可关闭。若把那一行误写成"没有窗格就不给关"，总览标签会和
  // 主页一起被挡住，点 × 不会有任何效果——这条测试直接钉住正确行为。
  it('总览标签可以被关闭——closeTab 对它不是空操作', async () => {
    useTabs.getState().openOverview('-dir-a', 'A')
    const ov = useTabs.getState().tabs.find((t) => t.kind === 'overview')!
    await useTabs.getState().closeTab(ov.id)
    expect(useTabs.getState().tabs.find((t) => t.id === ov.id)).toBeUndefined()
  })
})

describe('openOverview 与排序快照的交互（Task 4 ruling：新建总览标签清快照，聚焦已有的不清）', () => {
  it('新建总览标签时清除该项目的排序快照', () => {
    useOverviewStore.getState().captureOrder('-dir-a', [{ rootKey: 'r1', lastActivityMs: 1 }])
    expect(useOverviewStore.getState().order['-dir-a']).toBeDefined()

    useTabs.getState().openOverview('-dir-a', 'A')

    expect(useOverviewStore.getState().order['-dir-a']).toBeUndefined()
  })

  it('聚焦已有总览标签时不清除排序快照', () => {
    useTabs.getState().openOverview('-dir-a', 'A')
    useOverviewStore.getState().captureOrder('-dir-a', [{ rootKey: 'r1', lastActivityMs: 1 }])
    const snapshot = useOverviewStore.getState().order['-dir-a']

    useTabs.setState({ activeId: 'home' })
    useTabs.getState().openOverview('-dir-a', 'A') // 已存在，只聚焦

    expect(useOverviewStore.getState().order['-dir-a']).toEqual(snapshot)
  })
})
