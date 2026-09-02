import { create } from 'zustand'
import { ptyIsAlive, ptyKill, ptySpawn } from '../ipc'
import type { ProjectInfo } from '../ipc'
import { equalPaneWidths, MAX_PANES } from '../paneLayout'
import { dropInsertionIndex, type DropTarget } from '../paneDrop'
import { resolvePaneIdentity } from '../paneReconcile'
import { ptyEventsReady } from '../ptyBuffer'
import { useOverviewStore } from './overview'

// Pane：标签内的单个终端会话。ptyId 缺省表示该窗格还没有终端——⌘D 新建的窗格先显示
// 会话选择器（见 components/PanePicker.tsx），选定后才通过 startPaneTerminal 补上
// ptyId，此前不占用任何 PTY 资源（设计文档 §5-A）。
// sessionId：只有「我们自己用 --session-id 起的新对话」窗格才有，记录该窗格里跑的
// claude 进程被指定使用的 session id。它是唯一稳定的身份——rootKey 会在首条用户消息
// 出现时从 session_id 翻成那条消息的 uuid（见 scan.rs 的 group_chain_files），所以
// 窗格不能只记 rootKey。--resume 起的窗格不设它：它一开始就知道自己的 rootKey。
export type Pane = { id: string; ptyId?: string; title: string; threadKey?: string; dirName?: string; rootKey?: string; sessionId?: string }
// dirName：只有 kind==='overview' 的标签使用，记住自己是哪个项目的总览页（App.tsx
// 用它渲染 <OverviewPage dirName={...} />）；home/term 标签不填这个字段。
export type Tab = {
  id: string
  kind: 'home' | 'term' | 'overview'
  title: string
  panes: Pane[]
  activePaneId?: string
  paneWidths?: number[]
  dirName?: string
}

// 三种 kind 的窗格语义，写在这里备查（终审删掉了一个曾经把它包成谓词的
// `hasPanes(tab)` 辅助函数：它没有任何生产调用方，而终审排查两处遗漏的 kind 判断时
// 又确认，那两处真正需要的谓词是"可关闭/可排序"，不是"有没有窗格"——一个差点被用错
// 地方的、`kind === 'term'` 的第二个名字，只会误导，不会澄清）：
//   - term：真正持有窗格、参与分屏；
//   - home / overview：panes 恒为空数组，都不该被新建/合并/拆分窗格等操作当成 term
//     处理——这些操作本来就写成 `kind !== 'term'` 的白名单，新增 overview 这第三种
//     kind 会被自动排除，不需要额外的谓词。
// 反过来，"可关闭""可在标签栏里排序"这两条语义与"有没有窗格"并不重合：overview 两者
// 皆可，只有 home 不可——那些地方问的是 `kind === 'home'`，见 closeTab 与 TabBar.tsx
// 的 onTabPointerMove。

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

// 标签拖拽排序（标签栏内拖动标签本身，与"把标签拖进窗格区合并"是同一次拖拽手势的两个
// 落点分支，见 TabBar.tsx）用到的两个纯数组函数，与 store 本身解耦，单独可测。
//
// rawTargetIndex 来自 paneDrop.ts 的 resolveTabBarInsertIndex：光标 x 坐标 + 标签矩形
// 数组（这份矩形数组是"当前顺序、含正在被拖拽的标签自己"的真实 DOM 快照，因为拖拽
// 过程中并不隐藏或挪动被拖标签本身，只有跟随光标的 ghost 在动）算出的几何插入下标——
// 它不知道也不需要知道"哪个是拖拽源"，纯粹是"光标落在哪两个标签中间"。reorderInsertIndex
// 把这个几何下标换算成"从 order 里移除拖拽源之后，它该插入的下标"：目标下标若大于
// 源下标，说明移除源标签后，同一个视觉缝隙对应的下标要向前挪一格。minIndex 钳住不能
// 把任何标签排到主页标签前面——主页恒为下标 0，设计要求它既不能被顶替、自己也不可被
// 拖动（后者由调用方在识别到 dragTab.kind === 'home' 时整个手势直接判定无效来保证，
// 这里只负责钳住"别人"不能插到它前面）。
export function reorderInsertIndex(order: string[], sourceId: string, rawTargetIndex: number, minIndex = 1): number {
  const srcIdx = order.indexOf(sourceId)
  const clamped = Math.max(minIndex, Math.min(rawTargetIndex, order.length))
  if (srcIdx === -1) return clamped
  return clamped > srcIdx ? clamped - 1 : clamped
}

