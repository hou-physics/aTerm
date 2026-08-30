import { create } from 'zustand'

const HINT_DURATION_MS = 2200

// ⌘D 新建窗格与两个拖拽入口（TabBar.tsx 把标签拖进窗格区、Sidebar.tsx 从「最近会话」
// 拖入）共用同一条内联轻提示——不是弹窗，定时自行消失（设计文档 §5-A/§5-B"已达 3 个
// 窗格 / 窄窗口装不下时拒绝并给出轻提示"）。此前这段状态是 App.tsx 组件内部的
// useState，只有 App 自己的 ⌘D 处理器能用；挪成独立 store 是为了让 TabBar.tsx /
// Sidebar.tsx 这两个新的拒绝来源也能触发同一条提示、同一处渲染（App.tsx 的
// .pane-hint），而不是各写一份自己的提示机制。
//
// Task 8：主页「隐藏项目」需要一条可点击撤销的提示——action 字段是这条提示可选携带的
// 一个按钮（label + onClick）。action 是可选参数，不传时为 null，此前三个调用点
// （⌘D 拒绝新建窗格、TabBar.tsx/Sidebar.tsx 拖拽拒绝）都只传一个参数，照常工作。
// 超时清空必须把 message 与 action 一起清掉——只清 message 会在屏幕上留下一个没有
// 文字、却仍然可点的按钮（该按钮的 onClick 闭包还留着上一条提示的动作）。
type HintAction = { label: string; onClick: () => void }
type HintState = {
  message: string | null
  action: HintAction | null
  show(msg: string, action?: HintAction): void
}

let timer: ReturnType<typeof setTimeout> | undefined

export const useHint = create<HintState>((set) => ({
  message: null,
  action: null,
  show: (msg, action) => {
    if (timer) clearTimeout(timer)
    set({ message: msg, action: action ?? null })
    timer = setTimeout(() => set({ message: null, action: null }), HINT_DURATION_MS)
  },
}))
