import { create } from 'zustand'

const HINT_DURATION_MS = 2200

// ⌘D 新建窗格与两个拖拽入口（TabBar.tsx 把标签拖进窗格区、Sidebar.tsx 从「最近会话」
// 拖入）共用同一条内联轻提示——不是弹窗，定时自行消失（设计文档 §5-A/§5-B"已达 3 个
// 窗格 / 窄窗口装不下时拒绝并给出轻提示"）。此前这段状态是 App.tsx 组件内部的
// useState，只有 App 自己的 ⌘D 处理器能用；挪成独立 store 是为了让 TabBar.tsx /
// Sidebar.tsx 这两个新的拒绝来源也能触发同一条提示、同一处渲染（App.tsx 的
// .pane-hint），而不是各写一份自己的提示机制。
type HintState = {
  message: string | null
  show(msg: string): void
}

let timer: ReturnType<typeof setTimeout> | undefined

export const useHint = create<HintState>((set) => ({
  message: null,
  show: (msg) => {
    if (timer) clearTimeout(timer)
    set({ message: msg })
    timer = setTimeout(() => set({ message: null }), HINT_DURATION_MS)
  },
}))
