import { create } from 'zustand'

// 设置浮层左侧四个分类，顺序即左侧列表的展示顺序。第一项是「主题」——用户明确
// 否掉了「外观」这个说法（v3-2b brief），内部 id 用英文 theme 只是变量命名，
// UI 上可见文案与 aria-label 一律用「主题」，见 SettingsPanel.tsx 的 CATEGORIES。
export type SettingsCategory = 'theme' | 'terminal' | 'projects' | 'hooks'

// 只管设置浮层的开关，以及浮层内当前选中的分类（v3-2b：左侧分类列表 + 右侧详情，
// 一次只挂载选中那一个分区）。刻意不放进 store/layout.ts——那个文件已经承载面板
// 宽度、折叠状态、窗口尺寸联动、滚轮倍率等多项职责，继续堆积会让它更难读。
// 刻意不持久化：与 open 同一设计，重启应用后设置浮层关闭、分类回到默认「主题」，
// 不写 localStorage。
type SettingsState = {
  open: boolean
  activeCategory: SettingsCategory
  openSettings(): void
  closeSettings(): void
  setActiveCategory(category: SettingsCategory): void
}

export const useSettings = create<SettingsState>((set) => ({
  open: false,
  activeCategory: 'theme',
  openSettings: () => set({ open: true }),
  closeSettings: () => set({ open: false }),
  setActiveCategory: (category) => set({ activeCategory: category }),
}))
