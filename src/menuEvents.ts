import { listen } from '@tauri-apps/api/event'
import { useSettings } from './store/settings'

// Rust 侧 App 菜单里的"设置…"项（⌘,）被点击后，on_menu_event 会 emit 这个事件
// （见 src-tauri/src/lib.rs 的 emit_open_settings）；这里直接打开设置浮层。导出这个
// 函数（而不是内联在下面的 listen 调用里）是为了测试能直接拿到它，逐字断言
// listen 注册的正是这一个函数——与 closeRequest.ts 里 handleCloseRequested 同一
// 做法。
export function handleOpenSettingsMenuItem() {
  useSettings.getState().openSettings()
}

// 与 closeRequest.ts 的 app-close-requested 监听同一位置、同一注册模式：模块顶层
// 立即发起监听（而不是等某个组件挂载时才注册），确保它在用户有机会用菜单/快捷键
// 之前就已经就绪；不在这里做 unlisten——这是应用级、生命周期与整个进程等长的单一
// 监听器（本应用只有一个窗口、一份菜单），不像 App.tsx 里 onDragDropEvent 那样绑定
// 某个组件的挂载/卸载，没有"卸载"这个概念可言，与 closeRequest.ts/ptyBuffer.ts 两个
// 既有的同类模块级监听保持一致。导出这个 Promise 只是为了让调用方（测试）在需要时
// 能等它就绪。
export const menuEventsReady: Promise<void> = listen('menu-open-settings', handleOpenSettingsMenuItem)
  .then(() => undefined)
  .catch((err) => { console.error('设置菜单事件监听注册失败', err) })
