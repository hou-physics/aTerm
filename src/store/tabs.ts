import { create } from 'zustand'
import { ptyIsAlive, ptyKill, ptySpawn } from '../ipc'
import { equalPaneWidths, MAX_PANES } from '../paneLayout'
import { dropInsertionIndex, type DropTarget } from '../paneDrop'
import { ptyEventsReady } from '../ptyBuffer'

// Pane：标签内的单个终端会话。ptyId 缺省表示该窗格还没有终端——⌘D 新建的窗格先显示
// 会话选择器（见 components/PanePicker.tsx），选定后才通过 startPaneTerminal 补上
// ptyId，此前不占用任何 PTY 资源（设计文档 §5-A）。
export type Pane = { id: string; ptyId?: string; title: string; threadKey?: string; dirName?: string; rootKey?: string }
export type Tab = { id: string; kind: 'home' | 'term'; title: string; panes: Pane[]; activePaneId?: string; paneWidths?: number[] }
let nextTab = 1
let nextPane = 1

type ConfirmFn = (msg: string) => Promise<boolean>
async function dialogConfirm(msg: string): Promise<boolean> {
  const { confirm } = await import('@tauri-apps/plugin-dialog')
  return confirm(msg, { title: 'aTerm' })
}

// 标签标题：单窗格时跟随该唯一窗格的标题；多窗格时固定为「N 个对话」（设计文档 §2）。
// 每次 panes 数组结构变化（增删窗格）都要重算一遍；不做"用户重命名"（不在本步骤范围）。
function deriveTabTitle(panes: Pane[], fallback: string): string {
  if (panes.length <= 1) return panes[0]?.title ?? fallback
  return `${panes.length} 个对话`
}

// 关闭整个标签的确认文案：存活会话数决定单复数措辞。单窗格阶段固定用单数写法是
// step1 的简化（见 .superpowers/split-view-step1-report.md「给下一步的提醒」），
// 现在标签可以真的持有多个窗格、多个存活 PTY，需要如实报出数量。
export function buildTabCloseConfirmMessage(aliveCount: number): string {
  if (aliveCount <= 1) return '进程仍在运行，关闭标签将终止它。确认关闭？'
  return `还有 ${aliveCount} 个会话在运行，关闭标签将全部终止。确认关闭？`
}

// 关闭单个窗格（标签仍保留其余窗格）的确认文案：一次只可能终止这一个窗格自己的
// PTY，不需要像上面那样动态报数量。
export function buildPaneCloseConfirmMessage(): string {
  return '进程仍在运行，关闭窗格将终止它。确认关闭？'
}

// 内部共享：在 tabId 的 panes 数组下标 insertAt 处插入一个新的"待选窗格"（ptyId
// 缺省），重新等分、重算标题、并把新窗格设为焦点。addPane（⌘D，"插在某窗格右侧"）与
// insertPaneAt（拖放，"插在任意下标"，见设计文档 §5-B）两个公开方法各自算出 insertAt
// 后都委托给它，避免两处重复"建 pane 对象 + 等分 + 重算标题"这段逻辑。上限校验
// （数量，不关心像素宽度——像素宽度是否装得下由调用方在调用前用 paneLayout.ts 的
// decidePaneFit 自行判断，同 ⌘D 既有的把关方式）在这里做一次；不满足时原样返回
// 传入的 tabs（引用不变），paneId 为 null，调用方据此判断是否失败。
function insertPaneAtIndex(tabs: Tab[], tabId: string, insertAt: number): { tabs: Tab[]; paneId: string | null } {
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab || tab.kind !== 'term' || tab.panes.length >= MAX_PANES) return { tabs, paneId: null }
  const pane: Pane = { id: `pane-${nextPane++}`, title: '新窗格' }
  const clamped = Math.max(0, Math.min(insertAt, tab.panes.length))
  const nextTabs = tabs.map((t) => {
    if (t.id !== tabId) return t
    const panes = [...t.panes.slice(0, clamped), pane, ...t.panes.slice(clamped)]
    return { ...t, panes, activePaneId: pane.id, paneWidths: equalPaneWidths(panes.length), title: deriveTabTitle(panes, t.title) }
  })
  return { tabs: nextTabs, paneId: pane.id }
}

