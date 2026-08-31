// 拖放创建/移动窗格的纯函数集合：光标位置 + 窗格插槽矩形 → 落点窗格与左右半侧
// （设计文档 §5-B "拖拽过程中显示落点指示"）。不依赖 DOM/React/Zustand，供
// src/components/TabBar.tsx（场景 A：拖已打开的标签进窗格区）、
// src/components/Sidebar.tsx（场景 B：从「最近会话」拖入）与
// src/components/DropIndicator.tsx 共用，也便于在 jsdom 无法验证真实布局的前提下
// 单独测试这套坐标判定逻辑本身（同 paneGeometry.ts 的既有做法）。

export type Rect = { top: number; left: number; width: number; height: number }
export type PaneSlotRect = { paneId: string; rect: Rect }
export type DropSide = 'left' | 'right'
export type DropTarget = { paneId: string; side: DropSide }

// 拖动超过这个像素距离才算真的在拖，而不是一次普通点击——阈值太小会让手抖的点击被
// 误判成拖拽，太大会让拖拽感觉迟钝；4px 是这类交互的常见取值（设计文档要求
// "small movement threshold (e.g. 4px)"）。三个拖拽源（TabBar.tsx 拖标签、
// Sidebar.tsx 拖「最近会话」、TabPanes.tsx 拖窗格标题栏）曾经各自重复定义同一个
// 常量，这里收敛成单一来源——本模块已经是它们共用的拖放几何纯函数集合，没有理由
// 再单独为一个常量开一个新文件。
export const DRAG_THRESHOLD_PX = 4

// 光标是否落在某个窗格矩形内（左闭右开、上闭下开，避免边界像素同时命中相邻窗格）；
// 命中后按光标在该矩形宽度方向上相对中点的位置决定落在左半还是右半。各窗格矩形理应
// 互不重叠（见 paneGeometry.ts 的换算），命中第一个即返回；一个都没命中（光标不在
// 任何窗格范围内，或调用方没有传入任何矩形——例如当前标签没有窗格）返回 null。
//
// 只服务"跨标签插入新窗格"这一条路径（TabBar.tsx 把已打开标签拖进窗格区、
// Sidebar.tsx 把「最近会话」拖入）：那条路径的落点确实有"插在这个窗格左边还是右边"
// 的区分，半侧语义在那里是对的。同标签内重排窗格位置不要用这个函数——见下面
// resolveReorderTarget 的注释。
export function resolveDropTarget(slots: PaneSlotRect[], cursorX: number, cursorY: number): DropTarget | null {
  const hit = slots.find(
    ({ rect }) =>
      cursorX >= rect.left &&
      cursorX < rect.left + rect.width &&
      cursorY >= rect.top &&
      cursorY < rect.top + rect.height,
  )
  if (!hit) return null
  const mid = hit.rect.left + hit.rect.width / 2
  return { paneId: hit.paneId, side: cursorX < mid ? 'left' : 'right' }
}

// 同标签内拖动窗格标题栏重排位置（TabPanes.tsx）专用的落点解析：目标窗格整块都是
// 落点，不区分左右半侧——命中判定与 resolveDropTarget 完全一致（同一套左闭右开/
// 上闭下开边界约定），只是不再按中点拆半，直接返回命中窗格的 id。
//
// 这是用户真机验收报告的两个症状的根因修复（见 .superpowers/sdd/
// reorder-and-toggle-fix-report.md）：上一轮实现同标签重排时直接复用了
// resolveDropTarget——但那是给"跨标签插入新窗格"设计的，半侧语义在那里表达"新窗格
// 插在这一侧"；同标签内重排根本没有"插在哪一侧"这个概念，目标窗格本身就是一个位置，
// 不是两个。复用它产生了两个真实缺陷：①指示条被画成半个窗格的色块，用户看到"分成
// 两个的操作提示"；②落点先经 dropInsertionIndex 按 side 换算成数组下标，再经
// reorderInsertIndex 换算"移除源窗格后是否要前移一格"，两步换算叠加后，目标窗格的
// 其中一侧算出来的下标恰好等于源窗格原来的下标——变成一次没有任何效果的空操作，
// 只有拖到另外那一侧才会真的换算出不同下标，这正是用户描述的"只有到达某一个非常
// critical 的位置才能拖成功"。
export function resolveReorderTarget(slots: PaneSlotRect[], cursorX: number, cursorY: number): string | null {
  const hit = slots.find(
    ({ rect }) =>
      cursorX >= rect.left &&
      cursorX < rect.left + rect.width &&
      cursorY >= rect.top &&
      cursorY < rect.top + rect.height,
  )
  return hit ? hit.paneId : null
}

// 落点指示条的矩形：目标窗格矩形按左右半侧对半分——半透明色块只覆盖窗格的一半，
// 直观标出新窗格将出现在哪一侧（设计文档 §5-B）。
export function dropIndicatorRect(rect: Rect, side: DropSide): Rect {
  const half = rect.width / 2
  return side === 'left' ? { ...rect, width: half } : { ...rect, left: rect.left + half, width: half }
}

