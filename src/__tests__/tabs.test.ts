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