// 纯数组挪动：把下标 fromIndex 的元素搬到 toIndex（原地让路，不做其它变换），与业务
// 语义无关。fromIndex 越界或与 toIndex 相同时原样返回同一个数组引用（no-op，不产生
// 新对象——与本文件其它"真正的空操作"同一惯例，例如 movePanesToTab 拖到自己标签时）。
export function moveArrayItem<T>(arr: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex < 0 || fromIndex >= arr.length || fromIndex === toIndex) return arr
  const copy = arr.slice()
  const [item] = copy.splice(fromIndex, 1)
  copy.splice(toIndex, 0, item)
  return copy
}

type TabsState = {
  tabs: Tab[]
  activeId: string
  setActive(id: string): void
  openTerminal(o: { title: string; cwd?: string; inject?: string; threadKey?: string; dirName?: string; rootKey?: string; sessionId?: string }): Promise<void>
  /** 打开某个项目的总览页（标签栏第三种标签，spec §5.2）：已存在同一 dirName 的总览
   * 标签则只聚焦它，不新建；新建时才清除该项目的排序快照（见下方实现注释）。 */
  openOverview(dirName: string, projectName: string): void
  focusThread(threadKey: string): boolean
  closeTab(id: string, confirmFn?: ConfirmFn): Promise<void>
  addPane(tabId: string, afterPaneId: string): boolean
  insertPaneAt(tabId: string, index: number): string | null
  movePanesToTab(sourceTabId: string, targetTabId: string, target: DropTarget): boolean
  fillEmptyPane(sourceTabId: string, targetTabId: string, targetPaneId: string): boolean
  detachPaneToNewTab(tabId: string, paneId: string, insertAt?: number): string | null
  splitTabPanes(tabId: string): string[] | null
  reorderTab(tabId: string, rawTargetIndex: number): boolean
  reorderPane(tabId: string, paneId: string, targetPaneId: string): boolean
  startPaneTerminal(tabId: string, paneId: string, o: { title: string; cwd?: string; inject?: string; threadKey?: string; dirName?: string; rootKey?: string; sessionId?: string }): Promise<void>
  closePane(tabId: string, paneId: string, confirmFn?: ConfirmFn): Promise<void>
  focusPane(tabId: string, paneId: string): void
  setPaneWidths(tabId: string, widths: number[]): void
  reconcilePanes(projects: ProjectInfo[], aliases: Record<string, string>): void
  adoptTerminalTab(o: { panes: AdoptedPane[]; activePaneIndex: number }): string | null
  removeTabKeepingPty(id: string): boolean
}

