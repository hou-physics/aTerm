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

// 落点指示条的矩形：目标窗格矩形按左右半侧对半分——半透明色块只覆盖窗格的一半，
// 直观标出新窗格将出现在哪一侧（设计文档 §5-B）。
export function dropIndicatorRect(rect: Rect, side: DropSide): Rect {
  const half = rect.width / 2
  return side === 'left' ? { ...rect, width: half } : { ...rect, left: rect.left + half, width: half }
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
