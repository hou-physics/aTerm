import { create } from 'zustand'
import { ptyIsAlive, ptyKill, ptySpawn } from '../ipc'
import { equalPaneWidths, MAX_PANES } from '../paneLayout'
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

type TabsState = {
  tabs: Tab[]
  activeId: string
  setActive(id: string): void
  openTerminal(o: { title: string; cwd?: string; inject?: string; threadKey?: string; dirName?: string; rootKey?: string }): Promise<void>
  focusThread(threadKey: string): boolean
  closeTab(id: string, confirmFn?: ConfirmFn): Promise<void>
  addPane(tabId: string, afterPaneId: string): boolean
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
    if (tab.panes.length >= MAX_PANES) return false
    const idx = tab.panes.findIndex((p) => p.id === afterPaneId)
    const insertAt = idx === -1 ? tab.panes.length : idx + 1
    const pane: Pane = { id: `pane-${nextPane++}`, title: '新窗格' }
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const panes = [...t.panes.slice(0, insertAt), pane, ...t.panes.slice(insertAt)]
        return { ...t, panes, activePaneId: pane.id, paneWidths: equalPaneWidths(panes.length), title: deriveTabTitle(panes, t.title) }
      }),
    }))
    return true
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
