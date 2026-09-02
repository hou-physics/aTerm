import { invoke } from '@tauri-apps/api/core'
import { listen, type Event } from '@tauri-apps/api/event'
import { isThemeMode, useTheme, type ThemeMode } from './store/theme'
import { useSettings } from './store/settings'
import { currentWindowLabel } from './windowLabel'

// ── 菜单事件是**定向**投递的（V3.3 §5.4）──────────────────────────────────────
//
// macOS 的菜单栏只有一份，但它承载的这两件事都是窗口级的："设置…"要打开的是某一个
// 窗口的设置浮层，「主题」三项要改的是某一个窗口的 store。V3.2 只有一个窗口时
// `app.emit` 广播与定向没有区别；多窗口之后广播意味着点一次"设置…"每个窗口各弹一个
// 浮层。Rust 侧（`emit_open_settings`/`emit_theme_mode`）因此改成
// `emit_to(当前聚焦窗口, …)`，载荷里带一个 `target` 字段。
//
// **这边必须两头都做**（Ruling 8，本计划已为此吃过一次 Critical）：
//   1. 注册时传 `{ target: 本窗口 label }`——不传 options 的 `listen` 落成
//      `{ kind: 'Any' }`，而 `tauri-2.11.5/src/event/listener.rs:306-311` 的
//      `match_any_or_filter` 首项就是 `*target == EventTarget::Any`，Any 监听器对
//      `emit_to` 的 label 过滤**无条件命中**——只靠 Rust 那一头等于没定向；
//   2. handler 里再比对一次 `payload.target` 是不是自己。只做第 1 条今天能跑，但
//      唯一的防线就是那一个 option，谁把它删了（或者哪天 listen 的默认值变了）就
//      全盘失效，而失效的表现是"每个窗口都弹设置浮层"这种容易被当成小毛病忽略的
//      现象，不会有人去查是不是防护塌了。
//
// `target` 为 `null` 表示 Rust 侧取不到聚焦窗口、**降级成了广播**（见 lib.rs 的
// `MenuDelivery::BroadcastFallback`），此时无条件接受——对这两条事件来说，最坏后果
// 只是多开一个浮层/多改一次主题。载荷整个缺失（例如某天有人把 Rust 那侧改回裸载荷）
// 同样按"接受"处理：这两个菜单项退回 V3.2 的广播行为是可接受的降级，而"静默失灵、
// ⌘, 按了没反应"不是。**这条宽松规则只对这两条事件成立**，不可类推到
// `window-close-requested` 那种"广播出去每个窗口都会杀掉自己会话"的事件上。
export type MenuTargetPayload = { target?: string | null }

/** 这条菜单事件是不是发给本窗口的。导出供测试直接调用（它是 Ruling 8 的第二层防护
 *  本体，值得单独有用例，而不是只能透过两个 handler 间接观察）。 */
export async function isMenuEventForThisWindow(payload: MenuTargetPayload | null | undefined): Promise<boolean> {
  const target = payload?.target
  if (typeof target !== 'string') return true // 降级广播 / 载荷缺失，见上方注释
  return target === (await currentWindowLabel())
}

// Rust 侧 App 菜单里的"设置…"项（⌘,）被点击后，on_menu_event 会 emit_to 当前聚焦的
// 窗口（见 src-tauri/src/lib.rs 的 emit_open_settings）；这里校验过 target 之后打开
// 设置浮层。导出这个函数（而不是内联在下面的 listen 调用里）是为了测试能直接拿到它，
// 逐字断言 listen 注册的正是这一个函数——与 closeRequest.ts 里 handleCloseRequested
// 同一做法。
//
// 返回 Promise 而不是同步函数：target 校验要读本窗口 label，而 currentWindowLabel()
// 是异步的（`await import('@tauri-apps/api/window')`，理由见 windowLabel.ts）。把这条
// async 链暴露出去而不是用一个丢弃返回值的包装闭包，调用方（包括测试）才能可靠地等到
// 它真正跑完——与 closeRequest.ts 的 handleCloseRequested 同一考量。
export async function handleOpenSettingsMenuItem(event: Event<MenuTargetPayload>): Promise<void> {
  if (!(await isMenuEventForThisWindow(event.payload))) return
  useSettings.getState().openSettings()
}

