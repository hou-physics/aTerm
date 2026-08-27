import { create } from 'zustand'
import type { DropTarget } from '../paneDrop'

// 拖放落点的共享状态：两个拖拽源（TabBar.tsx 把已打开标签拖进窗格区、Sidebar.tsx
// 把「最近会话」拖入）各自在 pointermove 时用 paneDrop.ts 的 resolveDropTarget 实时
// 算出当前落点（或 null）写进这里；DropIndicator.tsx 只读它来渲染半透明落点指示，
// 互相解耦——拖拽源不需要知道指示条怎么画，指示条也不需要关心是哪种来源在拖，
// 拖拽结束（pointerup）后由拖拽源自己清空。
type DndState = {
  target: DropTarget | null
  setTarget(target: DropTarget | null): void
}

export const useDnd = create<DndState>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
}))
