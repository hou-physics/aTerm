import { create } from 'zustand'

// 只管设置浮层的开关。刻意不放进 store/layout.ts——那个文件已经承载面板宽度、
// 折叠状态、窗口尺寸联动、滚轮倍率等多项职责，继续堆积会让它更难读。
// 刻意不持久化：重启应用后设置浮层应当是关闭的。
type SettingsState = {
  open: boolean
  openSettings(): void
  closeSettings(): void
}

export const useSettings = create<SettingsState>((set) => ({
  open: false,
  openSettings: () => set({ open: true }),
  closeSettings: () => set({ open: false }),
}))
