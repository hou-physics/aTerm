// 拖放相关的 DOM 胶水：查询当前激活标签的每个窗格插槽（`.pane[data-pane-id]`，见
// TabPanes.tsx）在视口坐标系下的矩形/内容区宽度，供 TabBar.tsx（场景 A：拖已打开的
// 标签进窗格区）与 Sidebar.tsx（场景 B：从「最近会话」拖入）在 pointermove/pointerup
// 时喂给 paneDrop.ts / paneLayout.ts 的纯函数。不是纯函数本身（读取真实 DOM），因此
// 不单独做单元测试——jsdom 里 getBoundingClientRect()/clientWidth 恒返回全 0，测不出
// 什么；真正值得测的坐标判定与降级决策逻辑已经在 paneDrop.test.ts / paneLayout.test.ts
// 里用纯函数覆盖，这里只做"从 store 的 Tab 对象 + 真实 DOM 树取数"这一步。
import type { PaneSlotRect } from './paneDrop'
import type { Tab } from './store/tabs'

export function getPaneSlotRects(tab: Tab | undefined): PaneSlotRect[] {
  if (!tab) return []
  const out: PaneSlotRect[] = []
  for (const p of tab.panes) {
    const el = document.querySelector<HTMLElement>(`[data-pane-id="${p.id}"]`)
    if (!el) continue
    const r = el.getBoundingClientRect()
    out.push({ paneId: p.id, rect: { top: r.top, left: r.left, width: r.width, height: r.height } })
  }
  return out
}

// 与 App.tsx 的 ⌘D 处理器读取的是同一个 `.content` 元素（见该文件 contentRef），
// 这里改用直接查询而不是 props 传入 ref——TabBar.tsx/Sidebar.tsx 都不是 `.content`
// 的祖先，没有天然途径拿到那个 ref，量的又是同一个恒定存在的单例节点，直接查询
// 比一路用 props 把 ref 转发下来更直接（与 TerminalLayer.tsx/DropIndicator.tsx
// 走 containerRef props 的路径不同，是因为它们本来就是 `.content` 的同级子节点，
// App.tsx 天然就能把 ref 传给它们）。
export function getContentWidth(): number {
  return document.querySelector<HTMLElement>('.content')?.clientWidth ?? 0
}

// 窗格拖出成独立标签（设计文档 §5-C）用到的另外三个 DOM 查询：源标签自己的窗格行
// （光标还在其中即视为"没有真的拖出去"，见 TabPanes.tsx）、标签栏整体范围（光标落在
// 其中即按位置插入新标签，见 TabBar.tsx）、标签栏里每个标签的矩形（换算插入下标）。
// 同上，不是纯函数，不单独测试；纯粹的坐标判定逻辑在 paneDrop.ts 的 pointInRect /
// resolveTabBarInsertIndex 里单独测过。
export function getPaneRowRect(tabId: string): PaneSlotRect['rect'] | null {
  const el = document.querySelector<HTMLElement>(`.term-wrap[data-tab-id="${tabId}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

export function getTabBarRect(): PaneSlotRect['rect'] | null {
  const el = document.querySelector<HTMLElement>('.tabbar')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

export function getTabRects(): { tabId: string; rect: PaneSlotRect['rect'] }[] {
  const out: { tabId: string; rect: PaneSlotRect['rect'] }[] = []
  document.querySelectorAll<HTMLElement>('.tab[data-tab-id]').forEach((el) => {
    const r = el.getBoundingClientRect()
    out.push({ tabId: el.getAttribute('data-tab-id')!, rect: { top: r.top, left: r.left, width: r.width, height: r.height } })
  })
  return out
}