type TabsState = {
  tabs: Tab[]
  activeId: string
  setActive(id: string): void
  openTerminal(o: { title: string; cwd?: string; inject?: string; threadKey?: string; dirName?: string; rootKey?: string }): Promise<void>
  focusThread(threadKey: string): boolean
  closeTab(id: string, confirmFn?: ConfirmFn): Promise<void>
  addPane(tabId: string, afterPaneId: string): boolean
  insertPaneAt(tabId: string, index: number): string | null
  movePanesToTab(sourceTabId: string, targetTabId: string, target: DropTarget): boolean
  detachPaneToNewTab(tabId: string, paneId: string, insertAt?: number): string | null
  splitTabPanes(tabId: string): string[] | null
  startPaneTerminal(tabId: string, paneId: string, o: { title: string; cwd?: string; inject?: string; threadKey?: string; dirName?: string; rootKey?: string }): Promise<void>
  closePane(tabId: string, paneId: string, confirmFn?: ConfirmFn): Promise<void>
  focusPane(tabId: string, paneId: string): void
  setPaneWidths(tabId: string, widths: number[]): void
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }],
  activeId: 'home',
  setActive: (id) => set({ activeId: id }),
  openTerminal: async ({ title, cwd, inject, threadKey, dirName, rootKey }) => {
    await ptyEventsReady
    const ptyId = await ptySpawn({ cwd, inject, cols: 80, rows: 24 })
    const id = `tab-${nextTab++}`
    const pane: Pane = { id: `pane-${nextPane++}`, ptyId, title, threadKey, dirName, rootKey }
    set((s) => ({ tabs: [...s.tabs, { id, kind: 'term', title, panes: [pane], activePaneId: pane.id }], activeId: id }))
  },
  // 命中同一 threadKey 时优先匹配"当前激活标签"内的窗格：分屏后同一会话可能被手动
  // 开在多个窗格里（窗格选择器里"任一历史会话"不做去重，见 PanePicker.tsx），此时
  // 用户明明正盯着这个会话所在的窗格、再从侧边栏点一次同一会话，不该被跳去别的
  // 标签——只有激活标签内没有匹配时，才退回"遍历全部标签，命中第一个"的原语义
  // （标签顺序，找到即返回，不继续找同一 threadKey 的第二个匹配）。
  focusThread: (threadKey) => {
    const { tabs, activeId } = get()
    const activeTab = tabs.find((t) => t.id === activeId)
    const activeMatch = activeTab?.panes.find((p) => p.threadKey === threadKey)
    if (activeTab && activeMatch) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === activeTab.id ? { ...t, activePaneId: activeMatch.id } : t)),
      }))
      return true
    }
    for (const tab of tabs) {
      const pane = tab.panes.find((p) => p.threadKey === threadKey)
      if (pane) {
        set((s) => ({
          activeId: tab.id,
          tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, activePaneId: pane.id } : t)),
        }))
        return true
      }
    }
    return false
  },
  closeTab: async (id, confirmFn = dialogConfirm) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || tab.kind === 'home') return
    // 只收集"确实有 ptyId 且确认存活"的窗格——待选会话的窗格（ptyId 缺省）从未
    // spawn 过 PTY，天然算不存活，不需要也不能查询。
    const aliveIds: string[] = []
    for (const pane of tab.panes) {
      const ptyId = pane.ptyId
      if (ptyId && (await ptyIsAlive(ptyId))) aliveIds.push(ptyId)
    }
    if (aliveIds.length > 0) {
      const ok = await confirmFn(buildTabCloseConfirmMessage(aliveIds.length))
      if (!ok) return
      // 并发终止：标签现在最多可持有 3 个窗格，逐个 await 会不必要地串行化，
      // 互相独立的 kill 调用没有理由排队。
      await Promise.all(aliveIds.map((ptyId) => ptyKill(ptyId)))
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeId = s.activeId === id ? tabs[tabs.length - 1].id : s.activeId
      return { tabs, activeId }
    })
  },
  // 在 afterPaneId 右侧插入一个"待选会话"窗格（ptyId 缺省，见 Pane 类型注释）。
  // 已达上限（3 个）时拒绝并返回 false，不做任何改动——调用方（App.tsx 的 ⌘D
  // 处理器）据此给出提示；窄窗口下是否装得下由调用方在调用前用 paneLayout.ts 的
  // fitsPanes 自行判断，这里不关心像素宽度，只关心"数量"这一条硬上限。
  // 宽度按新窗格数重新等分——不做"保留旧比例、只给新窗格挤一块"这种更复杂的分配，
  // 与设计文档 §3"默认等分"的基调一致，也让"关闭窗格后占比重新分配"落在同一条
  // 规则里（两处都是"数量一变，直接回到等分"）。
  addPane: (tabId, afterPaneId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || tab.kind !== 'term') return false
    const idx = tab.panes.findIndex((p) => p.id === afterPaneId)
    const insertAt = idx === -1 ? tab.panes.length : idx + 1
    const { tabs, paneId } = insertPaneAtIndex(get().tabs, tabId, insertAt)
    if (!paneId) return false
    set({ tabs })
    return true
  },
  // 拖放新建窗格（设计文档 §5-B 场景 B："从侧边栏拖入"）：与 addPane 语义相同
  // （上限校验、等分、标题重算、新窗格立即成为焦点），只是插入位置由调用方直接给出
  // 数组下标——落点可能在最左侧（"插在第一个窗格左边"），addPane 的"插在某窗格
  // 右侧"表达不了这种情况，因此单独给一个按下标插入的入口。成功返回新窗格 id，
  // 供调用方（Sidebar.tsx 的拖拽处理器）紧接着调用 startPaneTerminal 填入真正的
  // 会话——"exactly as if it had been chosen through the ⌘D picker"；失败（已达
  // 上限）返回 null，不做任何状态变更。
  insertPaneAt: (tabId, index) => {
    const { tabs, paneId } = insertPaneAtIndex(get().tabs, tabId, index)
    if (!paneId) return null
    set({ tabs })
    return paneId
  },
  // 把源标签的全部窗格移入目标标签（设计文档 §5-B 场景 A："把已打开的标签拖进窗格
  // 区"）。窗格对象原样保留 id/ptyId 等全部字段——绝不重新创建，这是本次改动最
  // 关键的不变量：TerminalLayer.tsx 按 pane.id 做 key，只要 id 不变，React 就不会
  // 卸载重挂对应的 <TerminalView>，xterm 实例与其内部回滚缓冲因此不受影响（见
  // .superpowers/flat-mount-report.md）。源标签因此整体移除——它的全部窗格都已经
  // 搬去了目标标签，不剩任何东西——但这里不经过 closeTab："仍在运行则确认"那套
  // 逻辑是给"真的要终止 PTY"的场景准备的，这里没有任何 PTY 被终止，窗格只是换了
  // 个标签持有，不需要、也不应该弹确认。
  // 上限校验只看"总窗格数量"（不关心像素宽度，同 addPane/insertPaneAt），像素宽度
  // 是否装得下由调用方（TabBar.tsx 的拖拽处理器）在调用前用 paneLayout.ts 的
  // decidePaneFit 自行判断。以下情况返回 false 且不做任何状态变更：源/目标标签之一
  // 不存在或非 term 标签；源标签就是目标标签（"拖到自己标签的窗格区是空操作"，
  // 设计文档明确要求的 no-op）；移入后总窗格数会超过上限。
  movePanesToTab: (sourceTabId, targetTabId, target) => {
    if (sourceTabId === targetTabId) return false
    const { tabs } = get()
    const sourceTab = tabs.find((t) => t.id === sourceTabId)
    const targetTab = tabs.find((t) => t.id === targetTabId)
    if (!sourceTab || sourceTab.kind !== 'term' || !targetTab || targetTab.kind !== 'term') return false
    const movedPanes = sourceTab.panes
    if (movedPanes.length === 0) return false
    if (targetTab.panes.length + movedPanes.length > MAX_PANES) return false
    const insertAt = dropInsertionIndex(targetTab.panes.map((p) => p.id), target)
    // 焦点落到源标签原本的焦点窗格（拖拽前用户正盯着哪个窗格，移动后仍然盯着它）；
    // 源标签万一没有 activePaneId（理论上不应发生，term 标签恒有），退化为移动过来
    // 的第一个窗格。
    const focusPaneId = sourceTab.activePaneId ?? movedPanes[0].id
    set((s) => {
      const withoutSource = s.tabs.filter((t) => t.id !== sourceTabId)
      const nextTabs = withoutSource.map((t) => {
        if (t.id !== targetTabId) return t
        const panes = [...t.panes.slice(0, insertAt), ...movedPanes, ...t.panes.slice(insertAt)]
        return { ...t, panes, activePaneId: focusPaneId, paneWidths: equalPaneWidths(panes.length), title: deriveTabTitle(panes, t.title) }
      })
      // 源标签若恰好是当前激活标签（拖拽的落点只可能在激活标签的窗格区，见设计文档
      // §5-B——目标标签因此恒为激活标签，源标签不可能是激活标签，这条分支实际上
      // 总是假；保留它只是不假设调用方一定遵守这条前提，防止 activeId 指向一个
      // 已经被移除的标签）。
      const activeId = s.activeId === sourceTabId ? targetTabId : s.activeId
      return { tabs: nextTabs, activeId }
    })
    return true
  },
  // 把窗格从其所在标签拆出，独立成一个新标签（设计文档 §5-C"拖出去/右键菜单"，与
  // movePanesToTab 的"拖进来"互补，是用户明确要求的反向操作）。窗格对象原样保留、
  // 绝不重新创建——与 movePanesToTab 同一个最关键的不变量：TerminalLayer.tsx 按
  // pane.id 做 key，id 不变就不会卸载重挂对应的 <TerminalView>，xterm 实例与其内部
  // 回滚缓冲因此不受影响。
  // 源标签只剩这一个窗格时是空操作（"窗格已经是独立标签，没有什么可拆的"，也是
  // 设计文档明确要求的 no-op）：不产生任何状态变更，返回 null；调用方（拖拽处理器/
  // 右键菜单）据此判断。源标签移除该窗格后就地保留（不像 movePanesToTab 里源标签会
  // 整体消失——那里是"移空"，这里源标签至少还剩一个），按 closePane 同一套规则重新
  // 等分、重算标题、若被移出的窗格恰是焦点窗格则焦点落到同一位置（原下标，超出则退到
  // 新的最后一个）。
  // insertAt 缺省时新标签追加到 tabs 数组末尾（"拖到窗格区之外的任意位置"，设计文档
  // §5-C）；提供时插在该下标（"拖到标签栏上的具体位置"，由调用方用
  // paneDrop.ts 的 resolveTabBarInsertIndex 算出并 clamp 到至少 1——不能插在主页
  // 标签前面，这里再兜底 clamp 一次，防止调用方没做这一步）。新标签成为激活标签，
  // 该窗格是其唯一、也是焦点窗格。
  detachPaneToNewTab: (tabId, paneId, insertAt) => {
    const sourceTab = get().tabs.find((t) => t.id === tabId)
    if (!sourceTab || sourceTab.kind !== 'term') return null
    if (sourceTab.panes.length <= 1) return null
    const idx = sourceTab.panes.findIndex((p) => p.id === paneId)
    if (idx === -1) return null
    const pane = sourceTab.panes[idx]
    const newTabId = `tab-${nextTab++}`
    const newTab: Tab = { id: newTabId, kind: 'term', title: pane.title, panes: [pane], activePaneId: pane.id }
    set((s) => {
      const remainingPanes = sourceTab.panes.filter((p) => p.id !== paneId)
      const activePaneId =
        sourceTab.activePaneId === paneId ? remainingPanes[Math.min(idx, remainingPanes.length - 1)]?.id : sourceTab.activePaneId
      const tabsWithoutPane = s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              panes: remainingPanes,
              activePaneId,
              paneWidths: equalPaneWidths(remainingPanes.length),
              title: deriveTabTitle(remainingPanes, t.title),
            }
          : t,
      )
      const clampedIndex = insertAt === undefined ? tabsWithoutPane.length : Math.max(1, Math.min(insertAt, tabsWithoutPane.length))
      const nextTabs = [...tabsWithoutPane.slice(0, clampedIndex), newTab, ...tabsWithoutPane.slice(clampedIndex)]
      return { tabs: nextTabs, activeId: newTabId }
    })
    return newTabId
  },
  // 标签栏右键菜单「拆分为独立标签」：把一个多窗格标签的每个窗格各自拆成一个独立标签
  // ——是把窗格逐个拖出（detachPaneToNewTab）连续做 N-1 次的批量版本，同样的核心
  // 不变量：每个 Pane 对象原样保留，绝不重新创建（id/ptyId 都不变，TerminalLayer.tsx
  // 按 pane.id 做 key，xterm 实例与其回滚缓冲因此不受影响）。单窗格标签没有什么可拆的，
  // 返回 null，不做任何状态变更（调用方——TabBar.tsx 的右键菜单——也据此不渲染这一项，
  // 这里的拒绝只是防御性兜底）。
  //
  // 拆出的新标签就地插入到原标签在 tabs 数组里的位置（替换它），标签栏里其它标签的
  // 相对顺序不受影响；原本聚焦哪个窗格，拆出后就聚焦它所在的那个新标签（"看到的内容
  // 不因为这次操作而跳走"）。
  splitTabPanes: (tabId) => {
    const sourceTab = get().tabs.find((t) => t.id === tabId)
    if (!sourceTab || sourceTab.kind !== 'term' || sourceTab.panes.length <= 1) return null
    const focusPaneId = sourceTab.activePaneId
    const newTabs: Tab[] = sourceTab.panes.map((pane) => ({
      id: `tab-${nextTab++}`,
      kind: 'term',
      title: pane.title,
      panes: [pane],
      activePaneId: pane.id,
    }))
    const activeNewTab = newTabs.find((t) => t.activePaneId === focusPaneId) ?? newTabs[0]
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === tabId)
      if (idx === -1) return s
      const tabs = [...s.tabs.slice(0, idx), ...newTabs, ...s.tabs.slice(idx + 1)]
      return { tabs, activeId: activeNewTab.id }
    })
    return newTabs.map((t) => t.id)
  },
  // 窗格选择器（设计文档 §5-A）选定后调用：给此前没有 ptyId 的窗格补上真正的终端。
  startPaneTerminal: async (tabId, paneId, { title, cwd, inject, threadKey, dirName, rootKey }) => {
    await ptyEventsReady
    const ptyId = await ptySpawn({ cwd, inject, cols: 80, rows: 24 })
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const panes = t.panes.map((p) => (p.id === paneId ? { ...p, ptyId, title, threadKey, dirName, rootKey } : p))
        return { ...t, panes, title: deriveTabTitle(panes, t.title) }
      }),
    }))
  },
  // 关闭单个窗格；标签只剩这一个窗格时等同关闭整个标签——直接委托给 closeTab 复用
  // 它既有的确认文案与 PTY 终止逻辑，不重复实现一遍（设计文档 §6"⌘W 关闭当前窗格；
  // 当标签只剩一个窗格时等同于关闭标签，沿用既有确认逻辑"）。只有多窗格时才走下面
  // 自己的单窗格确认+终止分支。
  closePane: async (tabId, paneId, confirmFn = dialogConfirm) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || tab.kind !== 'term') return
    if (tab.panes.length <= 1) {
      await get().closeTab(tabId, confirmFn)
      return
    }
    const pane = tab.panes.find((p) => p.id === paneId)
    if (!pane) return
    const ptyId = pane.ptyId
    if (ptyId && (await ptyIsAlive(ptyId))) {
      const ok = await confirmFn(buildPaneCloseConfirmMessage())
      if (!ok) return
      await ptyKill(ptyId)
    }
    set((s) => {
      const t = s.tabs.find((x) => x.id === tabId)
      if (!t) return s
      const idx = t.panes.findIndex((p) => p.id === paneId)
      if (idx === -1) return s
      const panes = t.panes.filter((p) => p.id !== paneId)
      // 关掉的窗格如果正是焦点窗格，焦点落到同一位置（原索引，若已超出数组末尾
      // 则落到新的最后一个）——与关闭标签页时"聚焦相邻标签"是同一直觉。不是焦点
      // 窗格时，activePaneId 原样保留（它引用的窗格 id 没变，仍然有效）。
      const activePaneId = t.activePaneId === paneId ? panes[Math.min(idx, panes.length - 1)]?.id : t.activePaneId
      return {
        tabs: s.tabs.map((x) =>
          x.id === tabId
            ? { ...x, panes, activePaneId, paneWidths: equalPaneWidths(panes.length), title: deriveTabTitle(panes, x.title) }
            : x,
        ),
      }
    })
  },
  focusPane: (tabId, paneId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId && t.panes.some((p) => p.id === paneId) ? { ...t, activePaneId: paneId } : t)),
    })),
  // 拖拽分隔条时高频调用；只更新内存态，不落盘——与设计文档 §3"占比存于内存，不
  // 持久化"一致（呼应"不恢复分屏布局"的非目标）。
  setPaneWidths: (tabId, widths) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, paneWidths: widths } : t)),
    })),
}))
