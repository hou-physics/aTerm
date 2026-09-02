import { create } from 'zustand'
import type { DropMode, DropTarget } from '../paneDrop'

// 拖放落点的共享状态：三个拖拽源（TabBar.tsx 把已打开标签拖进窗格区、Sidebar.tsx
// 把「最近会话」拖入、TabPanes.tsx 把窗格拖出成独立标签）各自在 pointermove 时用
// paneDrop.ts 的纯函数实时算出当前落点写进这里；DropIndicator.tsx / TabBar.tsx 只读
// 它来渲染各自的落点指示，互相解耦——拖拽源不需要知道指示条怎么画，指示条也不需要
// 关心是哪种来源在拖，拖拽结束（pointerup）后由拖拽源自己清空。
//
// target：落在某个窗格左/右半侧（场景 A/B 的落点指示，DropIndicator.tsx 消费）。
// dropMode：本次修复新增——落点语义（paneDrop.ts 的 DropMode），决定 DropIndicator
// 覆盖整个窗格（'fill'）还是半侧（'insert'）；target 为 null 时恒为 null，与 target
// 同一时机写入/清空（TabBar.tsx/Sidebar.tsx 的 pointermove 里紧跟着 setTarget 调用）。
// refusal：本次修复新增——若此刻松手会被拒绝，携带具体理由（"窗口太窄，还差 Npx"或
// "最多支持 3 个窗格"，见 paneLayout.ts 的 previewPaneDrop），供 DropIndicator 渲染
// 持久的"拒绝"视觉与文案（Fix 3：不能再让用户等到松手才知道）；装得下或 target 为
// null 时恒为 null。
// tabBarIndex：把窗格拖出时光标落在标签栏（TabBar.tsx 的 `.tabbar`）上应插入的下标
// （设计文档 §5-C，TabBar.tsx 自己消费并渲染一条插入指示线——与 target 是同一套
// "拖拽源实时写、指示条只读"模式，只是落点所在的容器不同，值的形状也不同，没有
// 理由合并成一个字段）。
// tearOut：V3.3 设计文档 §4.1 新增——标签拖拽过程中，光标一旦落在当前窗口边界之外
// （src/tabTearOut.ts 的 shouldTearOut 纯函数判定），TabBar.tsx 写入 true；落点回到
// 窗口内、或这次拖拽根本不是标签拖拽，写回 false。TabBar.tsx 自己的
// TabBarTearOutIndicator 消费它渲染「将拖出」的视觉提示，同一套"拖拽源实时写、指示条
// 只读"模式。只在 TabBar.tsx 这一个拖拽源里被写入——Sidebar.tsx/TabPanes.tsx 那两个
// 拖拽源不涉及"标签拖出窗口"这个场景（设计文档明确只做标签拖出，见 §3"明确不做"），
// 因此恒为 false，不受影响。
export type DropRefusal = { reason: string } | null

type DndState = {
  target: DropTarget | null
  dropMode: DropMode | null
  refusal: DropRefusal
  tabBarIndex: number | null
  tearOut: boolean
  setTarget(target: DropTarget | null): void
  setDropMode(mode: DropMode | null): void
  setRefusal(refusal: DropRefusal): void
  setTabBarIndex(index: number | null): void
  setTearOut(tearOut: boolean): void
}

export const useDnd = create<DndState>((set) => ({
  target: null,
  dropMode: null,
  refusal: null,
  tabBarIndex: null,
  tearOut: false,
  setTarget: (target) => set({ target }),
  setDropMode: (dropMode) => set({ dropMode }),
  setRefusal: (refusal) => set({ refusal }),
  setTabBarIndex: (index) => set({ tabBarIndex: index }),
  setTearOut: (tearOut) => set({ tearOut }),
}))