// Rust 侧菜单栏"主题"子菜单三项之一被点击后，on_menu_event 会 emit_to 当前聚焦的窗口
// （见 src-tauri/src/lib.rs 的 emit_theme_mode），载荷是
// `{ target, mode }`，mode 为 "default"/"dual"/"single" 三者之一。
//
// **载荷 V3.3 由裸字符串升格成对象**：Ruling 8 的第二层防护需要一个可比对的 target
// 字段，裸字符串塞不下第二个值。
//
// mode 必须先校验——不能直接把它透传给 setMode：payload 的类型在编译期只是个 string，
// 运行时如果 Rust 侧的 id/emit 分支和这里约定的字符串出现任何不一致（或者未来有人往
// 同一个事件名塞了别的 payload），透传会让 store 的 mode 字段落到一个 ThemeMode 类型
// 之外的字符串上，污染所有依赖 mode 做穷尽匹配的下游逻辑；校验失败直接忽略，不透传、
// 不报错（对称于 Rust 侧 set_theme_mode_checked 对非法 mode 返回 Err 且不触碰任何状态）。
//
// 接收完整的 Event（而不是拆出来的裸 payload）是为了能把这个函数本身直接传给下面的
// listen 调用——与 handleOpenSettingsMenuItem 同一做法，测试能逐字断言 listen 注册的
// 正是这一个函数，而不是断言某个内联包装闭包的行为。
export type ThemeModeMenuPayload = MenuTargetPayload & { mode?: string | null }

export async function handleThemeModeMenuEvent(event: Event<ThemeModeMenuPayload>): Promise<void> {
  if (!(await isMenuEventForThisWindow(event.payload))) return
  const mode = event.payload?.mode
  if (!isThemeMode(typeof mode === 'string' ? mode : null)) return
  useTheme.getState().setMode(mode as ThemeMode)
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
  syncThemeModeToMenu(mode as ThemeMode)
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
//
// V3.3 多窗口下这条订阅还会被**第三条**路径触发：别的窗口改了主题、经 src/themeSync.ts
// 广播过来、本窗口重新应用（那同样是一次真实的 mode 变化）。这时本窗口也会同步一次
// 菜单勾选态——菜单栏是应用级的一份，写的又是同一个值，幂等且结果正确；N 个窗口各写
// 一次只是多几次无害的 IPC，不需要为此加窗口判定（"只让聚焦窗口写"反而要多维护一个
// 谁该负责的规则，而那个规则错了就是菜单勾选态与实际主题对不上）。
useTheme.subscribe((state, prevState) => {
  if (state.mode !== prevState.mode) syncThemeModeToMenu(state.mode)
})

// 与 closeRequest.ts 的 app-close-requested 监听同一位置、同一注册模式：模块顶层
// 立即发起监听（而不是等某个组件挂载时才注册），确保它在用户有机会用菜单/快捷键
// 之前就已经就绪；不在这里做 unlisten——这是应用级、生命周期与整个进程等长的单一
// 监听器（每个窗口各一份，随窗口一同消失），不像 App.tsx 里 onDragDropEvent 那样绑定
// 某个组件的挂载/卸载，没有"卸载"这个概念可言，与 closeRequest.ts/ptyBuffer.ts 两个
// 既有的同类模块级监听保持一致。导出这个 Promise 只是为了让调用方（测试）在需要时
// 能等它就绪。
//
// **两条监听都限定 target 为本窗口 label**（V3.3 §5.4）：这是 Ruling 8 两层防护的
// 第一层，理由见文件顶部注释。与 closeRequest.ts 的 app-close-requested 监听同一写法。
export const menuEventsReady: Promise<void> = (async () => {
  const target = await currentWindowLabel()
  await Promise.all([
    listen<MenuTargetPayload>('menu-open-settings', handleOpenSettingsMenuItem, { target }),
    listen<ThemeModeMenuPayload>('menu-theme-mode', handleThemeModeMenuEvent, { target }),
  ])
})()
  .then(() => undefined)
  .catch((err) => { console.error('设置菜单事件监听注册失败', err) })