// 跨窗口交接（V3.3 设计文档 §4.2，见 src/windowHandoff.ts）过来的窗格描述：与 Pane
// 的区别只有一个——没有 id。窗格 id 是每个窗口自己的模块级计数器发的（nextPane），
// 跨窗口原样搬过来会和新窗口自己已有的 id 撞车，所以由 adoptTerminalTab 在本窗口
// 重新分配。ptyId 可缺省：⌘D 新建后还没选定会话的空槽窗格（见 Pane 类型注释）本来
// 就没有 PTY，交接时应当原样保留成空槽，而不是被悄悄丢掉。
export type AdoptedPane = Omit<Pane, 'id'>

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [{ id: 'home', kind: 'home', title: '主页', panes: [] }],
  activeId: 'home',
  setActive: (id) => set({ activeId: id }),
  openTerminal: async ({ title, cwd, inject, threadKey, dirName, rootKey, sessionId }) => {
    await ptyEventsReady
    const ptyId = await ptySpawn({ cwd, inject, cols: 80, rows: 24 })
    const id = `tab-${nextTab++}`
    const pane: Pane = { id: `pane-${nextPane++}`, ptyId, title, threadKey, dirName, rootKey, sessionId }
    set((s) => ({ tabs: [...s.tabs, { id, kind: 'term', title, panes: [pane], activePaneId: pane.id }], activeId: id }))
  },
  // 「打开」总览页指的是这个总览标签被创建这件事，不是 OverviewPage 组件每次挂载
  // （Task 4 store 的 ruling：见 store/overview.ts clearOrder 与 progress.md Task 4）。
  // 已有同一 dirName 的总览标签时只聚焦、不新建，也不清排序快照——切走再切回来，
  // 方块顺序应该保持稳定，不能因为标签重新变为激活标签就重排。只有真正新建时才调用
  // clearOrder：这样"新开总览标签→按最后活动时间重排""切走再切回→顺序不变"两条
  // spec §5.2 的要求同时成立。标题固定用「▦ 项目名·总览」，panes 恒为空数组（不参与
  // 分屏，见文件顶部关于三种 kind 的说明）。
  openOverview: (dirName, projectName) => {
    const existing = get().tabs.find((t) => t.kind === 'overview' && t.dirName === dirName)
    if (existing) {
      set({ activeId: existing.id })
      return
    }
    useOverviewStore.getState().clearOrder(dirName)
    const id = `tab-${nextTab++}`
    const tab: Tab = { id, kind: 'overview', title: `▦ ${projectName}·总览`, panes: [], dirName }
    set((s) => ({ tabs: [...s.tabs, tab], activeId: id }))
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
    // 这里问的是"是不是主页标签"（唯一恒不可关闭的标签），不是"有没有窗格"——总览
    // 标签同样没有窗格，但设计要求它必须可关闭（TabBar.tsx 的 × 按钮对非 home 标签
    // 常显，包含 overview；App.tsx 的 ⌘W 用的是逐字相同的条件，两个入口必须一致）。
    // 换成任何形式的"没有窗格就不给关"都会把总览标签和主页一起挡在这里，× 按钮点了
    // 会什么都不发生——见 tabs.test.ts「总览标签可以被关闭」一测。
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
  // 把源标签的全部窗格"填进"目标标签某个空槽窗格（本次修复的设计间隙：目标窗格没有
  // ptyId——⌘D 新建后还没选定会话、正在渲染 PanePicker 的那种占位——本身就是"等待
  // 被填入内容的槽位"，拖拽落在它上面应该取代它的位置，而不是像 movePanesToTab 那样
  // 在旁边插一个、把总窗格数推高到撞上 320px 最小宽度的上限。目标窗格被整个丢弃：
  // 它从来没有 ptyId，没有 PTY 需要终止，不经过 closePane 那套确认逻辑，与
  // insertPaneAtIndex 对"待选窗格"的处理一致——它本来就什么都没有。
  //
  // 结果窗格数 = 目标标签原有数 - 1（丢弃空槽） + 源标签窗格数，与 movePanesToTab
  // "+ 源标签窗格数"（不减）不同——调用方（TabBar.tsx）必须用 paneLayout.ts 的
  // previewPaneDrop 按 'fill' 语义算这个数字喂给宽度/上限判断，否则会把"填充"误判成
  // "插入"从而错误拒绝。
  //
  // 与 movePanesToTab 共享的不变量：源标签的每个 Pane 对象原样保留、绝不重新创建
  // （id/ptyId 都不变，TerminalLayer.tsx 按 pane.id 做 key，xterm 实例与其回滚缓冲
  // 因此不受影响），源标签因此整体移除，不经过 closeTab 的确认流程（没有任何 PTY
  // 被终止）。以下情况返回 false 且不做任何状态变更：源/目标标签之一不存在或非 term
  // 标签；源标签就是目标标签；目标窗格不属于目标标签，或目标窗格并非空槽（有
  // ptyId——那种落点应该走 movePanesToTab，这里只处理"空槽"这一种）；结果窗格数会
  // 超过上限（防御性兜底，正常流程调用方已经用 previewPaneDrop 挡在前面）。
  fillEmptyPane: (sourceTabId, targetTabId, targetPaneId) => {
    if (sourceTabId === targetTabId) return false
    const { tabs } = get()
    const sourceTab = tabs.find((t) => t.id === sourceTabId)
    const targetTab = tabs.find((t) => t.id === targetTabId)
    if (!sourceTab || sourceTab.kind !== 'term' || !targetTab || targetTab.kind !== 'term') return false
    const movedPanes = sourceTab.panes
    if (movedPanes.length === 0) return false
    const targetIdx = targetTab.panes.findIndex((p) => p.id === targetPaneId)
    if (targetIdx === -1) return false
    if (targetTab.panes[targetIdx].ptyId) return false
    if (targetTab.panes.length - 1 + movedPanes.length > MAX_PANES) return false
    const focusPaneId = sourceTab.activePaneId ?? movedPanes[0].id
    set((s) => {
      const withoutSource = s.tabs.filter((t) => t.id !== sourceTabId)
      const nextTabs = withoutSource.map((t) => {
        if (t.id !== targetTabId) return t
        const panes = [...t.panes.slice(0, targetIdx), ...movedPanes, ...t.panes.slice(targetIdx + 1)]
        return { ...t, panes, activePaneId: focusPaneId, paneWidths: equalPaneWidths(panes.length), title: deriveTabTitle(panes, t.title) }
      })
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
    // 同 splitTabPanes：新标签只持有这一个窗格，标题走 deriveTabTitle（与直接写
    // pane.title 等价，但统一了标题的计算规则只有一处来源）。
    const newTab: Tab = { id: newTabId, kind: 'term', title: deriveTabTitle([pane], pane.title), panes: [pane], activePaneId: pane.id }
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
      // 与其余五处"窗格数量变化"的调用点（insertPaneAtIndex/movePanesToTab/
      // fillEmptyPane/detachPaneToNewTab/closePane）统一走 deriveTabTitle，不再
      // 手写与它恰好等价的 `pane.title`——单窗格新标签下 deriveTabTitle 本就等同于
      // 直接取 pane.title，这里改用同一个函数只是让标题的计算规则只有一处来源，
      // 不会因为将来 deriveTabTitle 的单窗格分支变化而在这里悄悄脱节。
      title: deriveTabTitle([pane], pane.title),
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
  // 标签拖拽排序（拖标签这同一次手势，落点在标签栏上时的分支，见 TabBar.tsx）：
  // rawTargetIndex 是 paneDrop.ts 的 resolveTabBarInsertIndex 算出的几何下标（含
  // 拖拽源自身、未做任何移除调整），这里换算 + 落盘一次做完。srcIdx <= 0 覆盖两种
  // 拒绝情况——标签不存在，或正是不可拖动的主页标签（永远排第一，见类型上方设计要求）
  // ——都返回 false、不做任何状态变更；调用方（TabBar.tsx）正常也不会让这两种情况
  // 走到这里（home 拖拽在识别阶段就已经整个手势判定无效），这里只是防御性兜底。
  // 落回原位（换算后的插入下标与源下标相同）同样是空操作，不触发 set，连数组引用都
  // 不变——与本文件其它"真正的空操作"同一惯例。
  reorderTab: (tabId, rawTargetIndex) => {
    const order = get().tabs.map((t) => t.id)
    const srcIdx = order.indexOf(tabId)
    if (srcIdx <= 0) return false
    const insertion = reorderInsertIndex(order, tabId, rawTargetIndex)
    if (insertion === srcIdx) return false
    set((s) => ({ tabs: moveArrayItem(s.tabs, srcIdx, insertion) }))
    return true
  },
  // 同标签内拖动窗格标题栏：用户描述的"交换位置"诉求（拖一个框到右边，两个位置就都
  // 自动交换）落地成"把源窗格移到目标窗格当前所在的下标"——两个窗格时这就是严格对调，
  // 正是用户描述的效果；三个及以上窗格时是"顺次插入"而不是两两对调（把最左边那个拖到
  // 最右＝它移到最右端、其余顺次前移，而不是跟最右那个对调、中间那个纹丝不动）。
  // targetPaneId 来自 paneDrop.ts 的 resolveReorderTarget（TabPanes.tsx 在光标仍停留于
  // 源标签自己的窗格行内时就地解出的落点，与 movePanesToTab/fillEmptyPane 是同一手势、
  // 不同分支）——整块窗格都是落点，不带 side，这正是本次修复的要点：上一轮直接复用
  // 了给"跨标签插入新窗格"设计的 resolveDropTarget（半侧语义），落点先按 side 经
  // dropInsertionIndex 换算成下标、再经 reorderInsertIndex 换算"移除拖拽源后是否要
  // 前移一格"，两步叠加后目标窗格的某一侧恰好会换算回源窗格原来的下标——变成用户
  // 描述的"只有拖到某个 critical 位置才能成功"，且指示条也被画成半侧色块（见
  // .superpowers/sdd/reorder-and-toggle-fix-report.md）。
  //
  // 换算不再需要 dropInsertionIndex/reorderInsertIndex 那两步：targetPaneId 在数组里
  // 的下标就是 moveArrayItem 该用的 toIndex——moveArrayItem 是"先移除源元素、再在
  // toIndex 处插入"，源下标小于目标下标时移除会让目标位置整体前移一格，再插回 toIndex
  // 这个（移除前的）原始下标，效果正是"源元素落在目标原来的位置、目标跟着让出来的
  // 空隙顺次前移"；源下标大于目标下标时移除不影响 toIndex 之前的位置，插入同样落在
  // 目标原来的下标上。两个方向算出来的都是"源元素最终停在目标窗格原来的下标"，与两
  // 窗格时的"对调"、三窗格时的"顺次插入"两种描述完全吻合，不需要再手写一层换算。
  //
  // paneWidths 必须跟着同一次 moveArrayItem 操作一起挪——否则窗格换了位置、宽度却留在
  // 原下标，视觉上会错位；没有 paneWidths（理论上不会发生：能拖动窗格标题栏说明至少
  // 有 2 个窗格，此时 paneWidths 恒已由别的路径填好）时原样保留 undefined，不主动补
  // equalPaneWidths——窗格数量没变，不该触发"重新等分"。activePaneId 保持指向被拖的
  // 窗格本身：它换了位置，但仍是焦点，不需要像 closePane 那样重新计算。
  //
  // 以下情况返回 false 且不产生新的 tabs 引用（与 moveArrayItem/movePanesToTab 拖到
  // 自己标签时的既有惯例一致，真正的空操作不制造新对象）：标签不存在或非 term；源/
  // 目标窗格有一个不属于该标签；源窗格就是目标窗格本身（"拖到自己身上"，targetIdx
  // 恒等于 srcIdx）。
  reorderPane: (tabId, paneId, targetPaneId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || tab.kind !== 'term') return false
    const paneIds = tab.panes.map((p) => p.id)
    const srcIdx = paneIds.indexOf(paneId)
    const targetIdx = paneIds.indexOf(targetPaneId)
    if (srcIdx === -1 || targetIdx === -1 || srcIdx === targetIdx) return false
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        return {
          ...t,
          panes: moveArrayItem(t.panes, srcIdx, targetIdx),
          paneWidths: t.paneWidths ? moveArrayItem(t.paneWidths, srcIdx, targetIdx) : t.paneWidths,
          activePaneId: paneId,
        }
      }),
    }))
    return true
  },
  // 窗格选择器（设计文档 §5-A）选定后调用：给此前没有 ptyId 的窗格补上真正的终端。
  startPaneTerminal: async (tabId, paneId, { title, cwd, inject, threadKey, dirName, rootKey, sessionId }) => {
    await ptyEventsReady
    const ptyId = await ptySpawn({ cwd, inject, cols: 80, rows: 24 })
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const panes = t.panes.map((p) => (p.id === paneId ? { ...p, ptyId, title, threadKey, dirName, rootKey, sessionId } : p))
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
    // 先确认 paneId 真的是这个标签自己的窗格，再决定"标签只剩一个窗格时委托给
    // closeTab"这条分支——顺序调换过一次的话，一个陈旧/写错的 paneId（不属于该
    // 标签、甚至压根不存在）会在标签恰好只剩一个窗格时被当成"关闭它唯一的窗格"，
    // 从而误关整个标签、终止一个并未被请求关闭的 PTY。这里没有任何现有调用方会
    // 传入这样的 paneId（收紧只是防御性的），但顺序本身值得钉住。
    const pane = tab.panes.find((p) => p.id === paneId)
    if (!pane) return
    if (tab.panes.length <= 1) {
      await get().closeTab(tabId, confirmFn)
      return
    }
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
  // 窗格身份对账（spec §3.3c）：把"我起进程时指定的 sessionId"映射回该链此刻的
  // rootKey/标题，回填进窗格。一处对账同时修好四个症状：标签标题不更新、侧栏点击
  // 又开新标签、右侧对话面板不加载、底栏模型不显示。
  //
  // 只处理 sessionId 非空的窗格——--resume 起的窗格一开始就知道自己的 rootKey，
  // 不需要也不该被这里改动。
  //
  // 身份完全未变时返回同一个 tabs 引用（no-op，不产生新对象），与本文件既有惯例
  // 一致（moveArrayItem、movePanesToTab 拖到自己标签时都是这样）——这个 action 每
  // 15 秒被调用一次，制造新引用会让整棵标签树无谓重渲染。
  reconcilePanes: (projects, aliases) => {
    set((s) => {
      let changed = false
      const tabs = s.tabs.map((tab) => {
        if (tab.kind !== 'term') return tab
        let tabChanged = false
        const panes = tab.panes.map((pane) => {
          if (!pane.sessionId) return pane
          const id = resolvePaneIdentity(projects, pane.sessionId, aliases)
          if (!id) return pane
          // resolvePaneIdentity 现在用 displayTitle 算 title：别名 > 真实标题 >
          // 「新对话」，三档都给出有意义的字符串——title 恒有值，不再是"给不出就
          // 保留旧标题"的可缺省字段，因此不再需要 `id.title ?? pane.title` 这层
          // 兜底（旧实现见本文件 git 历史）。
          if (
            pane.dirName === id.dirName && pane.rootKey === id.rootKey &&
            pane.threadKey === id.threadKey && pane.title === id.title
          ) return pane
          tabChanged = true
          return { ...pane, dirName: id.dirName, rootKey: id.rootKey, threadKey: id.threadKey, title: id.title }
        })
        if (!tabChanged) return tab
        changed = true
        return { ...tab, panes, title: deriveTabTitle(panes, tab.title) }
      })
      return changed ? { tabs } : {}
    })
  },
  // 跨窗口交接的接收端（V3.3 设计文档 §4.2 第 5 步，调用方是 src/windowHandoff.ts
  // 里新窗口那侧的 handleHandoff）：按交接载荷建一个终端标签，窗格直接绑定**已经在
  // 跑的** ptyId，绝不 ptySpawn——那会凭空多起一个 claude 进程，而原来那个还挂在
  // 后台没人管。这是它和 openTerminal 唯一的、也是最关键的区别，别把两者合并。
  //
  // 窗格 id 在这里重新分配（见 AdoptedPane 的注释）；其余字段（ptyId/title/
  // threadKey/dirName/rootKey/sessionId）原样搬过来，身份因此完整跟着标签走——
  // 侧边栏聚焦、对话面板、底栏模型、reconcilePanes 对账在新窗口里立刻就能认出它。
  //
  // panes 为空时不建标签（返回 null）：空的终端标签在这个应用里没有任何合法来源，
  // 建出来只会是一个点不动的空壳；调用方据此判定这次交接无效、不回 ack，旧窗口
  // 那边就会走超时回滚，标签留在原处——比在新窗口里留个空壳、旧窗口又把标签删掉
  // 要好得多（那正是本任务最不能出现的"两个窗口都没有这个标签"）。
  adoptTerminalTab: ({ panes, activePaneIndex }) => {
    if (panes.length === 0) return null
    const built: Pane[] = panes.map((p) => ({ ...p, id: `pane-${nextPane++}` }))
    const idx = Math.max(0, Math.min(activePaneIndex, built.length - 1))
    const id = `tab-${nextTab++}`
    const tab: Tab = {
      id,
      kind: 'term',
      // 标题就地按窗格重新推导，不由交接载荷携带："标签标题 = deriveTabTitle(窗格)"
      // 在本文件里是所有路径共同遵守的不变式，旧窗口那份标题本身也是这么算出来的，
      // 搬一个必然相等的值过来只会多一个可以漂移的真相来源（而且它在这里恒不会被
      // 用到：panes 非空已在上面保证，deriveTabTitle 的 fallback 分支够不着）。
      title: deriveTabTitle(built, built[0].title),
      panes: built,
      activePaneId: built[idx].id,
      // 与 insertPaneAtIndex/movePanesToTab 同一惯例：多窗格才需要显式宽度，单窗格
      // 保持 undefined（TabPanes.tsx 对单窗格本就不读这个字段）。
      paneWidths: built.length > 1 ? equalPaneWidths(built.length) : undefined,
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeId: id }))
    return id
  },
  // 跨窗口交接的发送端收尾（V3.3 设计文档 §4.2 第 6 步）：把标签从**本窗口**移除，
  // 但**绝不 kill 它的 PTY**——那些会话此刻已经被新窗口接管、正在继续跑，kill 掉就是
  // 直接杀死用户正在运行的 claude 进程。
  //
  // 因此这里不能复用 closeTab：它的整个职责就是"确认后终止 PTY"，语义正好相反。与
  // movePanesToTab 移除源标签那一步是同一类操作（窗格只是换了个持有者，没有任何 PTY
  // 被终止，也不该弹确认），区别只在于新的持有者在另一个窗口里、不在本窗口的 store。
  //
  // 调用方（windowHandoff.ts）必须在**收到新窗口的接管确认之后**才调这个方法，顺序
  // 反了会在接管失败时凭空吃掉用户一个正在运行的会话。activeId 的兜底与 closeTab
  // 逐字相同（主页标签恒存在，tabs 不可能为空）。
  removeTabKeepingPty: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || tab.kind === 'home') return false
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeId = s.activeId === id ? tabs[tabs.length - 1].id : s.activeId
      return { tabs, activeId }
    })
    return true
  },
}))
