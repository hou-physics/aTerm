import { invoke } from '@tauri-apps/api/core'
import { listen, type Event } from '@tauri-apps/api/event'
import { isThemeMode, useTheme, type ThemeMode } from './store/theme'
import { useSettings } from './store/settings'

// Rust 侧 App 菜单里的"设置…"项（⌘,）被点击后，on_menu_event 会 emit 这个事件
// （见 src-tauri/src/lib.rs 的 emit_open_settings）；这里直接打开设置浮层。导出这个
// 函数（而不是内联在下面的 listen 调用里）是为了测试能直接拿到它，逐字断言
// listen 注册的正是这一个函数——与 closeRequest.ts 里 handleCloseRequested 同一
// 做法。
export function handleOpenSettingsMenuItem() {
  useSettings.getState().openSettings()
}

// Rust 侧菜单栏"主题"子菜单三项之一被点击后，on_menu_event 会 emit 这个事件
// （见 src-tauri/src/lib.rs 的 emit_theme_mode），payload 是 "default"/"dual"/
// "single" 三者之一。这里必须先校验 payload——不能直接把它透传给 setMode：
// event 的 payload 类型在编译期只是个 string，运行时如果 Rust 侧的 id/emit
// 分支和这里约定的字符串出现任何不一致（或者未来有人往同一个事件名塞了别的
// payload），透传会让 store 的 mode 字段落到一个 ThemeMode 类型之外的字符串上，
// 污染所有依赖 mode 做穷尽匹配的下游逻辑；校验失败直接忽略，不透传、不报错
// （对称于 Rust 侧 set_theme_mode_checked 对非法 mode 返回 Err 且不触碰任何状态）。
//
// 接收完整的 Event<string>（而不是拆出来的裸 payload）是为了能把这个函数本身直接
// 传给下面的 listen 调用——与 handleOpenSettingsMenuItem 同一做法，测试能逐字断言
// listen 注册的正是这一个函数，而不是断言某个内联包装闭包的行为。
export function handleThemeModeMenuEvent(event: Event<string>): void {
  if (!isThemeMode(event.payload)) return
  useTheme.getState().setMode(event.payload)
  // R2 修复（终审 Critical C1）：无条件补一次同步，不依赖下面 useTheme.subscribe 那条
  // "只在 mode 真的变化时才同步"的守卫。原因是 macOS 的 muda 库点击任何
  // CheckMenuItem 都会无条件先翻转该项的原生勾选态、再发事件（已读 muda 0.19.3
  // 源码 `platform_impl/macos/mod.rs` 核实）——也就是说，即使用户点的是当前**已经**
  // 勾选的那一项（例如当前 mode 已经是 'dual'，又点了一次「双主题跟随系统」），
  // 原生勾选态也已经被 muda 翻成了"未勾选"，三项此刻全部无勾选；而 `setMode('dual')`
  // 传入的是与 store 里当前 mode 相同的值，state.mode 不会变化，下面 subscribe 的守卫
  // 会把这次同步过滤掉——菜单就会永久停在零勾选，直到用户选了一个不同的模式才会
  // 恢复，直接违反规格§4.3「任意时刻恰好一个处于勾选态」。菜单点击这条路径必然扰动
  // 原生勾选态，与 store 里的 mode 是否真的发生变化无关，因此这里必须绕开那条守卫、
  // 无条件补一次同步；代价是 mode 真的改变时会发两次幂等 IPC（一次经这里，一次经
  // 下面的 subscribe），可接受，正确性优先。下面 subscribe 的守卫本身保留不动——
  // 它过滤的是 setLightThemeId/setDarkThemeId/setSingleThemeId/系统深色模式监听等
  // 压根不改 mode 的场景，那类场景仍然需要被过滤掉，不属于这里要处理的问题。
  syncThemeModeToMenu(event.payload)
}

// 前端 → Rust：把菜单栏"主题"三项的勾选态同步为与 store 当前 mode 一致的状态。
// 调用失败只 console.warn，绝不 `.catch(() => {})` 静默吞掉——本项目已有过一次
// 血的教训（src/store/layout.ts 的 resizeWindowForPanel 顶部注释）：一处静默吞异常
// 让面板窗口尺寸联动在打包版里完全失效，而 748 个测试全绿，直到用户真机使用才发现
// （根因是 core:window:allow-set-size 未授权）。这里的 invoke 走的是
// generate_handler! 注册的自定义命令、不经过那套 core:* ACL，理论上不该重演同一个
// 根因，但"调用失败就没人知道"这个错误模式本身与 ACL 无关，同样值得留痕。
function syncThemeModeToMenu(mode: ThemeMode) {
  invoke('set_theme_mode_checked', { mode }).catch((err) => {
    console.warn('主题菜单勾选态同步失败', err)
  })
}

// 应用启动、store 就绪后先同步一次——store/theme.ts 的 mode 初始值在模块加载时就
// 已经同步算好（readPersisted() 是同步调用，不是异步/Promise），这里 import 到
// useTheme 时它已经可以安全 getState()，不需要额外等待"就绪"事件。
syncThemeModeToMenu(useTheme.getState().mode)

// 此后每次 mode 变化都再同步一次：不管这次 setMode 是从设置浮层的模式按钮触发
// （AppearanceSection.tsx），还是从上面的 handleThemeModeMenuEvent（菜单栏点击）
// 触发，两条路径最终都走同一个 store 的 setMode，订阅这一个位置就能覆盖全部来源，
// 不需要在每个调用点各自补一次同步调用。只在 mode 真的发生变化时才同步：调用
// setMode 传入与当前相同的模式（例如用户在浮层里重复点了已经选中的那个按钮）时，
// Rust 侧勾选态本就已经是正确的（上一次真正的变化早就同步过了），重复调用没有
// 实际效果，白白多一次 IPC。
useTheme.subscribe((state, prevState) => {
  if (state.mode !== prevState.mode) syncThemeModeToMenu(state.mode)
})

// 与 closeRequest.ts 的 app-close-requested 监听同一位置、同一注册模式：模块顶层
// 立即发起监听（而不是等某个组件挂载时才注册），确保它在用户有机会用菜单/快捷键
// 之前就已经就绪；不在这里做 unlisten——这是应用级、生命周期与整个进程等长的单一
// 监听器（本应用只有一个窗口、一份菜单），不像 App.tsx 里 onDragDropEvent 那样绑定
// 某个组件的挂载/卸载，没有"卸载"这个概念可言，与 closeRequest.ts/ptyBuffer.ts 两个
// 既有的同类模块级监听保持一致。导出这个 Promise 只是为了让调用方（测试）在需要时
// 能等它就绪。
export const menuEventsReady: Promise<void> = Promise.all([
  listen('menu-open-settings', handleOpenSettingsMenuItem),
  listen<string>('menu-theme-mode', handleThemeModeMenuEvent),
])
  .then(() => undefined)
  .catch((err) => { console.error('设置菜单事件监听注册失败', err) })