// 落点语义：'insert'——目标窗格已经有内容（持有 ptyId），拖放在其左/右插入新窗格
// （既有行为，窗格总数会增加）；'fill'——目标窗格是"空槽"（没有 ptyId，即 ⌘D 新建后
// 还没选定会话、正在渲染 PanePicker 的那种窗格，见 store/tabs.ts 的 Pane 类型注释）。
// 空槽本身就是"等待被填入内容的占位"，拖拽落在它上面理应取代它的位置而不是在旁边
// 再插一个——这是本次修复要补上的设计间隙：此前所有落点都按 'insert' 处理，导致
// 拖到空槽窗格会把总窗格数意外推高、撞上 320px 最小宽度的上限而被拒绝（诊断记录见
// .superpowers/pane-fill-report.md）。'reorder'——同标签内拖动窗格标题栏重排位置
// （resolveReorderTarget 解出的落点），目标窗格整块都是落点，视觉上同样该覆盖整个
// 窗格；单独给一个名字而不是复用 'fill'，是因为二者虽然此刻都画满格，但语义并不
// 相同——'fill' 描述的是"这个窗格是空槽，会被拖入的内容取代"，'reorder' 描述的是
// "把被拖的窗格换到这个位置"，没有任何内容被替换/丢弃。同标签重排从不检查目标窗格
// 是否有 ptyId（不管落在哪个窗格上，做的都是换位置），把它归进 'fill' 会让将来读到
// `dropMode === 'fill'` 的人误以为这里也存在"空槽才会发生"的前提，见本次修复报告
// （.superpowers/sdd/reorder-and-toggle-fix-report.md）里的取舍说明。
export type DropMode = 'insert' | 'fill' | 'reorder'

// 只接受"目标窗格是否已有 ptyId"这一个结构化字段，不 import store/tabs.ts 的 Pane
// 类型——本模块是纯几何/判定层，store/tabs.ts 已经在 import 它，不能反过来依赖 store。
// 调用方（TabBar.tsx/Sidebar.tsx）在 resolveDropTarget 解出 paneId 后，自己从当前
// Tab 的 panes 数组里查出目标窗格传进来。
//
// 返回类型特意写成 'insert' | 'fill' 而不是完整的 DropMode：这个函数只服务跨标签
// 拖放（TabBar.tsx/Sidebar.tsx），'reorder' 是同标签内重排（TabPanes.tsx）专属的
// 语义，这里永远不会、也不应该返回它。写窄了两个好处：paneLayout.ts 的
// previewPaneDrop 的 mode 形参就能照样只收 'insert' | 'fill'（不必为一个用不到的
// 分支加宽），调用方（TabBar.tsx/Sidebar.tsx）拿到的 mode 变量也精确反映"这里不会
// 出现 reorder"，不需要再多余地判空。
export function resolveDropMode(targetPane: { ptyId?: string } | undefined): 'insert' | 'fill' {
  return targetPane && !targetPane.ptyId ? 'fill' : 'insert'
}

// 落点指示条的矩形，按落点语义选择覆盖范围：'insert' 沿用既有的左右半侧切分
// （dropIndicatorRect）；'fill'/'reorder' 都覆盖整个窗格——空槽没有"左右两侧"的区分
// （继续切半会让用户误以为落下去还是"插入"语义，见设计文档本次修复的 Fix 2），
// 重排同样没有"左右两侧"（目标窗格整块就是落点，见 resolveReorderTarget 注释），
// 两者只是"为什么整格"的理由不同，画法完全一样，因此共用同一个分支，不必再造一套。
export function dropIndicatorPreviewRect(rect: Rect, mode: DropMode, side: DropSide): Rect {
  return mode === 'insert' ? dropIndicatorRect(rect, side) : rect
}

// 把落点 {paneId, side} 换算成该在 panes 数组里插入的下标——场景 A（跨标签移动整个
// 标签的窗格）与场景 B（侧边栏拖入新建窗格）共用同一份换算。目标窗格不在数组中
// （理论上不应发生：落点总是从同一份 panes 派生出的插槽里选出的）时退化为追加到末尾。
export function dropInsertionIndex(paneIds: string[], target: DropTarget): number {
  const idx = paneIds.indexOf(target.paneId)
  if (idx === -1) return paneIds.length
  return target.side === 'left' ? idx : idx + 1
}

// 光标是否落在某个矩形内（左闭右开、上闭下开，与 resolveDropTarget 同一套边界约定）。
// 供"窗格拖出"（设计文档 §5-C）判断光标是否还停留在源标签自己的窗格行里（TabPanes.tsx
// 的 `.term-wrap`）、或落在了标签栏（TabBar.tsx 的 `.tabbar`）范围内——两处都只是判断
// "在不在某个矩形里"，不需要再各写一份。
export function pointInRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height
}

// 把光标 x 坐标 + 一组标签矩形（TabBar.tsx 渲染顺序，与 useTabs 的 tabs 数组顺序一致，
// 含主页标签）换算成该插入 tabs 数组的下标——命中第一个"光标在其中点左侧"的标签就
// 插在它前面；一个都没命中（光标在最后一个标签中点右侧，或没有任何标签）则插到末尾。
// 供"把窗格拖出成独立标签、松手时落在标签栏上"（设计文档 §5-C）决定新标签插入的位置。
// 主页标签恒为下标 0，这里不做"不能插在主页前面"这类业务假设（保持纯粹的几何换算），
// 调用方（TabPanes.tsx）自行 clamp 到至少 1。
export function resolveTabBarInsertIndex(tabRects: { rect: Rect }[], cursorX: number): number {
  for (let i = 0; i < tabRects.length; i++) {
    const mid = tabRects[i].rect.left + tabRects[i].rect.width / 2
    if (cursorX < mid) return i
  }
  return tabRects.length
}
