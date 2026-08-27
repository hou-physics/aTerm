import { create } from 'zustand'
import type { DropTarget } from '../paneDrop'

// 拖放落点的共享状态：三个拖拽源（TabBar.tsx 把已打开标签拖进窗格区、Sidebar.tsx
// 把「最近会话」拖入、TabPanes.tsx 把窗格拖出成独立标签）各自在 pointermove 时用
// paneDrop.ts 的纯函数实时算出当前落点写进这里；DropIndicator.tsx / TabBar.tsx 只读
// 它来渲染各自的落点指示，互相解耦——拖拽源不需要知道指示条怎么画，指示条也不需要
// 关心是哪种来源在拖，拖拽结束（pointerup）后由拖拽源自己清空。
//
// target：落在某个窗格左/右半侧（场景 A/B 的落点指示，DropIndicator.tsx 消费）。
// tabBarIndex：把窗格拖出时光标落在标签栏（TabBar.tsx 的 `.tabbar`）上应插入的下标
// （设计文档 §5-C，TabBar.tsx 自己消费并渲染一条插入指示线——与 target 是同一套
// "拖拽源实时写、指示条只读"模式，只是落点所在的容器不同，值的形状也不同，没有
// 理由合并成一个字段）。
type DndState = {
  target: DropTarget | null
  tabBarIndex: number | null
  setTarget(target: DropTarget | null): void
  setTabBarIndex(index: number | null): void
}

export const useDnd = create<DndState>((set) => ({
  target: null,
  tabBarIndex: null,
  setTarget: (target) => set({ target }),
  setTabBarIndex: (index) => set({ tabBarIndex: index }),
}))
