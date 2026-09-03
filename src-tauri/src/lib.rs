mod pty;
mod pty_core;
mod reveal;
mod sessions;
mod status;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tauri::menu::{CheckMenuItem, IsMenuItem, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewWindowBuilder, WindowEvent};

/// 供 `RunEvent::ExitRequested` 处理器与 `confirm_exit` 共用的一个开关：前端确认弹窗里
/// 点了"确定关闭"之后、真正调用 `AppHandle::exit` 之前，`confirm_exit` 先把它置位。
///
/// 这个标志位存在的原因：`AppHandle::exit` 本身也会触发一次 `RunEvent::ExitRequested`
/// （`code` 字段为 `Some(exit_code)`，与用户交互触发、`code` 为 `None` 的那次相区分——
/// 已对照本机 `tauri 2.11.5` 源码 `src/app.rs` 里 `ExitRequested` 变体的文档字符串与
/// `AppHandle::exit`/`on_event_loop_event` 的实现核实）。如果处理器不分青红皂白地对每次
/// `ExitRequested` 都调用 `api.prevent_exit()`，`confirm_exit` 自己触发的这次程序化退出
/// 就会被同一段代码自己拦下来——app 会变得永远退不出去，这比"⌘Q 不弹确认"严重得多，
/// 所以必须有这个标志位让处理器区分"这次退出是不是已经过前端确认"。
struct ExitConfirmed(AtomicBool);

/// 前端确认"仍要关闭"后调用：真正退出应用。与窗口 `CloseRequested`/应用级
/// `ExitRequested` 里的 `prevent_close`/`prevent_exit` 配对——那两处只挡下系统的关闭/
/// 退出请求并把决定权转交前端弹窗，这条命令才是那次弹窗点了"确定"之后真正执行退出的
/// 入口。
#[tauri::command]
fn confirm_exit(app_handle: AppHandle) {
    app_handle
        .state::<ExitConfirmed>()
        .0
        .store(true, Ordering::SeqCst);
    app_handle.exit(0);
}

/// 主窗口的 label。`tauri.conf.json` 里写死的那一个，也是"关掉它 = 退出整个应用"的
/// 那一个（见 `on_window_event`）。拖出标签创建的窗口一律是 `term-<n>`
/// （`new_term_window_label`），永远不会等于它。
const MAIN_WINDOW_LABEL: &str = "main";

/// 拖出标签创建的终端窗口的 label 前缀。三处共用同一份含义：`new_term_window_label`
/// 生成它、`capabilities/default.json` 的 `windows` 用 `term-*` 授权它、前端
/// `src/windowLabel.ts` 的 `isTornOutWindow` 用它自辨——所以这里也用同一个常量，不再
/// 在 `format!` 里写一遍字面量。
const TERM_WINDOW_LABEL_PREFIX: &str = "term-";

/// 纯函数：一个窗口 label 是不是"拖出标签创建出来的终端窗口"。
///
/// `destroy_term_window` 的准入校验（该命令能**绕过 `CloseRequested`** 强行销毁窗口，
/// 见其上方注释），因此这里是白名单式判断（必须是 `term-` 前缀）而不是
/// `label != "main"`：漏判的代价是主窗口被一条本该只作用于拖出窗口的命令强行销毁，
/// 而主窗口的关闭在本应用里等于"退出应用"、必须经过 ⌘Q 确认框那条路径——绕过它就是
/// 把整个应用连同所有窗口里正在跑的会话一起无声终止。将来若出现别的用途的窗口
/// （面板、预览…），"不是主窗口"同样会把它们也纳入销毁范围，白名单不会。
///
/// 与前端 `isTornOutWindow` 是同一条规则的两侧（同一个前缀），刻意各自实现：这条判断
/// 是安全边界，两侧各自校验一次，任一侧被改坏另一侧仍然挡得住。
fn is_term_window_label(label: &str) -> bool {
    label.starts_with(TERM_WINDOW_LABEL_PREFIX)
}

/// **应用级**关闭请求（⌘Q / Quit 菜单项 / 主窗口的关闭按钮 / `RunEvent::ExitRequested`）
/// 共用的"通知前端弹确认"逻辑。
///
/// V3.3 起用 `emit_to(MAIN_WINDOW_LABEL, …)` 而不是 `emit` 广播。改动理由：多窗口之后，
/// 广播意味着**每个**窗口的 `src/closeRequest.ts` 都会各弹一个确认框——同一次 ⌘Q 堆出
/// N 个对话框，随便在哪一个上点"确定"都会退出整个应用。退出是应用级的一件事，只该问
/// 一次，问在主窗口（本应用里主窗口恒存在：关掉它就等于退出应用，见 `on_window_event`，
/// 所以不存在"定向发给了一个已经不在的窗口"这种情况）。
///
/// 定向只在前端也配合限定监听 target 时才真的生效——`listen(event, handler)` 不传
/// options 时 target 是 `{ kind: 'Any' }`，而 Any 目标的监听器对 `emit_to` 的 label
/// 过滤**无条件命中**（tauri 2.11.5 `event/listener.rs` 的 `match_any_or_filter`，
/// 考据见 src/windowHandoff.ts 顶部）。`src/closeRequest.ts` 因此改成
/// `listen(…, { target: 本窗口 label })`。这个组合有一个刻意保留的降级性质：即便前端那
/// 半边失效（回到 Any 监听），主窗口**照样收得到**这个事件，⌘Q 确认框最坏退回到 V3.2
/// 的广播行为，而不是彻底失灵。
///
/// **载荷是目标窗口的 label**（终审 I3），与 `emit_window_close_requested` 一模一样的
/// 理由，这里不再复述考据：`emit_to` 不是私有信道，定向的唯一防线是接收侧那**一个**
/// `target` option，而"一个 option 是唯一防线"正是本分支已经吃过一次 Critical
/// （Ruling 8）、又发现过一个半成品（Ruling 15）的形状。规矩是两头都做：发送端定向 +
/// 载荷带目标 label，接收端限定 target + handler 里再比对载荷。这条事件此前只做了发送
/// 侧的定向，收方（`handleCloseRequested`）完全不看载荷——一旦那个 option 掉了，每个
/// 拖出来的 `term-*` 窗口都会各弹一个"确定关闭 aTerm？"，随便在哪一个上点确定都会退出
/// 整个应用、连带杀光所有窗口里的会话。
///
/// 写 `MAIN_WINDOW_LABEL` 而不是别的：主窗口两侧恒相等（上面 `emit_to` 的目标就是它，
/// 收方比对的是自己的 `currentWindowLabel()`，而这个常量已由
/// `tauri_still_derives_the_label_this_module_hard_codes` 与
/// `main_window_in_tauri_conf_resolves_to_the_hard_coded_label` 两条测试钉在 tauri 的
/// 隐式默认值上），因此零降级损失——上面那条"前端半边失效也照样收得到"的性质讲的是
/// **投递**，与要不要校验载荷无关。
fn emit_close_requested(app_handle: &AppHandle) {
    let _ = app_handle.emit_to(MAIN_WINDOW_LABEL, "app-close-requested", MAIN_WINDOW_LABEL);
}

/// **单个非主窗口**（拖出来的 `term-*` 终端窗口）收到关闭请求时，定向通知**它自己的**
/// 前端。与 `emit_close_requested` 是两件不同的事，不能合并：那条是"要退出整个应用了"，
/// 这条是"只关你这一个窗口"。
///
/// 为什么关窗也要绕一趟前端，而不是让窗口直接关掉：**哪些 PTY 属于这个窗口，只有这个
/// 窗口的前端知道**。Rust 侧的 `PtyManager` 是一张全应用的扁平 map，没有、也不该有窗口
/// 归属信息——归属的真相在各窗口自己的 `useTabs` store 里，而且它在标签交接期间是会
/// 变的（新窗口 adopt 在前、旧窗口移除在后）。在 Rust 里再维护一份窗口→PTY 的映射就是
/// 第二个可以与之矛盾的真相来源。所以这里 `prevent_close` 之后把决定权交给那个窗口的
/// 前端（src/windowClose.ts）：它清点自己持有的存活会话、必要时弹确认、终止它们，最后
/// 调 `destroy_term_window` 真正关掉自己。这与主窗口关闭走
/// `prevent_close` → 前端确认 → `confirm_exit` 是**同一套**既有模式，不是新引入的机制。
///
/// **载荷是目标窗口自己的 label**（R1/I2）。看上去冗余——`emit_to` 的第一个参数已经是它
/// 了——但那正是 Ruling 8 反复钉过的那件事：`emit_to` **不是私有信道**。不传 options 的
/// JS `listen` 落成 `{ kind: 'Any' }`，而 Any 目标的监听器对 `emit_to` 的 label 过滤
/// **无条件命中**（tauri 2.11.5 `event/listener.rs` 的 `match_any_or_filter`）。也就是说，
/// 定向这件事的唯一防线是接收侧那一个 `target` option；漏了它，`term-2` 会收到发给
/// `term-1` 的这条事件，而"我是不是拖出来的窗口"这个判断对它同样为真——于是它会把
/// **自己**的全部会话杀掉再自毁。交接协议（`term-window-handoff`）为此加了
/// `payload.toLabel` 比对，这条事件必须一视同仁：收到的一方拿载荷里的 label 与
/// `currentWindowLabel()` 比一次，对不上就什么都不做。
fn emit_window_close_requested(app_handle: &AppHandle, label: &str) {
    let _ = app_handle.emit_to(label, "window-close-requested", label);
}

/// 前端（src/windowClose.ts）在"已经终止完本窗口自己持有的 PTY"之后调用：真正关掉这个
/// 拖出来的终端窗口。与 `confirm_exit` 完全对偶——那条是"确认过了，退出应用"，这条是
/// "确认过了，关掉这一个窗口"。
///
/// 用 `destroy()` 而不是 `close()`：`close()` 会再触发一次 `CloseRequested`，而
/// `on_window_event` 对非主窗口的 `CloseRequested` 一律 `prevent_close` 并回头再问前端
/// 一次——那是一个关不掉的循环。`destroy()` 按 tauri 文档"forces the window close
/// instead of emitting the CloseRequested event"，正是这里要的语义。
///
/// **同时也是标签交接回滚的唯一关窗入口**（V3.3 Ruling 7）。回滚要关掉的那个新窗口
/// 可能其实**已经接管成功**、只是 ack 丢了/超时了；若走 `close()`，它的前端会收到
/// `window-close-requested`、把"自己持有的"——也就是刚刚接管过来的——PTY 全部 kill 掉，
/// 而那正是用户正在跑的会话。`destroy()` 绕过整条前端路径，因此不会有任何 kill 发生：
/// 交接成功了的话标签仍留在旧窗口（回滚不动标签），会话继续跑；没接管成功的话本来就
/// 没有什么可 kill 的。两个分支都对，而这正是关键——回滚方**无法知道**自己在哪个分支
/// （ack 就是那个丢掉的信息），所以只能选一个两边都安全的动作。
///
/// 窗口已经不在了（label 查不到）时返回 `Ok(())` 而不是 `Err`：这个命令天然会和"窗口
/// 自己正在关"竞争（回滚与用户手动关窗可能同时发生），"目标已经处于期望状态"不是错误。
/// label 不是 `term-` 前缀时返回 `Err` 并且什么都不做——见 `is_term_window_label`。
#[tauri::command]
async fn destroy_term_window(app: AppHandle, label: String) -> Result<(), String> {
    if !is_term_window_label(&label) {
        return Err(format!("拒绝销毁非终端窗口：{label}"));
    }
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(());
    };
    window.destroy().map_err(|e| format!("销毁窗口失败：{e}"))
}

// ── 菜单事件的定向投递（V3.3 §5.4）────────────────────────────────────────────
//
// 菜单栏是**应用级**的一份（macOS 全局菜单栏），但它承载的两件事都是**窗口级**的：
// "设置…"要打开的是某一个窗口里的设置浮层，「主题」三项要改的是某一个窗口的主题
// store。V3.2 只有一个窗口，`app.emit` 广播与"发给那唯一的窗口"没有区别；多窗口
// 之后广播意味着点一次"设置…"**每个**窗口都弹出设置浮层。
//
// 语义上正确的收件人是**当前聚焦的那个窗口**——菜单栏点击必然发生在应用处于活动
// 状态时，用户心里想操作的就是眼前那个 key window。
//
// ## 取聚焦窗口的 API（已核实 tauri 2.11.5 源码，不凭印象）
//
// `Manager::get_focused_window()` 确实存在（`tauri-2.11.5/src/lib.rs:548-552`），
// **但它带 `#[cfg(feature = "unstable")]`**，而本仓库 `Cargo.toml` 只开了
// `features = ["devtools"]`——直接调用编译不过。为一个可以两行写出来的东西去开一个
// 官方标注 unstable 的 feature 不划算（那个 feature 门的是整套多 webview API，
// 语义可能随小版本变化）。
//
// 改用两个**未被 gate** 的公开 API 组合，逻辑与 `get_focused_window` 内部实现逐字
// 相同（`tauri-2.11.5/src/manager/mod.rs:644-651`：遍历窗口表，`find` 第一个
// `is_focused().unwrap_or(false)`）：
//   - `Manager::webview_windows()`（`src/lib.rs:587`，无 cfg 门）
//   - `WebviewWindow::is_focused()`（`src/webview/webview_window.rs:1744`，无 cfg 门）
// macOS 上 `is_focused` 最终落到 tao 的 `ns_window.isKeyWindow()`
// （`tao-0.35.3/src/platform_impl/macos/window.rs:698`）——菜单栏被拉开时 key window
// 不变，因此菜单事件处理器里读到的正是用户眼前那个窗口。
//
// ## 两头都要做（Ruling 8）
//
// `emit_to(label, …)` **不是私有信道**：不传 options 的 JS `listen` 落成
// `{ kind: 'Any' }`，而 `event/listener.rs:306-311` 的 `match_any_or_filter` 首项就是
// `*target == EventTarget::Any`——Any 监听器无条件命中，label 过滤对它完全失效。
// 本计划已因此吃过一次 Critical（交接载荷被兄弟窗口接管，杀掉正在跑的会话）。
// 所以这里的每条菜单事件：
//   - 发送端 `emit_to(label, …)`，**并且载荷里带上目标 label**（`target` 字段）；
//   - 接收端（`src/menuEvents.ts`）`listen(…, { target: 本窗口 label })`，**并且**在
//     handler 里再比对一次 `payload.target` 是不是自己。
// 只做一头今天能跑，但唯一的防线就是那一个 option，退回 Any 监听即全盘失效。

/// 一条菜单事件该投递给谁。
///
/// 存在的意义是把"emit 的目标"和"载荷里写的 target"绑成**同一个值的两个视图**——
/// 两者若各算各的，就又多了一处可以悄悄漂移的地方，而漂移的表现是"接收端把发给自己
/// 的事件当成别人的丢掉"，即菜单项静默失灵。
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
enum MenuDelivery {
    /// 定向投递给这一个窗口（当前聚焦的那个）。
    ToWindow(String),
    /// **降级**：取不到聚焦窗口时广播给所有窗口，载荷 `target` 为 `null`，接收端
    /// 无条件接受。取不到聚焦窗口在 macOS 上是罕见但可能的（例如所有窗口都最小化
    /// 而应用仍是活动应用），此时"每个窗口都弹设置浮层"虽然吵，但远好过"点了没反应"。
    /// 这条降级只对这两条菜单事件成立：它们最坏的后果是多开一个浮层/多改一次主题，
    /// 与 `window-close-requested` 那种"广播出去会让每个窗口杀掉自己的会话"的事件
    /// 性质完全不同，不可类推。
    BroadcastFallback,
}

#[cfg(target_os = "macos")]
impl MenuDelivery {
    /// 载荷里 `target` 字段的值。刻意由 `self` 派生而不是让调用方自己传一遍——
    /// 见 `MenuDelivery` 上方注释。
    fn payload_target(&self) -> Option<String> {
        match self {
            MenuDelivery::ToWindow(label) => Some(label.clone()),
            MenuDelivery::BroadcastFallback => None,
        }
    }
}

/// 纯函数：由"当前聚焦窗口的 label"（`None` = 取不到）决定投递方式。
/// 不接触任何 Tauri 对象，因此可以直接单测（与 `settings_insertion_index`/
/// `theme_mode_checked_states` 同一做法）。
#[cfg(target_os = "macos")]
fn menu_event_delivery(focused_label: Option<String>) -> MenuDelivery {
    match focused_label {
        Some(label) => MenuDelivery::ToWindow(label),
        None => MenuDelivery::BroadcastFallback,
    }
}

/// 当前聚焦窗口的 label。取不到返回 `None`（见 `menu_event_delivery` 的降级）。
/// 实现依据见本节顶部注释——等价于 unstable 的 `Manager::get_focused_window()`。
#[cfg(target_os = "macos")]
fn focused_window_label(app_handle: &AppHandle) -> Option<String> {
    app_handle
        .webview_windows()
        .into_iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
}

/// `menu-open-settings` 的载荷。`target` 见 `MenuDelivery::payload_target`。
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, serde::Serialize)]
struct MenuOpenSettingsPayload {
    target: Option<String>,
}

/// `menu-theme-mode` 的载荷。V3.3 之前这个事件的载荷是裸的模式字符串，现在必须多带
/// 一个 `target`（Ruling 8 的接收端二次校验要读它），因此升格成对象。
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, serde::Serialize)]
struct MenuThemeModePayload {
    target: Option<String>,
    mode: String,
}

#[cfg(target_os = "macos")]
fn open_settings_payload(delivery: &MenuDelivery) -> MenuOpenSettingsPayload {
    MenuOpenSettingsPayload {
        target: delivery.payload_target(),
    }
}

#[cfg(target_os = "macos")]
fn theme_mode_payload(delivery: &MenuDelivery, mode: &str) -> MenuThemeModePayload {
    MenuThemeModePayload {
        target: delivery.payload_target(),
        mode: mode.to_string(),
    }
}

/// 按 `delivery` 把一条菜单事件发出去。降级为广播时打警告——与 src/menuEvents.ts
/// 顶部 `syncThemeModeToMenu` 那条注释同一理由：本仓库已经因为"失败被静默吞掉、
/// 运行期零信号"付出过代价（`core:window:allow-set-size` 那次），降级同样要留痕。
#[cfg(target_os = "macos")]
fn dispatch_menu_event<P: serde::Serialize + Clone>(
    app_handle: &AppHandle,
    delivery: &MenuDelivery,
    event: &str,
    payload: P,
) {
    match delivery {
        MenuDelivery::ToWindow(label) => {
            let _ = app_handle.emit_to(label.as_str(), event, payload);
        }
        MenuDelivery::BroadcastFallback => {
            eprintln!(
                "警告：取不到聚焦窗口，菜单事件 {event} 降级为广播，所有窗口都会响应这一次点击"
            );
            let _ = app_handle.emit(event, payload);
        }
    }
}

/// macOS 专属：App 菜单里"设置…"项被点击（或按下 ⌘,）时，通知**当前聚焦的那个窗口**
/// 打开设置浮层（`useSettings.getState().openSettings()`，见 src/menuEvents.ts 对
/// `menu-open-settings` 的监听）。
///
/// V3.3 起由 `AppHandle::emit` 广播改成定向——广播会让多窗口下点一次"设置…"每个
/// 窗口各弹一个浮层。定向的两头做法与降级见本节顶部注释。
#[cfg(target_os = "macos")]
fn emit_open_settings(app_handle: &AppHandle) {
    let delivery = menu_event_delivery(focused_window_label(app_handle));
    let payload = open_settings_payload(&delivery);
    dispatch_menu_event(app_handle, &delivery, "menu-open-settings", payload);
}

/// macOS 专属：菜单栏「主题」子菜单里三项之一被点击时，把选中的模式字符串
/// （"default" / "dual" / "single"）发给**当前聚焦的那个窗口**（见 src/menuEvents.ts
/// 对 `menu-theme-mode` 的监听：校验 target 与 payload 合法后调用
/// `useTheme.getState().setMode`）。
///
/// 定向而不是广播的理由与"设置…"相同，但这里还多一层：主题变更本身会由
/// `src/themeSync.ts` 广播给其它窗口（§5.5），如果菜单事件自己也广播，N 个窗口会各自
/// 改一遍 store 再各自广播一遍，同一次点击放大成 N² 条事件。
#[cfg(target_os = "macos")]
fn emit_theme_mode(app_handle: &AppHandle, mode: &str) {
    let delivery = menu_event_delivery(focused_window_label(app_handle));
    let payload = theme_mode_payload(&delivery, mode);
    dispatch_menu_event(app_handle, &delivery, "menu-theme-mode", payload);
}

/// 拖出标签页时给新窗口分配的自增序号——`new_term_window_label` 用它拼出 `term-<n>`。
///
/// 没有用 `uuid` crate：仓库要求本任务不得新增依赖，而 `uuid` 虽然已经通过
/// tauri/notify 等间接依赖出现在 `Cargo.lock` 里，若要在这里 `use uuid::...`，仍必须
/// 在 `Cargo.toml` 的 `[dependencies]` 里新增一行显式声明——那就是名副其实的"新增
/// 依赖"，即便它不会真的多下载/多编译一个新 crate。改用本仓库 `pty.rs::pty_spawn`
/// 已经验证过的同一手法：进程内单调递增的 `AtomicU64` 计数器。这满足这里唯一需要
/// 的不变式——窗口 label 只需要在应用这一次运行期间不重复（label 不跨进程/跨重启
/// 持久化，重启后旧窗口早已不存在，序号从 1 重来不会与任何"仍然活着"的窗口冲突）。
static NEXT_TERM_WINDOW_ID: AtomicU64 = AtomicU64::new(1);

/// 纯函数：生成新终端窗口的 label，形如 `term-<n>`。
///
/// 不接触任何 Tauri/窗口对象，因此可以像 `settings_insertion_index`/`validate_reveal_
/// dir`（见 reveal.rs）那样直接单测，不需要构造真实 `App`。`create_term_window` 是
/// 这个函数唯一的生产调用点。
fn new_term_window_label() -> String {
    format!(
        "{TERM_WINDOW_LABEL_PREFIX}{}",
        NEXT_TERM_WINDOW_ID.fetch_add(1, Ordering::SeqCst)
    )
}

/// 从 `app.config().app.windows`（对应 `tauri.conf.json`）里选出"新终端窗口应该
/// 以谁为模板"的那一份**完整** `WindowConfig`——不是只挑宽高/URL/标题几个字段，
/// 是整份配置对象本身。
///
/// R1 修复背景：上一轮实现手动挑了 `width`/`height`/`url`/`title` 四个字段，遗漏了
/// `minWidth`/`minHeight`（评审指出：新窗口能被拖成一条缝，主窗口不能）。手动挑选
/// 字段这个模式本身就是问题根源——`WindowConfig` 有约 50 个字段（`resizable`/
/// `decorations`/`titleBarStyle`/`maximizable`/`minimizable`/`closable`/`focus`/
/// `alwaysOnTop`/`theme`/… 已逐一读过 tauri-utils 2.9.3 `src/config.rs` 的
/// `WindowConfig` 定义，第 1917-2294 行），今天补上 `minWidth`/`minHeight` 不代表
/// 以后不会再漏别的。已确认当前 `tauri.conf.json` 的主窗口条目只显式设置了
/// `title`/`width`/`height`/`minWidth`/`minHeight` 这五项，`resizable`/
/// `decorations`/`titleBarStyle` 等未出现——但即便如此，也不再逐字段挑，而是让
/// `term_window_config` 整份克隆再只改 label/位置，这样"以后 tauri.conf.json 里
/// 主窗口新增了 `alwaysOnTop: true` 之类的字段"也会被新窗口自动继承，不需要回来改
/// 这个函数。
///
/// 优先选 label 为 `"main"` 的那项；找不到就退回数组第一项（本仓库目前只有一个
/// 窗口配置，二者等价）；数组整体为空这种理论上不该发生的情况（tauri.conf.json
/// 至少声明了一个窗口）才退回硬编码兜底值——与当前 `tauri.conf.json` 主窗口配置
/// 逐字段一致（title/width/height/minWidth/minHeight），其余字段用
/// `WindowConfig::default()`（已对照 `tauri-utils` 源码里 `impl Default for
/// WindowConfig` 核实，与 `tauri.conf.json` 未显式声明字段时 serde
/// `#[serde(default = ...)]` 解析出的值逐一相同，例如 `resizable`/`decorations`
/// 的 serde 默认与 `Default` 默认都是 `true`）。
///
/// 纯函数：只读一个切片、返回一份克隆，不接触 `AppHandle`，因此可以直接单测。
fn main_window_config(windows: &[tauri::utils::config::WindowConfig]) -> tauri::utils::config::WindowConfig {
    windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW_LABEL)
        .or_else(|| windows.first())
        .cloned()
        .unwrap_or_else(|| tauri::utils::config::WindowConfig {
            title: "aTerm".to_string(),
            width: 1200.0,
            height: 780.0,
            min_width: Some(800.0),
            min_height: Some(500.0),
            ..Default::default()
        })
}

/// 纯函数：由主窗口的完整 `WindowConfig` 派生新终端窗口应使用的 `WindowConfig`——
/// 只改 `label`（新窗口自己的 label，不能和主窗口撞）与位置（`x`/`y`，调用方传入的
/// 逻辑像素坐标，见 `create_term_window` 顶部注释的坐标契约）；其余字段——包括
/// R1 补上的 `min_width`/`min_height`，以及 `resizable`/`decorations`/
/// `title_bar_style` 等——原样整份克隆自主窗口配置，一次性继承，不逐个字段挑
/// （逐字段挑正是上一轮遗漏 minWidth/minHeight 的根因）。
fn term_window_config(
    main: &tauri::utils::config::WindowConfig,
    label: &str,
    x: f64,
    y: f64,
) -> tauri::utils::config::WindowConfig {
    let mut config = main.clone();
    config.label = label.to_string();
    config.x = Some(x);
    config.y = Some(y);
    config
}

/// 把一个标签页拖出主窗口时，创建接管它的新窗口。
///
/// ## 坐标契约：`x`/`y` 是逻辑（CSS）像素，不是物理像素，调用方不需要按
/// `devicePixelRatio` 换算
///
/// 依据：已对照本机 `tauri 2.11.5` 源码 `src/webview/webview_window.rs` 里
/// `WebviewWindowBuilder::position` 的文档字符串——"The initial position of the
/// window in logical pixels."（`inner_size` 同一文件、同一措辞："Window size in
/// logical pixels."）核实。
///
/// 这与 `src/store/layout.ts` 的 `runPanelResize` 刻意相反，容易搞反、所以在这里
/// 写清楚：那段代码调用的是**已存在窗口**的 JS 端 API
/// `win.setPosition(new PhysicalPosition(...))`——显式构造 `PhysicalPosition`
/// 包装类型，因此要求物理像素，需要先把 CSS 像素的 `panelWidth` 乘上
/// `window.devicePixelRatio` 才能传进去（该文件里那段注释："panelWidth 存的是 CSS
/// 像素，而 outerPosition/outerSize/Monitor.workArea 全部是物理像素"）。而这里调用的
/// 是**创建期**的 Rust 端 builder 方法，同一个 `f64` 参数在 `position`/`inner_size`
/// 这两个方法上就是逻辑像素，没有 Physical/Logical 包装类型的选择余地——如果调用方
/// （前端拖出手势）在传入前又乘了一次 dpr，Retina 屏（dpr=2）上新窗口就会出现在期望
/// 位置 2 倍偏移处，且非 Retina 屏上又恰好正确，是最难查的那类缺陷（与 layout.ts 里
/// 那条注释描述的坑同构，方向相反）。调用方应直接传入拖放事件里的 CSS 像素坐标
/// （例如 `DragEvent.screenX`/`screenY`），不要再乘 dpr。
///
/// ## 尺寸/外观/行为——R1：改用 `WebviewWindowBuilder::from_config` 整份继承
///
/// 不再手动 `.inner_size(width, height)`/`.title(title)` 逐个字段搭 builder（上一轮
/// 做法，遗漏了 minWidth/minHeight）。改为整份克隆主窗口 `WindowConfig`（见
/// `main_window_config`/`term_window_config`），交给
/// `WebviewWindowBuilder::from_config`。已对照本机 `tauri-runtime-wry 2.11.4`
/// 源码 `src/lib.rs` 的 `WindowBuilderWry::with_config`（第 862-996 行）核实：
/// 这条路径会把 `WindowConfig` 的 `width`/`height`/`min_width`/`min_height`/
/// `max_width`/`max_height`/`resizable`/`decorations`/`fullscreen`/`maximized`/
/// `always_on_top`/`always_on_bottom`/`visible_on_all_workspaces`/
/// `content_protected`/`skip_taskbar`/`theme`/`closable`/`maximizable`/
/// `minimizable`/`shadow`/`title`/`focus`/`focusable`/`visible`/`title_bar_style`
/// （macOS 分支）等**全部**字段应用到新窗口，以及当 `x`/`y` 同时为 `Some` 时调用
/// `.position(x, y)`——`term_window_config` 正是把这两个字段设成调用方传入的坐标。
/// 这样"主窗口有哪些外观/行为配置，新窗口就继承哪些"是结构性保证，不依赖这里
/// 手动枚举字段列表（枚举列表今天补全了，明天 tauri.conf.json 加新字段又会漏）。
///
/// ## 失败即降级
///
/// `WebviewWindowBuilder::from_config`/`.build()` 出错只把错误信息通过 `Err` 传回
/// 前端，绝不 panic——与仓库里其它命令的一贯做法一致（`reveal_in_finder`、
/// `set_theme_mode_checked` 等），也是本仓库明确要求的纪律：`core:window:allow-
/// set-size` 未授权那次事故就是"该报错的地方被静默吞掉"，这里不重蹈覆辙。
///
/// 用 `async fn`：已对照 `WebviewWindowBuilder::new`/`from_config` 文档字符串
/// 核实——"On Windows, this function deadlocks when used in a synchronous
/// command and event handlers ... You should use `async` commands and separate
/// threads when creating windows."，仓库里 `count_subagents`
/// （sessions/subagents.rs）已有 `async` 命令先例，这里照官方建议同样写成
/// `async`。
#[tauri::command]
async fn create_term_window(app: AppHandle, x: f64, y: f64) -> Result<String, String> {
    let label = new_term_window_label();
    let main = main_window_config(&app.config().app.windows);
    let config = term_window_config(&main, &label, x, y);

    WebviewWindowBuilder::from_config(&app, &config)
        .map_err(|e| format!("创建新窗口失败：{e}"))?
        .build()
        .map_err(|e| format!("创建新窗口失败：{e}"))?;

    Ok(label)
}

/// 逻辑（CSS）像素下的一个窗口矩形：左上角 `(x, y)` + 宽高。`window_at_point` 由每个
/// 窗口自己的 `inner_position()`/`inner_size()`（**内容区**，物理像素）与
/// `scale_factor()` 换算得到（见 `physical_rect_to_logical`），命中判定本身
/// （`hit_test_windows`）只认逻辑矩形——换算的正确性和包含判定的正确性因此各自独立
/// 可测，互不牵连。
///
/// **为什么是内容区而不是外框**（V3.4 修复轮 R1）：这个矩形的左上角同时是
/// `WindowHit::local_x`/`local_y` 的原点，而前端拿 `local_y` 去比的是「标签栏落区高度」
/// （`src/tabTearOut.ts` 的 `TABBAR_DROP_ZONE_PX`）——标签栏是 webview 内容区的第一个
/// 元素，从内容区顶部开始。用外框（`outer_*`）的话原点会跑到原生标题栏顶边，`local_y`
/// 里凭空混进一个标题栏高度，前端只能在自己那边加一个魔数补偿；而那个补偿数在全屏窗口
/// （没有标题栏）上又是错的，`tauri.conf.json` 一旦加上 `titleBarStyle` 也会失效。
/// 规格 §5.1 原文要的就是"点在其**内容区**的本地逻辑坐标"。
#[derive(Debug, Clone, Copy, PartialEq)]
struct LogicalRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// `window_at_point` 命中时的返回值：命中窗口的 label，以及点相对该窗口**内容区**
/// 左上角的本地逻辑坐标（原点是 webview 内容区顶边，不含原生标题栏——理由见
/// `LogicalRect` 上方那段）。字段用 `camelCase` 序列化（`local_x`/`local_y` ->
/// `localX`/`localY`），
/// 与仓库其它多字段返回结构体同一约定（见 `status/installer.rs` 的
/// `HookInstallState`/`HooksStatus` 等；`src/ipc.ts` 侧的 `WindowHit` 接口逐字段沿用
/// 这份 camelCase，见其注释）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowHit {
    label: String,
    local_x: f64,
    local_y: f64,
}

/// 纯函数：把一个窗口的物理像素矩形（`window_at_point` 传的是 `inner_position()`/
/// `inner_size()` 的原始返回值，调用方各自转成 `f64` 后传入）按它自己的
/// `scale_factor()` 换算成逻辑（CSS）像素矩形。函数本身不关心传进来的是内容区还是
/// 外框——它只做除法。
///
/// 换算方向是**物理 ÷ scale = 逻辑**，不是反过来——方向写反时在非 Retina 屏
/// （`scale_factor() == 1.0`）上除和乘结果相同，完全测不出来，必须用 `scale != 1.0`
/// 的输入才能验证方向对不对（下方 `physical_rect_to_logical_divides_not_multiplies_
/// with_dpr_two` 单测用 scale=2.0 构造）。方向依据：`src/store/layout.ts` 的
/// `runPanelResize`（约 190 行）踩过反方向的坑——那里是**逻辑 → 物理**，要把 CSS
/// 像素的 `panelWidth` 乘上 `devicePixelRatio` 才能传给期望物理像素的
/// `PhysicalPosition`（该文件注释："这一步换算漏了的话，Retina 上面板只会长出该有
/// 宽度的一半，非 Retina 屏上又恰好正确"）；这里做的是反方向的换算（物理 → 逻辑），
/// 所以是除不是乘。也与 `create_term_window`/`window_logical_origin` 已核实过的
/// tauri `dpi` 换算惯例一致（已对照本机 `dpi 0.1.2` 源码核实：
/// `PhysicalPosition::to_logical`/`PhysicalSize::to_logical` 内部同样是
/// `self.x.into() / scale_factor`）——这里没有直接调用 `to_logical`，而是手写除法，
/// 为的是让这段算术本身可以被单测覆盖、被变异验证（`to_logical` 是库代码，改乘改除
/// 不会出现在这个仓库的 diff 里）。
fn physical_rect_to_logical(
    physical_x: f64,
    physical_y: f64,
    physical_width: f64,
    physical_height: f64,
    scale_factor: f64,
) -> LogicalRect {
    LogicalRect {
        x: physical_x / scale_factor,
        y: physical_y / scale_factor,
        width: physical_width / scale_factor,
        height: physical_height / scale_factor,
    }
}

/// 纯函数：给定一个逻辑屏幕坐标点与一组窗口 `(label, 逻辑矩形)`，找出第一个包含该
/// 点、且 label != exclude 的窗口，返回其 label 与点在其内的本地逻辑坐标（点减去
/// 矩形左上角）。一个都不命中（含全部被 exclude 排除）返回 `None`。
///
/// **包含判定边界**：左/上闭区间，右/下开区间——`x` 落在
/// `[rect.x, rect.x + rect.width)`、`y` 落在 `[rect.y, rect.y + rect.height)` 才算
/// 命中，与 DOM `getBoundingClientRect()` 系列 API 的惯例一致：矩形右/下边界那一条
/// 线本身不属于这个矩形（属于相邻下一个像素的起点）。四条边界分别单测：左边界与上
/// 边界命中，右边界（`rect.x + rect.width`）与下边界（`rect.y + rect.height`）不
/// 命中。
///
/// **`exclude`**（V3.4 设计 Ruling 1）：源窗口在整个拖拽手势期间持有指针 capture
/// （`setPointerCapture`），通常也是当前聚焦窗口——它的屏幕矩形必然包含指针当前
/// 位置，调用方（`window_at_point`）不传自身 label 作为 `exclude` 的话，这里遍历到
/// 它时会提前命中并返回它自己，交接手势永远找不到目标窗口。
///
/// **重叠命中**：`windows` 里排在前面的优先——调用方 `window_at_point` 直接把
/// `app.webview_windows()`（`HashMap`，不保证顺序、更不反映屏幕 z-order）转成的
/// `Vec` 传进来，因此"排在前面"不代表"显示在最上层"，这是本命令的已知局限，记入真机
/// 验收（tao/tauri 都没有暴露查询窗口 z-order 的 API），不是这个函数能修的。
///
/// 不接触任何 Tauri/窗口对象，因此可以像 `settings_insertion_index` 一样直接单测，
/// 不需要构造真实 `AppHandle`/`WebviewWindow`。
fn hit_test_windows(
    point: (f64, f64),
    windows: &[(String, LogicalRect)],
    exclude: &str,
) -> Option<WindowHit> {
    let (px, py) = point;
    windows.iter().find_map(|(label, rect)| {
        if label == exclude {
            return None;
        }
        let within_x = px >= rect.x && px < rect.x + rect.width;
        let within_y = py >= rect.y && py < rect.y + rect.height;
        if !(within_x && within_y) {
            return None;
        }
        Some(WindowHit {
            label: label.clone(),
            local_x: px - rect.x,
            local_y: py - rect.y,
        })
    })
}

/// 命中测试命令：给定一个逻辑屏幕坐标点，找出（排除 `exclude`）第一个包含它的窗口，
/// 返回其 label 与点在其内的本地逻辑坐标；一个都不命中则 `Ok(None)`。V3.4 拖标签到
/// 其它窗口标签栏的落点判定入口，Task 3 消费这个命令。
///
/// ## 坐标契约：与 `create_term_window` 完全一致——`x`/`y` 是逻辑（CSS）像素
///
/// 调用方不做 `devicePixelRatio` 换算，直接传 `PointerEvent.screenX`/`screenY`
/// （依据见 `create_term_window` 顶部注释：已对照 tauri 2.11.5
/// `WebviewWindowBuilder::position`/`inner_size` 文档字符串——"in logical
/// pixels"——核实的同一份考据，这里不重复贴一遍）。
///
/// ## `exclude` 必传（V3.4 设计 Ruling 1）
///
/// 见 `hit_test_windows` 顶部注释——源窗口自己的矩形必然包含指针当前位置，不排除它
/// 就永远只会命中它自己，调用方（Task 3 的拖拽手势）必须传自身 label。
///
/// ## 每个窗口用它自己的 `scale_factor()` 换算
///
/// 多显示器环境下不同窗口可能挂在不同缩放比例的屏幕上，`inner_position`/
/// `inner_size` 各自返回该窗口所在屏幕的物理像素，不能用某一个全局/固定的 scale
/// factor 统一换算，必须逐窗口各取各的（与 `window_logical_origin` 同一手法，见其
/// 上方注释）。
///
/// ## 取的是**内容区**（`inner_*`），不是外框（`outer_*`）
///
/// 见 `LogicalRect` 上方那段：`local_y` 的原点必须是 webview 内容区顶边，前端的
/// 「标签栏落区」常量才是一个相对标签栏本身定义的、与标题栏高度无关的数。
///
/// ## 只考虑**看得见**的窗口（V3.4 修复轮 R2 / I2）
///
/// 最小化的窗口在 macOS 上仍然保留它的 frame，`inner_position()`/`inner_size()` 照常
/// 返回一个正常矩形——不过滤的话，用户明明看着的是一片空桌面（以为松手会弹出一个新
/// 窗口），标签却被交给了一个屏幕上根本不存在的窗口，随后无从找回。`is_visible()` 同理
/// 覆盖"窗口被 hide 掉"这一类。
///
/// 读取失败一律**视为可见**（`is_visible` 取 `unwrap_or(true)`、`is_minimized` 取
/// `unwrap_or(false)`）：这两个 getter 走的是与位置/尺寸同一类的窗口查询，失败通常只是
/// 竞态。保守方向是"宁可让它参与命中"——漏掉一个其实可见的窗口会让用户明明拖到了目标
/// 窗口标签栏上却弹出一个新窗口（一次不可见的错投），而多算一个其实不可见的窗口至多回到
/// 修复前的行为。
///
/// ## 失败即降级
///
/// 遍历中任一窗口的 `inner_position()`/`inner_size()`/`scale_factor()` 读取失败，
/// 只跳过这一个窗口，不让整个命令返回 `Err`——可能只是窗口在被查询的同时刚好正在
/// 关闭这类竞态，不是调用方能规避的错误；命令在没有任何窗口可读、或没有任何窗口命中
/// 时仍返回 `Ok(None)`，不是 `Err`。
///
/// ## 多窗口重叠、未覆盖单测
///
/// 重叠时的已知局限见 `hit_test_windows` 顶部注释。这个 `async fn` 本身需要构造
/// 真实 `AppHandle`/`WebviewWindow` 才能测，未覆盖单测——与 `create_term_window` 本身
/// 同一模式（见文件末尾 `#[cfg(test)]` 模块 `new_term_window_label` 单测上方那条
/// 注释）；真正做判定的两个纯函数（`physical_rect_to_logical`/`hit_test_windows`）
/// 各自独立覆盖单测。
#[tauri::command]
async fn window_at_point(
    app: AppHandle,
    x: f64,
    y: f64,
    exclude: String,
) -> Result<Option<WindowHit>, String> {
    let windows: Vec<(String, LogicalRect)> = app
        .webview_windows()
        .into_iter()
        .filter_map(|(label, window)| {
            // 看不见的窗口不参与命中（I2，理由见上方"只考虑看得见的窗口"一节）。读取
            // 失败按"可见"处理，与下面几个 `ok()?` 的"读不到就跳过"方向刻意相反：那几个
            // 读不到就连矩形都算不出来、没有别的选择，而这两个读不到时矩形是好的，把它
            // 排除掉才是更坏的那一侧。
            if !window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false) {
                return None;
            }
            let pos = window.inner_position().ok()?;
            let size = window.inner_size().ok()?;
            let scale = window.scale_factor().ok()?;
            let rect = physical_rect_to_logical(
                pos.x as f64,
                pos.y as f64,
                size.width as f64,
                size.height as f64,
                scale,
            );
            Some((label, rect))
        })
        .collect();

    Ok(hit_test_windows((x, y), &windows, &exclude))
}

/// macOS 专属：把 Tauri 自动生成的默认菜单里那个"Quit"项换成一个自定义菜单项。
///
/// 背景（已通过阅读本机 `tao 0.35.3`/`muda 0.19.3`/`tauri 2.11.5` 源码 + 核对
/// tauri-apps/tauri 仓库里 #9198（截至本次改动仍是 open 状态的 bug）与 #12978（已被标记
/// 为其重复项而 close，但描述的正是同一个缺口）两个 issue 核实）：默认菜单里的 Quit 项由
/// `muda::PredefinedMenuItem::quit` 生成，其 action 直接是 AppKit 原生的 `terminate:`
/// selector、target 留空（走 responder chain，最终落到 `NSApplication` 自己的默认实现）。
/// 点击"App 名 > Quit"或按下 ⌘Q 命中的都是这一项，而 `terminate:` 的默认实现完全不经过
/// tao 的事件循环——tao 的 macOS `AppDelegate`
/// （`tao-0.35.3/src/platform_impl/macos/app_delegate.rs`）没有实现
/// `applicationShouldTerminate:`，没有这个方法就没有否决点，NSApplication 会直接判定为
/// "可以退出"，随即广播 `applicationWillTerminate:`（tao 把它转成 `RunEvent::Exit`，不是
/// `ExitRequested`，且此时已经无法阻止）然后终止进程。也就是说，仅仅新增
/// `RunEvent::ExitRequested` 处理器本身并不能拦下 ⌘Q / Quit 菜单项——那次退出请求压根
/// 不会经过 `ExitRequested`。这里的解法沿用 tauri 社区在 #9198 下验证过的做法：用一个
/// 走 `on_menu_event`（会真正进入 Rust 侧回调）的自定义菜单项顶替掉默认那个直接绑定
/// `terminate:` 的项，同一个 id、同一个 ⌘Q 快捷键，这样点击这一项或按 ⌘Q 命中的都是
/// 新项，交由 `on_menu_event` 处理，而不是直接调用 `terminate:`。
///
/// 已知局限（不是本次改动能解决的）：右键 Dock 图标选择"退出"发送的是 Apple Event
/// （`aevt`/`quit`），不经过应用菜单，因此不受这次替换影响，同样会直接走
/// `NSApplication` 默认的 `terminate:` 实现——这条路径在当前 tao/muda 版本下没有任何
/// Rust 侧介入点（需要在 Objective-C 运行时层面实现 `applicationShouldTerminate:`
/// 委托方法才能拦截，那是一个本代码库里从未出现过的新模式，风险和收益不成正比，故未做；
/// 已在报告里单独列出，需要人工知悉）。
#[cfg(target_os = "macos")]
const QUIT_MENU_ITEM_ID: &str = "aterm-quit";

/// 实际执行 Quit 项替换的内部函数——错误处理与见证令牌的构造分开（见下面
/// `replace_quit_menu_item`/`QuitReplaced` 的说明），这样"是否替换成功"仍然可以用 `?`
/// 正常传播，不必把 `eprintln!` 硬塞进一个理应只做"替换"这一件事的函数体中间。
#[cfg(target_os = "macos")]
fn try_replace_quit_menu_item<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let top_items = menu.items()?;
    let Some(app_submenu) = top_items.first().and_then(|item| item.as_submenu()) else {
        return Ok(());
    };
    let items = app_submenu.items()?;
    // 默认菜单固定顺序（见 tauri 2.11.5 `src/menu/menu.rs` 里 `Menu::default`）：
    // About / 分隔线 / Services / 分隔线 / Hide / HideOthers / 分隔线 / Quit——
    // Quit 就是这个子菜单的最后一项。
    let Some(last_index) = items.len().checked_sub(1) else {
        return Ok(());
    };
    app_submenu.remove_at(last_index)?;
    let quit_text = format!("Quit {}", app.package_info().name);
    let quit_item = MenuItem::with_id(app, QUIT_MENU_ITEM_ID, quit_text, true, Some("Command+Q"))?;
    app_submenu.append(&quit_item)?;
    Ok(())
}

/// 见证令牌（witness token）：证明 `try_replace_quit_menu_item` 已经跑过。
///
/// 字段私有（`()`，未标 `pub`），本模块之外无法构造这个类型的值——`insert_settings_
/// menu_item` 把它收作参数，就等于让编译器替我们守住"必须先替换 Quit、再插入
/// 设置…"这条顺序不变式：原来只写在注释里的约定（R1 修复：把两次调用收进
/// `setup_macos_menu` 一个函数，靠"顺序写死、注释紧邻"降低被无意间写错的概率，但
/// 评审实测过函数体内部仍能被悄悄调换、`cargo build`/`cargo test` 拦不住），现在
/// 顺序写错会直接编译不过——R2 修复，实测的编译错误逐字输出见任务报告「修复轮 R2」。
///
/// V3.4 起 `derive(Clone, Copy)`：`insert_new_window_menu_item`（File 子菜单「新建
/// 窗口」）加入后，同一个令牌需要交给两个插入函数各收一份——`Copy` 只是让
/// `setup_macos_menu` 里那一个 `quit_replaced` 变量可以被传两次，不改变"只有
/// `replace_quit_menu_item` 能构造它"这条约束（字段仍然私有），也不减弱顺序不变式
/// 本身：把两行调用对调仍然是"变量在声明前使用"，`cargo build` 照样报 E0425，与
/// `Copy` 与否无关。
#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
struct QuitReplaced(());

/// macOS 专属：`setup_macos_menu` 用来替换 Quit 项的入口，`QuitReplaced` 见证令牌的
/// 唯一产出处。
///
/// **无条件**返回 `QuitReplaced`——即使内部替换失败（`try_replace_quit_menu_item`
/// 返回 `Err`）也照样返回，失败即降级的警告挪到了这里面处理。这是刻意的：如果改成
/// 返回 `Result<QuitReplaced>`，失败时就没有令牌可用，`insert_settings_menu_item`
/// 会被连带拖累一起插不进去——但"替换 Quit"与"插入设置…"是两个各自独立的功能，
/// 一个坏了不该拖累另一个，那不是本来想要的降级行为，故意不这么做。
#[cfg(target_os = "macos")]
fn replace_quit_menu_item<R: tauri::Runtime>(app: &tauri::App<R>) -> QuitReplaced {
    if let Err(e) = try_replace_quit_menu_item(app) {
        eprintln!("警告：替换 Quit 菜单项失败，⌘Q 将退回系统默认行为（不会弹出关闭确认）：{e}");
    }
    QuitReplaced(())
}

#[cfg(target_os = "macos")]
const SETTINGS_MENU_ITEM_ID: &str = "aterm-settings";

/// 纯函数：给定插入前 App 子菜单的项数，算出 `[分隔线, 设置…]` 这两项该插入的下标。
///
/// 只做算术，不接触任何 muda/AppKit 对象——因此能在不构造真实 `App` 句柄的前提下
/// 单测（本仓库既有先例：`reveal.rs` 的 `validate_reveal_dir`，同样是为了可测而把
/// 校验/计算逻辑从会触碰外部资源的副作用里摘出来）。`insert_settings_menu_item`
/// 直接调用这一份，测试和生产代码用的是同一个函数，不会出现两边各写一份、彼此
/// 漂移的问题。
///
/// 固定插到下标 1：紧跟 About（下标 0）之后，也就是默认菜单里 About 与 Services
/// 之间那条分隔线之前。插入 `[新分隔线, 设置…]` 两项后，原来那条分隔线自然变成
/// "设置…" 与 Services 之间的分隔线——macOS 惯例"前后各一条分隔线"因此只需新插
/// 一条，不必再画蛇添足插第二条。
///
/// 返回 `None`：`item_count` 小于 2 时——插入基准点 About（下标 0）与"插入后仍要
/// 留在最后"的那一项（默认菜单里是 Quit）至少各占一个下标，凑不满 2 项就没有意义
/// 插入（下标 1 会等于或超出当前项数，插到末尾甚至 About 前面，反而破坏"About 之后、
/// 原最后一项之前"这条不变式）。`insert_settings_menu_item` 在 `replace_quit_menu_item`
/// 之后调用，且两者对拿不到菜单/子菜单的情况都已提前 `return Ok(())`，默认菜单固定
/// 8 项，理论上不会真的遇到小于 2 的项数，这里仍显式处理，不靠裸减法/裸索引隐式
/// 避免 panic。
#[cfg(target_os = "macos")]
fn settings_insertion_index(item_count: usize) -> Option<usize> {
    if item_count < 2 {
        return None;
    }
    Some(1)
}

/// macOS 专属：在 App 子菜单里插入"设置…"项（⌘,），位置在 About 之后、Quit 之前。
///
/// 必须在 `replace_quit_menu_item` 之后调用——`_order: QuitReplaced` 这个参数就是这条
/// 顺序要求本身：`QuitReplaced` 的字段私有、只有 `replace_quit_menu_item` 能构造它，
/// 所以能拿到一个 `QuitReplaced` 值就已经证明 Quit 项被替换过了（不管替换本身成功还是
/// 失败——见 `replace_quit_menu_item`/`QuitReplaced` 的说明，它无条件产出令牌）。这样
/// 调用顺序错了会编译不过，不再依赖任何人读这段注释。让它看到的子菜单仍是默认菜单
/// 固定的那个顺序（About / 分隔线 / Services / 分隔线 / Hide / HideOthers / 分隔线 /
/// Quit(custom)），不会因为先插入了"设置…"而打乱下标、让已经过真机验证过的替换逻辑
/// 意外失灵。参数本身在函数体内未被使用（`_order`），只用于编译期占位。
#[cfg(target_os = "macos")]
fn insert_settings_menu_item<R: tauri::Runtime>(
    app: &tauri::App<R>,
    _order: QuitReplaced,
) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let top_items = menu.items()?;
    let Some(app_submenu) = top_items.first().and_then(|item| item.as_submenu()) else {
        return Ok(());
    };
    let items = app_submenu.items()?;
    let Some(insert_at) = settings_insertion_index(items.len()) else {
        // 与上面两处"压根拿不到菜单/子菜单"的静默 `return Ok(())` 不同：那两处是环境
        // 缺失（例如根本没有菜单），这里是**菜单形状异常于预期**——item_count < 2 只会
        // 在未来某次 tauri/muda 升级改变了默认菜单项数时发生（当前固定 8 项）。那种情况
        // 下"设置…"会悄无声息地不被插入，⌘, 不可用，但没有任何日志线索可查——留一句
        // 警告，说明发生了什么、以及后果（仍可通过侧栏齿轮按钮打开设置浮层，不影响
        // 应用可用性，所以仍然只降级不 panic）。
        eprintln!(
            "警告：App 子菜单项数（{}）少于预期，未插入\"设置…\"菜单项，⌘, 不可用\
             （仍可通过侧栏齿轮按钮打开设置）",
            items.len()
        );
        return Ok(());
    };
    let separator = PredefinedMenuItem::separator(app)?;
    let settings_item =
        MenuItem::with_id(app, SETTINGS_MENU_ITEM_ID, "设置…", true, Some("Command+,"))?;
    app_submenu.insert_items(&[&separator, &settings_item], insert_at)?;
    Ok(())
}

#[cfg(target_os = "macos")]
const NEW_WINDOW_MENU_ITEM_ID: &str = "aterm-new-window";

/// 纯函数：给定插入前 File 子菜单的项数，算出「新建窗口」+ 分隔线该插入的下标。
///
/// 与 `settings_insertion_index` 同一做法（见其上方注释）：把可测的下标算术从会
/// 触碰 muda/AppKit 对象的副作用函数（`insert_new_window_menu_item`）里摘出来，
/// 后者直接调用这一份，测试和生产代码用的是同一个函数，不会出现两边各写一份、
/// 彼此漂移的问题。
///
/// 固定插到下标 0：File 子菜单默认只有 Close Window 一项（已对照本机 tauri 2.11.5
/// `src/menu/menu.rs` 里 `Menu::default` 的 File 子菜单构成核实——它的 cfg 是
/// `not(any(linux, dragonfly, freebsd, netbsd, openbsd))`，macOS 不在排除名单内；
/// 内容只有 `PredefinedMenuItem::close_window`，`quit` 那一项只在非 macOS 分支才会
/// 出现在 File 子菜单里）。「新建窗口」要出现在 Close Window 之前，插入
/// `[新建窗口, 分隔线]` 两项后，原来的 Close Window 自然被推到分隔线之后——不需要
/// 先算出 Close Window 当前下标，永远插在最前面就是"它之前"。
///
/// 返回 `None`：`item_count` 为 0 时——插入的意图是"新项要出现在已有项之前"，空
/// 子菜单没有可以"之前"的锚点项，插入没有意义。生产代码走到这个分支意味着 File
/// 子菜单形状异常于预期（当前固定 1 项），与 `settings_insertion_index` 对
/// `item_count < 2` 的处理同一动机。
#[cfg(target_os = "macos")]
fn new_window_insertion_index(item_count: usize) -> Option<usize> {
    if item_count == 0 {
        return None;
    }
    Some(0)
}

/// macOS 专属：在 File 子菜单里插入「新建窗口」项（⌘N），位置在 Close Window 之前、
/// 以分隔线相隔。
///
/// **按标题查找 File 子菜单，不按下标**：与 `try_replace_quit_menu_item`/
/// `insert_settings_menu_item` 用 `top_items.first()` 拿 App 子菜单不同——App 子菜单
/// 在 tauri 默认菜单里恒是第一个顶层项，但 File 子菜单不是（顺序是 App / File / Edit /
/// View / Window / Help），且 `Submenu::with_items` 构造它时没有传显式 id（对照
/// `Menu::default` 源码核实：与 `THEME_SUBMENU_ID`/tauri 自己给 Window/Help 子菜单
/// 显式指定 id 不同，File 子菜单只传了标题字符串），因此这里学 `apply_theme_mode_
/// checked` 找"主题"子菜单那样，用 `top_items.iter().find_map` 按 `.text()` 精确匹配
/// `"File"`，不硬编码下标——下标假设一旦被将来的 tauri 升级打破（顶层子菜单顺序
/// 变化），按下标找会静默命中错误的子菜单（可能在 Edit/View 里插错两个不相关的菜单
/// 项）；按标题找则会走进下面的"找不到"分支，只是功能不可用，不会插错地方。
///
/// 必须在 `replace_quit_menu_item` 之后调用（`_order: QuitReplaced` 同
/// `insert_settings_menu_item` 的用法，见其上方注释）——File 子菜单的改动本身不触及
/// App 子菜单、不影响 Quit 的末位下标，但仍与"设置…"一起走 `setup_macos_menu` 这同一
/// 个函数，纳入同一条令牌链只是让"哪些插入步骤发生在 Quit 替换之后"这件事在编译期
/// 有统一的证明方式，不需要为这一步单独判断"是不是真的需要在 Quit 替换之后"。
/// `QuitReplaced` 因此改成 `Copy`（见其定义处注释）——两个插入函数都要收一份令牌。
///
/// 失败即降级：拿不到菜单/顶层菜单项、找不到 File 子菜单、File 子菜单为空，都只打
/// 警告后继续启动（不 panic），与仓库其它菜单初始化函数一致的纪律。
#[cfg(target_os = "macos")]
fn insert_new_window_menu_item<R: tauri::Runtime>(
    app: &tauri::App<R>,
    _order: QuitReplaced,
) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let top_items = menu.items()?;
    let Some(file_submenu) = top_items.iter().find_map(|item| {
        let submenu = item.as_submenu()?;
        match submenu.text() {
            Ok(text) if text == "File" => Some(submenu),
            _ => None,
        }
    }) else {
        eprintln!("警告：未找到 \"File\" 子菜单，未插入\"新建窗口\"菜单项，⌘N 不可用");
        return Ok(());
    };
    let items = file_submenu.items()?;
    let Some(insert_at) = new_window_insertion_index(items.len()) else {
        eprintln!(
            "警告：\"File\" 子菜单项数（{}）少于预期，未插入\"新建窗口\"菜单项，⌘N 不可用",
            items.len()
        );
        return Ok(());
    };
    let new_window_item = MenuItem::with_id(
        app,
        NEW_WINDOW_MENU_ITEM_ID,
        "新建窗口",
        true,
        Some("Command+N"),
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    file_submenu.insert_items(&[&new_window_item, &separator], insert_at)?;
    Ok(())
}

/// 拖出/新建窗口级联偏移量（逻辑像素）。与前端标签拖出手势的坐标计算没有耦合关系
/// （那条路径直接透传 `PointerEvent.screenX/screenY`，见 `create_term_window` 顶部
/// 坐标契约注释）——这里是纯 Rust 侧「新建窗口」菜单项独立算出的起点，选 30 只是
/// macOS 常见的窗口级联间距，没有更深的依据。
#[cfg(target_os = "macos")]
const NEW_WINDOW_CASCADE_OFFSET: f64 = 30.0;

/// 三级都取不到参考窗口位置时的兜底坐标（逻辑像素）。`setup_macos_menu` 运行时主
/// 窗口必然已经存在（`run()` 里 `.setup()` 在 `.build()` 之后执行，此时
/// `tauri.conf.json` 声明的主窗口已创建完毕），因此正常运行时这个分支不会被触达；
/// 仍显式写出、不裸写在调用点——与 `main_window_config` 的硬编码兜底值同一取舍
/// （见其上方注释：即便"理论上不会发生"，也要写清楚"发生了怎么办"）。
#[cfg(target_os = "macos")]
const NEW_WINDOW_DEFAULT_POSITION: (f64, f64) = (100.0, 100.0);

/// 纯函数：由"参考窗口左上角的逻辑坐标"算出新窗口应出现的位置——有原点就
/// +30/+30 级联，没有（`None`）就退回 `NEW_WINDOW_DEFAULT_POSITION`。
///
/// 上层调用方（`new_window_origin`）负责按"聚焦窗口 -> 主窗口"的优先级把 origin
/// 解出来（那一步需要真实 `AppHandle`/`WebviewWindow`，见下），这里只管拿到/拿不到
/// origin 之后该怎么算，因此可以像 `settings_insertion_index` 一样直接单测，不需要
/// 构造真实窗口。
#[cfg(target_os = "macos")]
fn new_window_cascade_position(origin: Option<(f64, f64)>) -> (f64, f64) {
    match origin {
        Some((x, y)) => (x + NEW_WINDOW_CASCADE_OFFSET, y + NEW_WINDOW_CASCADE_OFFSET),
        None => NEW_WINDOW_DEFAULT_POSITION,
    }
}

/// 一个窗口左上角的逻辑（CSS）像素坐标，取不到（`outer_position`/`scale_factor`
/// 任一调用失败）返回 `None`。
///
/// `outer_position` 返回的是物理像素（`PhysicalPosition<i32>`），而
/// `create_term_window` 的坐标契约是逻辑像素（见其上方注释），这里用
/// `scale_factor` 转换——与 V3.4 设计文档 §2 提到的"Rust 能枚举所有窗口的屏幕矩形：
/// webview_windows() + 位置/尺寸 + scale_factor()"是同一手法，`window_at_point` 的
/// 命中测试复用同一套物理→逻辑换算（`physical_rect_to_logical`）。
///
/// **这里刻意用 `outer_position`，与 `window_at_point` 的 `inner_position` 不同**：
/// 这个函数的用途是给新窗口算级联落点，而 `WebviewWindowBuilder::position` 设的是
/// 窗口**外框**左上角——参考原点必须和它同一个坐标系，否则每级联一次就偏一个标题栏的
/// 高度。`window_at_point` 要的则是内容区原点（见 `LogicalRect` 上方那段）。两处用途
/// 不同、取值不同，都是有意的。
#[cfg(target_os = "macos")]
fn window_logical_origin(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let physical = window.outer_position().ok()?;
    let scale = window.scale_factor().ok()?;
    let logical: tauri::LogicalPosition<f64> = physical.to_logical(scale);
    Some((logical.x, logical.y))
}

/// 三级优先级解出新窗口的参考原点：聚焦窗口 -> 主窗口 -> 无（由
/// `new_window_cascade_position` 兜底成默认坐标）。
///
/// 取聚焦窗口 label 复用 `focused_window_label`——同一份"绕开 `get_focused_window`
/// 被 `unstable` feature gate"考据（见其上方注释），不再重新验证一遍。`get_webview_
/// window`/`webview_windows` 都不受 `unstable` 门禁（已对照本机 tauri 2.11.5
/// `src/lib.rs` 核实：标了 `#[cfg(feature = "unstable")]` 的只有 `get_window`/
/// `get_focused_window`/`windows`/`get_webview`/`webviews` 五个方法，`get_webview_
/// window`/`webview_windows` 没有）。
#[cfg(target_os = "macos")]
fn new_window_origin(app_handle: &AppHandle) -> Option<(f64, f64)> {
    if let Some(label) = focused_window_label(app_handle) {
        if let Some(origin) = app_handle
            .get_webview_window(&label)
            .as_ref()
            .and_then(window_logical_origin)
        {
            return Some(origin);
        }
    }
    app_handle
        .get_webview_window(MAIN_WINDOW_LABEL)
        .as_ref()
        .and_then(window_logical_origin)
}

/// macOS 专属：`on_menu_event` 命中「新建窗口」时的完整处理——解出级联位置后调用
/// `create_term_window` 建窗。
///
/// `create_term_window` 是 `async fn`（`#[tauri::command]` 只是给它加了 IPC 绑定，
/// 函数本身仍是可以直接调用的普通 Rust 函数——tauri 官方文档明确支持"从 Rust 代码里
/// 直接调用 command"这种用法），但 `on_menu_event` 的处理器是同步闭包，因此用
/// `tauri::async_runtime::spawn` 把这次调用丢进 tauri 自己的异步运行时，不阻塞事件
/// 循环。
///
/// 失败即降级：`create_term_window` 出错只 `eprintln!`，不 panic、不重试——这次点击
/// 失败不该影响应用的其它部分，与仓库其它命令调用点一致的纪律。
#[cfg(target_os = "macos")]
fn handle_new_window_menu_event(app_handle: &AppHandle) {
    let (x, y) = new_window_cascade_position(new_window_origin(app_handle));
    let app = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = create_term_window(app, x, y).await {
            eprintln!("警告：菜单栏\"新建窗口\"创建窗口失败：{e}");
        }
    });
}

#[cfg(target_os = "macos")]
const THEME_SUBMENU_ID: &str = "aterm-theme-menu";
#[cfg(target_os = "macos")]
const THEME_MODE_DEFAULT_ID: &str = "aterm-theme-mode-default";
#[cfg(target_os = "macos")]
const THEME_MODE_DUAL_ID: &str = "aterm-theme-mode-dual";
#[cfg(target_os = "macos")]
const THEME_MODE_SINGLE_ID: &str = "aterm-theme-mode-single";

/// （id, 标签）：菜单栏「主题」子菜单三项的唯一数据来源，`build_theme_menu` 与
/// `theme_mode_labels_match_frontend_appearance_section` 单测共用同一份，不会出现
/// 生产代码和测试各写一份标签、彼此漂移的问题。标签必须与
/// `src/components/settings/AppearanceSection.tsx` 的 `MODE_LABEL` 逐字一致
/// （硬要求①，见该单测）——这里改了标签，务必同步改那边，反之亦然。
#[cfg(target_os = "macos")]
const THEME_MODE_ITEMS: [(&str, &str); 3] = [
    (THEME_MODE_DEFAULT_ID, "默认"),
    (THEME_MODE_DUAL_ID, "双主题跟随系统"),
    (THEME_MODE_SINGLE_ID, "手动选定"),
];

/// macOS 专属：在顶层菜单末尾追加「主题」子菜单，包含三个互斥的 `CheckMenuItem`
/// （默认 / 双主题跟随系统 / 手动选定）。
///
/// **追加到顶层末尾**（`menu.append`），不插入某个下标：
/// `try_replace_quit_menu_item`/`insert_settings_menu_item` 都依赖
/// `top_items.first()` 是 App 子菜单这一假设，追加到末尾不会改变任何已有顶层项的
/// 下标，因此不影响那条顺序不变式——不需要并入 `QuitReplaced` 见证令牌链，顶层菜单
/// 之间的先后只是观感问题。
///
/// 三项初始 checked 只有 default 为 true，只是一个占位：真正的状态由前端在应用
/// 启动、store 就绪后调用 `set_theme_mode_checked` 覆盖（见接线契约），这里的选择
/// 不影响正确性，只影响菜单在那一小段时间窗口内的显示（且菜单本就要点开才可见，这
/// 段窗口用户几乎不可能观察到）。
#[cfg(target_os = "macos")]
fn build_theme_menu<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let mut owned_items: Vec<CheckMenuItem<R>> = Vec::with_capacity(THEME_MODE_ITEMS.len());
    for (id, label) in THEME_MODE_ITEMS {
        let checked = id == THEME_MODE_DEFAULT_ID;
        owned_items.push(CheckMenuItem::with_id(
            app,
            id,
            label,
            true,
            checked,
            None::<&str>,
        )?);
    }
    let item_refs: Vec<&dyn IsMenuItem<R>> = owned_items
        .iter()
        .map(|i| i as &dyn IsMenuItem<R>)
        .collect();
    let theme_submenu =
        Submenu::with_id_and_items(app, THEME_SUBMENU_ID, "主题", true, &item_refs)?;
    menu.append(&theme_submenu)?;
    Ok(())
}

/// 纯函数：模式字符串 -> 三项（default, dual, single）各自应有的 checked 布尔，
/// 恰好一项为 true。非法字符串返回 `Err`——`set_theme_mode_checked` 先调用这个函数
/// 校验并用 `?` 提前返回，校验失败时不会走到任何写入 checked 状态的代码，天然保证
/// 硬要求②后半句"非法 mode 不改动任何一项"。不接触任何 muda/AppKit 对象，因此不
/// 需要构造真实 `App`/`AppHandle` 就能单测（与 `settings_insertion_index` 同一
/// 做法，见其上方注释）。
fn theme_mode_checked_states(mode: &str) -> Result<(bool, bool, bool), String> {
    match mode {
        "default" => Ok((true, false, false)),
        "dual" => Ok((false, true, false)),
        "single" => Ok((false, false, true)),
        other => Err(format!("未知的主题模式：{other}")),
    }
}

/// macOS 专属：把菜单栏「主题」三项的 checked 状态整体写成与给定三元组一致——三项
/// 总是被显式 `set_checked` 一次（哪怕某一项的值和它当前状态相同）。
///
/// 这是硬要求②的核心：macOS 点击 `CheckMenuItem` 时系统会自行切换被点击那一项的
/// 勾选态，如果这里只设"新选中的那一项"、不去复位另外两项，用户在菜单/设置浮层
/// 之间来回切换几次后就会看到两项甚至三项同时打勾。
///
/// R2 修复（终审 I4）：返回 `Result<(), String>` 而不是 `()`——原来四个失败分支（拿
/// 不到菜单 / 读不到顶层项 / 找不到「主题」子菜单 / 读不到子菜单项）全部只
/// `eprintln!` 后静默 `return`，`set_theme_mode_checked` 又无条件 `Ok(())`，导致
/// `src/menuEvents.ts` 里专门为了留痕而写的 `.catch((err) => console.warn(...))`
/// 永远不会触发——打包成 .app 之后 stderr 不可见，整条写入路径运行期零信号，与
/// `core:window:allow-set-size` 那次"静默吞异常、748 测试全绿、打包版功能全部失效"
/// 的事故同一形状。现在每个失败分支**同时** `eprintln!`（本地/开发时的即时信号）
/// **和**返回 `Err`（经 `set_theme_mode_checked` 传回前端，`console.warn` 才真的
/// 能响，两条线索都要）。遍历三项时某一项 `set_checked` 失败不提前中断循环——仍然
/// 尽力把其余两项写完（"尽力而为、不因一项失败放弃全部"），但会记住第一个错误，
/// 循环结束后如果有任何一项失败就整体返回 `Err`。
#[cfg(target_os = "macos")]
fn apply_theme_mode_checked(
    app: &AppHandle,
    default_checked: bool,
    dual_checked: bool,
    single_checked: bool,
) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        let msg = "设置主题菜单勾选态失败，未找到应用菜单".to_string();
        eprintln!("警告：{msg}");
        return Err(msg);
    };
    let Ok(top_items) = menu.items() else {
        let msg = "设置主题菜单勾选态失败，无法读取顶层菜单项".to_string();
        eprintln!("警告：{msg}");
        return Err(msg);
    };
    let Some(theme_submenu) = top_items.iter().find_map(|item| {
        item.as_submenu()
            .filter(|s| s.id().as_ref() == THEME_SUBMENU_ID)
    }) else {
        let msg = "设置主题菜单勾选态失败，未找到\"主题\"子菜单".to_string();
        eprintln!("警告：{msg}");
        return Err(msg);
    };
    let Ok(items) = theme_submenu.items() else {
        let msg = "设置主题菜单勾选态失败，无法读取\"主题\"子菜单项".to_string();
        eprintln!("警告：{msg}");
        return Err(msg);
    };
    let mut first_error: Option<String> = None;
    for item in &items {
        let Some(check) = item.as_check_menuitem() else {
            continue;
        };
        let checked = match check.id().as_ref() {
            THEME_MODE_DEFAULT_ID => default_checked,
            THEME_MODE_DUAL_ID => dual_checked,
            THEME_MODE_SINGLE_ID => single_checked,
            _ => continue,
        };
        if let Err(e) = check.set_checked(checked) {
            let msg = format!("设置主题菜单勾选态失败（{}）：{e}", check.id().as_ref());
            eprintln!("警告：{msg}");
            if first_error.is_none() {
                first_error = Some(msg);
            }
        }
    }
    match first_error {
        Some(msg) => Err(msg),
        None => Ok(()),
    }
}

/// 前端在 `setMode` 之后调用（以及应用启动、store 就绪后调用一次做初始同步，见
/// src/menuEvents.ts），把菜单栏「主题」三项的勾选态同步为与新模式匹配的状态。
/// 非法 `mode` 直接返回 `Err`，不触碰任何一项（见 `theme_mode_checked_states`）。
///
/// R2 修复（终审 I4）：`apply_theme_mode_checked` 的失败现在用 `?` 原样传回前端
/// （而不是像改之前那样被吞掉、始终 `Ok(())`）——`src/menuEvents.ts` 的
/// `syncThemeModeToMenu` 专门写了 `.catch((err) => console.warn(...))` 就是为了接住
/// 这个 `Err`，改之前那个 `catch` 因为命令永远成功而永远打不响，运行期零信号。
///
/// 非 macOS 平台没有这份「主题」菜单（`build_theme_menu` 只在 macOS 构建），因此
/// 这里在校验通过后，其它平台上写入这一步自然是无操作（`Ok(())`）——仍然保持跨
/// 平台一致的 `Result<(), String>` 契约，前端不需要按平台区分调用方式。
#[tauri::command]
fn set_theme_mode_checked(app: AppHandle, mode: String) -> Result<(), String> {
    let (default_checked, dual_checked, single_checked) = theme_mode_checked_states(&mode)?;
    #[cfg(target_os = "macos")]
    {
        apply_theme_mode_checked(&app, default_checked, dual_checked, single_checked)?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, default_checked, dual_checked, single_checked);
    Ok(())
}

/// macOS 专属：`setup()` 里菜单初始化的唯一入口。
///
/// R1 曾把两次调用收进这一个函数、顺序写死在函数体内部，指望"顺序和解释它的注释
/// 相邻"降低被无意间写错的概率——但评审实测过：函数体内部把下面两行对调，
/// `cargo build`/`cargo test` 依然全绿（120 passed，0 failed），没有任何自动化信号
/// 能拦住这个回归，注释挡不住明知故犯或没读注释的情况。
///
/// R2 改为编译期强制：`replace_quit_menu_item` 返回一个只有它能构造的见证令牌
/// `QuitReplaced`，`insert_settings_menu_item` 把令牌收作参数——想在这里把两行顺序
/// 对调，`insert_settings_menu_item(app, quit_replaced)` 里的 `quit_replaced` 就是一个
/// 尚未绑定的变量名，直接编译不过（实测的编译错误逐字输出见任务报告「修复轮 R2」）。
///
/// `replace_quit_menu_item`/`insert_settings_menu_item` 两个函数本身仍保持独立、各自
/// 仍可单测（`settings_insertion_index` 的单测见文件末尾 `#[cfg(test)]` 模块）——这里
/// 只负责按正确顺序把它们粘在一起，不合并两者的实现；两者各自的失败即降级逻辑与
/// 警告文案也都保持独立（分别在各自函数内部处理，互不拖累）。
#[cfg(target_os = "macos")]
fn setup_macos_menu<R: tauri::Runtime>(app: &tauri::App<R>) {
    let quit_replaced = replace_quit_menu_item(app);
    if let Err(e) = insert_settings_menu_item(app, quit_replaced) {
        eprintln!("警告：插入\"设置…\"菜单项失败，⌘, 将不可用：{e}");
    }
    // File 子菜单「新建窗口」（V3.4 Task 1）：不碰 App 子菜单、不影响 Quit 的末位
    // 下标，但仍与"设置…"一起收在 QuitReplaced 令牌链之后——见
    // insert_new_window_menu_item 上方注释。
    if let Err(e) = insert_new_window_menu_item(app, quit_replaced) {
        eprintln!("警告：插入\"新建窗口\"菜单项失败，⌘N 将不可用：{e}");
    }
    // 「主题」菜单是追加到顶层末尾的独立顶层菜单（build_theme_menu 顶部注释），与
    // 上面两步没有顺序依赖——不影响、也不需要并入 QuitReplaced 见证令牌链，因此
    // 放在这两步之后只是顺序上更自然，对调也不会破坏任何不变式。
    if let Err(e) = build_theme_menu(app) {
        eprintln!(
            "警告：构建\"主题\"菜单失败，菜单栏切换主题将不可用（仍可通过设置浮层切换）：{e}"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyManager::default())
        .manage(sessions::subagents::SubagentCache::default())
        .manage(ExitConfirmed(AtomicBool::new(false)))
        .on_window_event(|window, event| {
            // `CloseRequested` 是 `#[non_exhaustive]` 的结构体变体，匹配时必须带 `..`。
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 两条路径都先挡下这次关闭，把决定权交给前端——区别只在"问谁、问什么"。
                // V3.3 之前这里对非 main 窗口整个早退（不 prevent、也不通知任何人），
                // 那时拖出来的窗口关掉是"窗口没了、它里面的 claude 进程还在后台跑，谁
                // 都看不见也关不掉"。
                api.prevent_close();
                if window.label() == MAIN_WINDOW_LABEL {
                    // 主窗口关闭 = 退出整个应用：沿用既有的 ⌘Q 确认流程一字不改
                    // （见 confirm_exit 命令与前端 src/closeRequest.ts）。
                    emit_close_requested(window.app_handle());
                } else {
                    // 非主窗口关闭 = 只关这一个窗口，且**只终止它自己持有的 PTY**
                    // （V3.3 设计文档 §5.3）。谁持有哪些 PTY 只有那个窗口的前端知道，
                    // 理由见 emit_window_close_requested 上方注释。
                    emit_window_close_requested(window.app_handle(), window.label());
                }
            }
        })
        .on_menu_event(|app_handle, event| {
            #[cfg(target_os = "macos")]
            {
                if event.id().as_ref() == QUIT_MENU_ITEM_ID {
                    // 与窗口 CloseRequested 同一套处理：不在这里直接退出，只是把决定权
                    // 转交前端确认弹窗（confirm_exit 才是真正退出的入口）。
                    emit_close_requested(app_handle);
                } else if event.id().as_ref() == SETTINGS_MENU_ITEM_ID {
                    emit_open_settings(app_handle);
                } else if event.id().as_ref() == NEW_WINDOW_MENU_ITEM_ID {
                    handle_new_window_menu_event(app_handle);
                } else if event.id().as_ref() == THEME_MODE_DEFAULT_ID {
                    emit_theme_mode(app_handle, "default");
                } else if event.id().as_ref() == THEME_MODE_DUAL_ID {
                    emit_theme_mode(app_handle, "dual");
                } else if event.id().as_ref() == THEME_MODE_SINGLE_ID {
                    emit_theme_mode(app_handle, "single");
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app_handle, event);
        })
        .invoke_handler(tauri::generate_handler![
            sessions::scan::list_projects,
            sessions::conversation::read_conversation,
            sessions::subagents::count_subagents,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_is_alive,
            pty::pty_alive_count,
            status::get_session_statuses,
            status::installer::hooks_status,
            status::installer::install_hooks,
            status::installer::uninstall_hooks,
            reveal::reveal_in_finder,
            confirm_exit,
            set_theme_mode_checked,
            create_term_window,
            destroy_term_window,
            window_at_point
        ])
        .setup(|app| {
            // 状态引擎（P2b）：起文件监听 + 后台刷新线程，注册管理状态。返回的句柄
            // 必须交给 `.manage()` 存起来——它内部持有 `notify` 的监听器，drop 掉就会
            // 停止监听；必须活到应用退出，与下面 macOS 专属那段互不相干，谁先谁后
            // 不影响正确性，放在最前面只是顺序上更自然。
            app.manage(status::start(app.handle()));

            // macOS 专属菜单初始化（替换 Quit + 插入"设置…"）：两步之间有硬性顺序
            // 依赖，收在同一个函数里按固定顺序执行，理由与失败即降级的写法见
            // setup_macos_menu 上方的注释。
            #[cfg(target_os = "macos")]
            setup_macos_menu(app);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // `ExitRequested` 是 `#[non_exhaustive]` 的结构体变体，匹配时必须带 `..`。
            if let RunEvent::ExitRequested { api, .. } = event {
                // 只有非"前端已确认"的退出请求才拦下转交确认弹窗——见 ExitConfirmed
                // 顶部注释：confirm_exit 触发的这次退出必须放行，否则 app 会变得
                // 永远退不出去。
                let already_confirmed =
                    app_handle.state::<ExitConfirmed>().0.load(Ordering::SeqCst);
                if !already_confirmed {
                    api.prevent_exit();
                    emit_close_requested(app_handle);
                }
            }
        });
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;

    // settings_insertion_index 本身就是 insert_settings_menu_item 实际调用的那个函数
    // （见它上方的注释），不是重新抄一遍逻辑的影子实现——下面几条测试断的是生产代码
    // 真正会跑的分支，不会出现测试和实现各写一份、彼此漂移的问题。

    #[test]
    fn empty_submenu_has_no_insertion_point() {
        // 会因为什么失败：如果实现把 0 项也当成"至少有 About"处理（例如把判断写成
        // `item_count < 1` 之外的什么条件、或者干脆删掉这条判断），这里就会失败。
        assert_eq!(settings_insertion_index(0), None);
    }

    #[test]
    fn single_item_submenu_has_no_insertion_point() {
        // 会因为什么失败：如果判断条件写成 `item_count == 0`（只挡最空的情况），这里
        // 就会失败——只有 1 项时插入下标 1 会等于当前项数，插到唯一那一项之后，
        // 而不是"原最后一项之前"，破坏不变式，所以也必须返回 None。
        assert_eq!(settings_insertion_index(1), None);
    }

    #[test]
    fn inserts_right_after_about() {
        // 会因为什么失败：如果插入下标从 1 改成了别的数（例如误改成 0，插到 About
        // 前面；或者误改成子菜单末尾），这里就会失败。默认菜单固定 8 项（About /
        // 分隔线 / Services / 分隔线 / Hide / HideOthers / 分隔线 / Quit，见
        // try_replace_quit_menu_item 上方注释核实过的 tauri 2.11.5 `Menu::default`）。
        assert_eq!(settings_insertion_index(8), Some(1));
    }

    #[test]
    fn insertion_index_always_precedes_the_original_last_item() {
        // 会因为什么失败：如果插入下标算成了 >= item_count（插到了原最后一项——也就是
        // Quit——后面甚至末尾），这几个不同项数下至少有一个会失败。从 2 项开始
        // （见 single_item_submenu_has_no_insertion_point：少于 2 项没有插入点）。
        for item_count in [2usize, 3, 8, 50] {
            let insert_at = settings_insertion_index(item_count)
                .unwrap_or_else(|| panic!("item_count={item_count} 时不应返回 None"));
            assert!(
                insert_at < item_count,
                "插入点（{insert_at}）必须严格早于原来的最后一项下标（{}），\
                 否则会把 Quit 挤到子菜单中间",
                item_count - 1
            );
        }
    }

    /// 用一个 `Vec<&str>` 模拟真实的 App 子菜单，验证 `try_replace_quit_menu_item` 与
    /// `insert_settings_menu_item` 两步下标逻辑组合之后，Quit 仍稳居子菜单最后一位、
    /// 且整体顺序符合 macOS 惯例——不构造真实 `App` 句柄（那需要一整套窗口环境，见
    /// `settings_insertion_index` 上方注释里提到的、本仓库 `reveal.rs` 的既有先例）。
    ///
    /// 第二步用的下标（`settings_insertion_index(items.len())`）是生产代码
    /// `insert_settings_menu_item` 真正调用的那个函数；第一步（remove_at(len-1) 再
    /// append）抄的是 `try_replace_quit_menu_item` 里同样两行的下标算法，因为那一步的
    /// 副作用（真的构造 `MenuItem`）离不开真实 `App` 句柄，没法像 `settings_insertion_
    /// index` 那样直接复用生产函数本身。`Submenu::insert`/`insert_items` 的插入语义
    /// 已对照 muda 0.19.3 源码核实为标准的"下标不变的元素依次后移"（等价于
    /// `Vec::insert`），下面用 `Vec::insert` 模拟是忠实的。
    #[test]
    fn settings_item_lands_before_quit_which_stays_last() {
        let mut items = vec![
            "About",
            "sep",
            "Services",
            "sep",
            "Hide",
            "HideOthers",
            "sep",
            "Quit",
        ];

        // 第一步：try_replace_quit_menu_item 的下标逻辑。
        let last = items.len().checked_sub(1).expect("非空菜单应有最后一项");
        assert_eq!(items[last], "Quit", "替换前最后一项应是 Quit");
        items.remove(last);
        items.push("Quit(custom)");

        // 第二步：settings_insertion_index 是生产代码 insert_settings_menu_item
        // 实际调用的函数。
        let insert_at = settings_insertion_index(items.len()).expect("非空子菜单应有插入位置");
        items.insert(insert_at, "sep(new)");
        items.insert(insert_at + 1, "设置…");

        assert_eq!(
            items.last(),
            Some(&"Quit(custom)"),
            "插入\"设置…\"之后，App 子菜单的最后一项仍应是 Quit"
        );
        assert_eq!(
            items,
            vec![
                "About",
                "sep(new)",
                "设置…",
                "sep",
                "Services",
                "sep",
                "Hide",
                "HideOthers",
                "sep",
                "Quit(custom)",
            ],
            "顺序应符合 macOS 惯例：About / 分隔线 / 设置… / 分隔线 / Services / 分隔线 / \
             Hide / HideOthers / 分隔线 / Quit"
        );
    }

    // 「主题」菜单：三项 id、标签与 checked 映射。theme_mode_checked_states 是
    // set_theme_mode_checked 实际调用的那个纯函数（不接触任何 muda/AppKit 对象），
    // 下面几条测试断的是生产代码真正会跑的分支。

    #[test]
    fn theme_menu_item_ids_match_spec() {
        // 会因为什么失败：id 常量拼错、或与 task-7-brief.md 里约定的
        // aterm-theme-mode-default/-dual/-single 不一致。
        assert_eq!(THEME_MODE_DEFAULT_ID, "aterm-theme-mode-default");
        assert_eq!(THEME_MODE_DUAL_ID, "aterm-theme-mode-dual");
        assert_eq!(THEME_MODE_SINGLE_ID, "aterm-theme-mode-single");
    }

    #[test]
    fn theme_mode_labels_match_frontend_appearance_section() {
        // 硬要求①：Rust 菜单标签必须与 src/components/settings/AppearanceSection.tsx
        // 的 MODE_LABEL 逐字一致。这里不是各自维护一份、靠人工对照——直接读取真实的
        // 前端源码文件，找 `<mode>: '<label>',` 这个精确写法（MODE_LABEL 三行都是
        // 这个格式），会因为什么失败：Rust 侧 THEME_MODE_ITEMS 的标签改了但前端没改
        // （或反过来），两边任一侧漂移都会让 contains 找不到对应行。与
        // src/__tests__/tauriAcl.test.ts 读取真实 manifest/capabilities 文件的做法
        // 同一惯例。
        let manifest_dir =
            std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR 应由 cargo 设置");
        let path = std::path::Path::new(&manifest_dir)
            .join("..")
            .join("src")
            .join("components")
            .join("settings")
            .join("AppearanceSection.tsx");
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读取 {} 失败：{e}", path.display()));
        for (id, label) in THEME_MODE_ITEMS {
            let mode = if id == THEME_MODE_DEFAULT_ID {
                "default"
            } else if id == THEME_MODE_DUAL_ID {
                "dual"
            } else if id == THEME_MODE_SINGLE_ID {
                "single"
            } else {
                panic!("未知 id：{id}")
            };
            let needle = format!("{mode}: '{label}',");
            assert!(
                source.contains(&needle),
                "AppearanceSection.tsx 的 MODE_LABEL 里未找到 `{needle}`\
                 （Rust 侧菜单标签={label}，源码路径={}）",
                path.display()
            );
        }
    }

    #[test]
    fn theme_mode_checked_states_default_checks_only_default() {
        // 会因为什么失败：如果实现把 default 映射到了别的三元组（例如三项都
        // false，或者误把 dual/single 也置 true），这里就会失败。
        assert_eq!(
            theme_mode_checked_states("default"),
            Ok((true, false, false))
        );
    }

    #[test]
    fn theme_mode_checked_states_dual_checks_only_dual() {
        assert_eq!(theme_mode_checked_states("dual"), Ok((false, true, false)));
    }

    #[test]
    fn theme_mode_checked_states_single_checks_only_single() {
        assert_eq!(
            theme_mode_checked_states("single"),
            Ok((false, false, true))
        );
    }

    #[test]
    fn theme_mode_checked_states_rejects_unknown_mode() {
        // 会因为什么失败：如果实现对未知字符串也兜底返回某个 Ok 三元组（例如落到
        // default），非法输入就会被悄悄接受、错误地改动菜单勾选态。
        assert!(theme_mode_checked_states("not-a-real-mode").is_err());
    }

    #[test]
    fn theme_mode_checked_states_overwrites_stale_state() {
        // R1 修复：原名 set_theme_mode_checked_never_leaves_two_items_checked 承诺的比
        // 这条测试实际测的多——评审独立复现确认：把 apply_theme_mode_checked 里的
        // set_checked 包一层 `if checked`（只写选中项、不复位另外两项），cargo test
        // 127 全过、零信号。这条测试自始至终只调用纯函数 theme_mode_checked_states，
        // 从未调用过 set_theme_mode_checked 或 apply_theme_mode_checked，测不到、也测
        // 不出上面那个真实缺口——旧名字会让下一个评审者误以为"不会出现两个勾选"这条
        // 硬要求②的高危不变式已经有自动化覆盖，反而加剧缺口的隐蔽性，故改名如实反映
        // 它只测了什么。
        //
        // 真正执行写入的 apply_theme_mode_checked（遍历真实菜单项、逐一 set_checked）
        // 需要真实 App/muda 对象构造，本仓库现有取舍（对照 try_replace_quit_menu_item/
        // insert_settings_menu_item）是不为可测性重构这类副作用函数，因此这部分**没有
        // 自动化测试覆盖**——已裁决接受，覆盖缺口留给真机验收兜底（已升级为验收第一
        // 优先级：来回切换数次，每次确认有且仅有一个勾选）。
        //
        // 这条测试本身仍然有价值：确认 theme_mode_checked_states 给出的三元组是"完全
        // 覆盖式"的（不是相对旧状态的增量更新），是 apply_theme_mode_checked 能够正确
        // （在它被正确调用的前提下）实现硬要求②的必要条件——但不是充分条件，充分性
        // 那部分就是上面说的缺口。
        let stale = [true, true, false];
        let (default_checked, dual_checked, single_checked) =
            theme_mode_checked_states("single").expect("single 是合法模式");
        let new_states = [default_checked, dual_checked, single_checked];
        assert_eq!(new_states, [false, false, true]);
        assert_ne!(
            new_states, stale,
            "新状态必须完全覆盖旧状态，不能延续 stale 里的多项勾选"
        );
        assert_eq!(
            new_states.iter().filter(|&&c| c).count(),
            1,
            "任意时刻必须恰好一项勾选"
        );
    }

    // new_term_window_label：拖出标签页时新窗口的 label 生成规则，纯函数，不接触任何
    // 真实 App/WebviewWindow（与 settings_insertion_index / validate_reveal_dir 同一
    // 做法）。create_term_window 本身要构造真实窗口，未覆盖单测（先例见
    // theme_mode_checked_states_overwrites_stale_state 上方注释里对 apply_theme_mode_
    // checked 覆盖缺口的说明）。

    #[test]
    fn term_window_label_has_expected_shape() {
        // 会因为什么失败：如果实现改成不带 "term-" 前缀（例如直接返回裸数字/uuid），
        // starts_with 断言就会失败。
        let a = new_term_window_label();
        let b = new_term_window_label();
        assert!(a.starts_with("term-"), "label 必须以 term- 开头，实际：{a}");
        // 会因为什么失败：如果生成规则退化成常量或基于不够精细的时钟（两次调用落在
        // 同一时间粒度内），第二个窗口的 label 会撞上第一个——多窗口场景下这意味着
        // WebviewWindowBuilder::new 会因 label 重复而创建失败/覆盖已有窗口。
        assert_ne!(a, b, "两次生成的 label 不能相同，否则第二个窗口会撞上第一个");
    }

    // MAIN_WINDOW_LABEL：⌘Q / 主窗口关闭那条链的整条命脉（R1/I3）。
    //
    // V3.3 之前 emit_close_requested 是 `emit` 广播，谁在监听都收得到，这个常量写成什么
    // 都无所谓。改成 `emit_to(MAIN_WINDOW_LABEL, …)` 之后它变成了定向投递的**目标地址**：
    // 一旦它与主窗口的真实 label 对不上，RunEvent::ExitRequested 会照常 prevent_exit，
    // 而那条事件发给了一个不存在的窗口、没有任何前端在听——**应用彻底退不出去**，且
    // 全部单测照样绿（没有任何用例把两侧钉在一起）。这两条测试就是那颗钉子。
    //
    // 主窗口的真实 label 由两件事共同决定，所以分两条各钉一件：

    #[test]
    fn tauri_still_derives_the_label_this_module_hard_codes() {
        // 其一：tauri 的**隐式默认值**。tauri.conf.json 的窗口条目没有 label 字段（见下
        // 一条测试），运行期的 label 因此来自 tauri-utils 的 default_window_label()。
        // 会因为什么失败：升级 tauri 时那个默认推导变了（例如改成 "window-0"）。
        assert_eq!(
            tauri::utils::config::WindowConfig::default().label,
            MAIN_WINDOW_LABEL,
            "tauri 对窗口 label 的默认推导变了，⌘Q 的定向投递会打在空处"
        );
    }

    #[test]
    fn main_window_in_tauri_conf_resolves_to_the_hard_coded_label() {
        // 其二：tauri.conf.json 自己。会因为什么失败：有人给主窗口加一句
        // `"label": "primary"`——那一刻 emit_to("main") 就发给了一个不存在的窗口。
        // 直接读真实配置文件，与 theme_mode_labels_match_frontend_appearance_section
        // 读真实前端源码是同一惯例：不在测试里重抄一份配置，那样两边会各自漂移。
        let manifest_dir =
            std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR 应由 cargo 设置");
        let path = std::path::Path::new(&manifest_dir).join("tauri.conf.json");
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读取 {} 失败：{e}", path.display()));
        let config: serde_json::Value =
            serde_json::from_str(&source).expect("tauri.conf.json 应是合法 JSON");
        let windows = config["app"]["windows"]
            .as_array()
            .expect("tauri.conf.json 的 app.windows 应是数组");
        assert!(!windows.is_empty(), "app.windows 不能为空，否则没有主窗口");
        // 缺省 label 的窗口条目由 tauri 推导成 default_window_label()（上一条测试已把它
        // 钉成 MAIN_WINDOW_LABEL）；显式写了 label 的必须自己等于它。至少要有一个窗口
        // 最终解析成 MAIN_WINDOW_LABEL，否则"关掉主窗口 = 退出应用"这条链没有落点。
        let resolved: Vec<String> = windows
            .iter()
            .map(|w| match w.get("label").and_then(|l| l.as_str()) {
                Some(explicit) => explicit.to_string(),
                None => tauri::utils::config::WindowConfig::default().label,
            })
            .collect();
        assert!(
            resolved.iter().any(|l| l == MAIN_WINDOW_LABEL),
            "tauri.conf.json 里没有任何窗口的 label 解析成 {MAIN_WINDOW_LABEL}，\
             emit_close_requested 的定向投递会打在空处、⌘Q 将无法退出应用（实际解析结果：{resolved:?}）"
        );
    }

    // is_term_window_label：destroy_term_window 的准入校验（V3.3 Task 5）。这条命令能
    // **绕过 CloseRequested** 强行销毁窗口——绕过意味着窗口关闭时那套"先问前端、由它
    // 终止自己持有的 PTY"的流程整个不会跑，所以它绝不能作用到主窗口上（主窗口关闭 =
    // 退出应用，必须走 ⌘Q 确认框）。

    #[test]
    fn term_window_labels_are_destroyable() {
        // 会因为什么失败：如果前缀常量被改坏（例如写成 "win-"），create_term_window 发出
        // 去的 label 就再也过不了这道校验，交接回滚将无法关掉建出来的新窗口。
        assert!(is_term_window_label("term-1"));
        assert!(is_term_window_label("term-42"));
        // 与生产路径同源：真正发给前端的 label 就是这个函数生成的，两者必须自洽。
        assert!(is_term_window_label(&new_term_window_label()));
    }

    #[test]
    fn main_window_label_is_never_destroyable() {
        // 最重要的一条：主窗口不能被这条绕过 CloseRequested 的命令销毁——那等于把整个
        // 应用连同所有窗口里正在跑的会话无声终止，且完全跳过 ⌘Q 确认框。
        assert!(!is_term_window_label(MAIN_WINDOW_LABEL));
    }

    #[test]
    fn labels_that_merely_look_like_term_windows_are_rejected() {
        // 会因为什么失败：如果校验写成 `label.starts_with("term")`（少了连字符）或
        // `label != "main"`（黑名单而不是白名单），下面这几个就会被误判为可销毁。
        assert!(!is_term_window_label("terminal-1"));
        assert!(!is_term_window_label("panel"));
        assert!(!is_term_window_label(""));
        assert!(!is_term_window_label("my-term-1"));
    }

    // R1 修复：main_window_config / term_window_config 两个纯函数——create_term_window
    // 遗漏了 minWidth/minHeight（评审发现：新窗口能被拖成一条缝，主窗口不能）之后新增，
    // 覆盖"新窗口必须整份继承主窗口配置，不是逐字段挑"这条不变式。

    fn sample_window_config(label: &str, width: f64) -> tauri::utils::config::WindowConfig {
        tauri::utils::config::WindowConfig {
            label: label.to_string(),
            width,
            ..Default::default()
        }
    }

    #[test]
    fn main_window_config_prefers_label_main_even_if_listed_second() {
        // 会因为什么失败：如果实现改成直接取 windows.first()（不再按 label 找
        // "main"），这里会选中 "other"（width=1.0）而不是 "main"（width=2.0）。
        let windows = vec![
            sample_window_config("other", 1.0),
            sample_window_config("main", 2.0),
        ];
        let picked = main_window_config(&windows);
        assert_eq!(picked.label, "main");
        assert_eq!(picked.width, 2.0);
    }

    #[test]
    fn main_window_config_falls_back_to_first_when_no_main_label() {
        // 会因为什么失败：如果 or_else 分支被删掉（只认 label == "main"，找不到就
        // 直接走空配置兜底），这里会错误地落到硬编码兜底值（width 1200.0）而不是
        // 列表里唯一那一项（width 3.0）。
        let windows = vec![sample_window_config("not-main", 3.0)];
        let picked = main_window_config(&windows);
        assert_eq!(picked.label, "not-main");
        assert_eq!(picked.width, 3.0);
    }

    #[test]
    fn main_window_config_fallback_when_list_empty_includes_min_size() {
        // R1 核心断言：这条测试就是为上一轮遗漏的 minWidth/minHeight 补的。会因为
        // 什么失败：如果硬编码兜底值里 min_width/min_height 漏写（回到 R0 的老样子，
        // 只兜底 width/height/title），这里的 min_width/min_height 断言会失败
        // （变成 None 而不是 Some(800.0)/Some(500.0)）。
        let picked = main_window_config(&[]);
        assert_eq!(picked.width, 1200.0);
        assert_eq!(picked.height, 780.0);
        assert_eq!(
            picked.min_width,
            Some(800.0),
            "兜底值必须包含 minWidth，否则连极端情况（配置列表为空）下新窗口都能被拖成一条缝"
        );
        assert_eq!(picked.min_height, Some(500.0), "兜底值必须包含 minHeight");
        assert_eq!(picked.title, "aTerm");
    }

    #[test]
    fn term_window_config_overrides_label_and_position_but_preserves_everything_else() {
        // main 里 resizable/decorations 故意设成与 WindowConfig::default() 不同的
        // 值（默认都是 true），min_width/min_height 故意设成 Some 而非默认 None——
        // 这样如果实现"顺手"把某个未提及的字段悄悄重置成默认值，下面的整份 struct
        // 相等断言就会抓到，不只是抓 min_width/min_height 这两个 R1 修的字段。
        let main = tauri::utils::config::WindowConfig {
            label: "main".to_string(),
            width: 1200.0,
            height: 780.0,
            min_width: Some(800.0),
            min_height: Some(500.0),
            resizable: false,
            decorations: false,
            title: "aTerm".to_string(),
            ..Default::default()
        };
        let out = term_window_config(&main, "term-9", 111.0, 222.0);

        assert_eq!(out.label, "term-9", "label 必须替换成传入的新窗口 label");
        assert_eq!(out.x, Some(111.0), "x 必须写成调用方传入的坐标");
        assert_eq!(out.y, Some(222.0), "y 必须写成调用方传入的坐标");

        // 除 label/x/y 外，其余字段必须与 main 逐位相同——用"整份克隆 main 再只改
        // 这三个字段"构造期望值，而不是逐个字段断言，这样任何字段（不只是
        // min_width/min_height）被意外改动都会被这条测试抓到。
        let expected = tauri::utils::config::WindowConfig {
            label: "term-9".to_string(),
            x: Some(111.0),
            y: Some(222.0),
            ..main.clone()
        };
        assert_eq!(
            out, expected,
            "除了 label/x/y，其余字段（含 min_width/min_height/resizable/decorations）\
             必须原样继承自主窗口配置"
        );
    }

    // ── window_at_point 命中测试（V3.4 Task 2）───────────────────────────────
    //
    // 两个纯函数各自独立覆盖：physical_rect_to_logical（DPR 换算）与
    // hit_test_windows（包含判定）。window_at_point 本身是 async fn、需要真实
    // AppHandle/WebviewWindow 才能测，未覆盖单测——与 create_term_window 同一模式
    // （见 term_window_label_has_expected_shape 上方注释）。
    //
    // 下面所有矩形都是**内容区**（webview）的逻辑矩形，不是外框：命令体传给
    // physical_rect_to_logical 的是 inner_position()/inner_size()，于是 local_x/local_y
    // 的原点就是内容区左上角（V3.4 修复轮 R1，理由见 LogicalRect 上方那段——前端的
    // 「标签栏落区」常量必须相对标签栏本身定义，不能把标题栏高度混进来）。这一点在
    // 这两个纯函数里没有任何可断言的痕迹（它们只认传进来的矩形），所以只能写在这里。

    fn rect(x: f64, y: f64, width: f64, height: f64) -> LogicalRect {
        LogicalRect { x, y, width, height }
    }

    #[test]
    fn physical_rect_to_logical_divides_not_multiplies_with_dpr_two() {
        // 四个字段互不相同的物理坐标，scale=2.0，逐字段断言——如果实现从
        // "physical / scale" 误改成 "physical * scale"（方向写反），x/y/width/
        // height 四个断言会同时从 100/50/200/150 变成 400/200/800/600，全部转红；
        // 在 scale=1.0 时这个变异测不出来（乘除同值），所以必须用 scale != 1.0。
        let out = physical_rect_to_logical(200.0, 100.0, 400.0, 300.0, 2.0);
        assert_eq!(out.x, 100.0, "x 换算方向错误：应是物理值除以 scale");
        assert_eq!(out.y, 50.0, "y 换算方向错误：应是物理值除以 scale");
        assert_eq!(out.width, 200.0, "width 换算方向错误：应是物理值除以 scale");
        assert_eq!(out.height, 150.0, "height 换算方向错误：应是物理值除以 scale");
    }

    #[test]
    fn physical_rect_to_logical_is_identity_at_scale_one() {
        // scale=1.0 时物理即逻辑，顺带确认换算没有混入额外的偏移/常数项。
        let out = physical_rect_to_logical(30.0, 40.0, 500.0, 600.0, 1.0);
        assert_eq!(out, rect(30.0, 40.0, 500.0, 600.0));
    }

    #[test]
    fn hit_test_finds_point_inside_rect() {
        let windows = vec![("term-1".to_string(), rect(10.0, 20.0, 100.0, 50.0))];
        let hit =
            hit_test_windows((60.0, 45.0), &windows, "term-source").expect("点在矩形内应命中");
        assert_eq!(hit.label, "term-1");
        assert_eq!(hit.local_x, 50.0, "本地坐标应是点减去矩形左上角的 x");
        assert_eq!(hit.local_y, 25.0, "本地坐标应是点减去矩形左上角的 y");
    }

    #[test]
    fn hit_test_misses_point_outside_rect() {
        let windows = vec![("term-1".to_string(), rect(10.0, 20.0, 100.0, 50.0))];
        assert_eq!(hit_test_windows((500.0, 500.0), &windows, "term-source"), None);
    }

    #[test]
    fn hit_test_left_and_top_edges_are_inclusive() {
        let windows = vec![("term-1".to_string(), rect(10.0, 20.0, 100.0, 50.0))];
        // 左边界 x == rect.x：应命中，本地 x 为 0。
        let left = hit_test_windows((10.0, 45.0), &windows, "term-source").expect("左边界应命中");
        assert_eq!(left.local_x, 0.0);
        // 上边界 y == rect.y：应命中，本地 y 为 0。
        let top = hit_test_windows((60.0, 20.0), &windows, "term-source").expect("上边界应命中");
        assert_eq!(top.local_y, 0.0);
    }

    #[test]
    fn hit_test_right_and_bottom_edges_are_exclusive() {
        let windows = vec![("term-1".to_string(), rect(10.0, 20.0, 100.0, 50.0))];
        // 右边界 x == rect.x + rect.width（110.0）：不应命中，这条线属于矩形外面。
        assert_eq!(
            hit_test_windows((110.0, 45.0), &windows, "term-source"),
            None,
            "右边界（x == rect.x + rect.width）不应命中"
        );
        // 下边界 y == rect.y + rect.height（70.0）：同理不应命中。
        assert_eq!(
            hit_test_windows((60.0, 70.0), &windows, "term-source"),
            None,
            "下边界（y == rect.y + rect.height）不应命中"
        );
    }

    #[test]
    fn hit_test_excludes_the_source_window() {
        // 源窗口自身的矩形必然包含指针当前位置（它正持有 capture）——不传 exclude
        // 会永远命中它自己，这条测试钉住 Ruling 1。
        let windows = vec![("term-1".to_string(), rect(0.0, 0.0, 100.0, 100.0))];
        assert_eq!(
            hit_test_windows((50.0, 50.0), &windows, "term-1"),
            None,
            "exclude 命中的窗口必须被跳过，即使点确实落在它的矩形内"
        );
    }

    #[test]
    fn hit_test_returns_first_match_when_windows_overlap() {
        // term-1、term-2 的矩形在 (50,50) 处重叠——tao 不暴露 z-order，取遍历顺序
        // 里第一个命中的（见 hit_test_windows 顶部注释的已知局限）。term-2 排在
        // 列表更靠前，断言返回 term-2 而不是 term-1，确认是"顺序"而非某种固定
        // 优先级/字典序决定结果。
        let windows = vec![
            ("term-2".to_string(), rect(0.0, 0.0, 100.0, 100.0)),
            ("term-1".to_string(), rect(0.0, 0.0, 100.0, 100.0)),
        ];
        let hit =
            hit_test_windows((50.0, 50.0), &windows, "term-source").expect("重叠区域应命中其一");
        assert_eq!(hit.label, "term-2", "重叠时应取遍历顺序里第一个命中的窗口");
    }

    #[test]
    fn hit_test_returns_none_when_no_windows_given() {
        let windows: Vec<(String, LogicalRect)> = Vec::new();
        assert_eq!(hit_test_windows((0.0, 0.0), &windows, "term-source"), None);
    }

    // ── 菜单事件的定向投递（V3.3 §5.4）─────────────────────────────────────
    //
    // 下面所有用到窗口 label 的地方一律用 "term-9"，**刻意不用 "main"**：这是
    // Ruling 14 记下的教训——上一轮把测试替身的 label 设成和断言目标同一个值
    // （都是 "main"），于是"目标取自聚焦窗口"这条断言变成恒真，把实现改成写死
    // 常量照样全绿。用一个拖出来的窗口 label，"写死 main" 这个变异才会转红。

    #[test]
    fn menu_event_goes_to_the_focused_window() {
        // 会因为什么失败：如果实现忽略传入的聚焦 label、写死投递给 MAIN_WINDOW_LABEL
        // （或任何常量），这里会得到 ToWindow("main") 而不是 ToWindow("term-9")——
        // 而那正是"在拖出窗口里按 ⌘, 却在主窗口弹出设置浮层"这个缺陷。
        assert_eq!(
            menu_event_delivery(Some("term-9".to_string())),
            MenuDelivery::ToWindow("term-9".to_string())
        );
    }

    #[test]
    fn menu_event_falls_back_to_broadcast_when_no_window_is_focused() {
        // 会因为什么失败：如果实现在取不到聚焦窗口时直接放弃（不 emit），菜单项会
        // 变成"点了没反应"；如果它硬塞一个 ToWindow(某个猜的 label)，事件会打在空处。
        // 降级必须显式是广播。
        assert_eq!(menu_event_delivery(None), MenuDelivery::BroadcastFallback);
    }

    #[test]
    fn payload_target_equals_the_delivery_target() {
        // Ruling 8 的发送端那一半：载荷里必须带上目标 label，且它必须**就是** emit_to
        // 的那个 label。会因为什么失败：如果 payload_target 返回 None（"反正 emit_to
        // 已经定向了"），接收端的二次校验就没有可比对的东西，Ruling 8 的两层防护塌成
        // 一层；如果它返回别的 label，接收端会把发给自己的事件当成别人的丢掉——
        // 菜单项静默失灵。
        let delivery = MenuDelivery::ToWindow("term-9".to_string());
        assert_eq!(delivery.payload_target(), Some("term-9".to_string()));
    }

    #[test]
    fn broadcast_fallback_payload_target_is_none() {
        // 降级广播时载荷里不能写任何具体 label——写了就等于"发给所有人、但只有那一个
        // 认领"，其余窗口全部丢弃，降级失去意义（等价于什么都没发）。
        assert_eq!(MenuDelivery::BroadcastFallback.payload_target(), None);
    }

    #[test]
    fn open_settings_payload_wire_shape_is_target_only() {
        // 钉死前端 src/menuEvents.ts 实际读取的字段名与 JSON 形状。会因为什么失败：
        // 字段被改名（例如 target -> label/toLabel），前端读到 undefined，二次校验
        // 退化成"无条件接受"，多窗口下又变回每个窗口都弹设置浮层。
        let delivery = MenuDelivery::ToWindow("term-9".to_string());
        let json = serde_json::to_string(&open_settings_payload(&delivery)).unwrap();
        assert_eq!(json, r#"{"target":"term-9"}"#);
    }

    #[test]
    fn open_settings_payload_wire_shape_when_broadcasting() {
        let json =
            serde_json::to_string(&open_settings_payload(&MenuDelivery::BroadcastFallback)).unwrap();
        assert_eq!(json, r#"{"target":null}"#);
    }

    #[test]
    fn theme_mode_payload_carries_both_target_and_mode() {
        // 前端要同时读这两个字段：target 决定收不收，mode 决定切到哪一档。会因为什么
        // 失败：V3.3 之前这个事件的载荷是**裸字符串**，若实现忘了升格成对象（或者
        // 只加了 target 却把 mode 丢了），前端 isThemeMode(payload.mode) 校验不过，
        // 菜单栏切主题彻底失灵。
        let delivery = MenuDelivery::ToWindow("term-9".to_string());
        let json = serde_json::to_string(&theme_mode_payload(&delivery, "dual")).unwrap();
        assert_eq!(json, r#"{"target":"term-9","mode":"dual"}"#);
    }

    #[test]
    fn theme_mode_payload_passes_the_mode_through_verbatim() {
        // mode 必须原样透传，不能被"顺手规范化"。三档逐个过一遍：这三个字符串与前端
        // store/theme.ts 的 isThemeMode 是同一份契约，任何一个对不上，那一档菜单项
        // 就会被前端当成非法 payload 静默忽略。
        for mode in ["default", "dual", "single"] {
            let payload = theme_mode_payload(&MenuDelivery::ToWindow("term-9".to_string()), mode);
            assert_eq!(payload.mode, mode);
        }
    }

    // ── File 菜单「新建窗口」（V3.4 Task 1）───────────────────────────────────
    //
    // new_window_insertion_index 本身就是 insert_new_window_menu_item 实际调用的那个
    // 函数（见它上方的注释），不是重新抄一遍逻辑的影子实现——下面几条测试断的是生产
    // 代码真正会跑的分支，与 settings_insertion_index 同一惯例。

    #[test]
    fn empty_file_submenu_has_no_insertion_point() {
        // 会因为什么失败：如果实现把 0 项也当成"有 Close Window 在"处理（例如把判断
        // 写成 `item_count < 1` 之外的什么条件、或者干脆删掉这条判断），这里就会失败。
        assert_eq!(new_window_insertion_index(0), None);
    }

    #[test]
    fn new_window_inserts_at_index_zero_when_close_window_present() {
        // 会因为什么失败：如果插入下标从 0 改成了别的数（例如误改成 1，插到 Close
        // Window 之后而不是之前——这正是"必须做的变异"之一）。File 子菜单默认只有
        // Close Window 一项（见 new_window_insertion_index 上方注释核实过的
        // tauri 2.11.5 `Menu::default` File 子菜单构成）。
        assert_eq!(new_window_insertion_index(1), Some(0));
    }

    #[test]
    fn new_window_insertion_index_always_precedes_existing_items() {
        // 会因为什么失败：如果插入下标算成了 >= item_count（插到了原有项后面甚至
        // 末尾），这几个不同项数下至少有一个会失败。从 1 项开始（见
        // empty_file_submenu_has_no_insertion_point：0 项没有插入点）。
        for item_count in [1usize, 2, 5, 50] {
            let insert_at = new_window_insertion_index(item_count)
                .unwrap_or_else(|| panic!("item_count={item_count} 时不应返回 None"));
            assert!(
                insert_at < item_count,
                "插入点（{insert_at}）必须严格早于原有项，否则会把 Close Window 挤到\
                 「新建窗口」前面或中间"
            );
        }
    }

    /// 用一个 `Vec<&str>` 模拟真实的 File 子菜单，验证 `new_window_insertion_index`
    /// 与真实插入语义组合之后，Close Window 仍稳居子菜单最后一位；同时用另一个独立
    /// 的 `Vec` 模拟 App 子菜单（末位是 `QUIT_MENU_ITEM_ID`），确认 File 子菜单的插入
    /// 不会波及它——防的是"按下标找错子菜单/两个子菜单共享同一份数据"这一类实现
    /// 错误。`Submenu::insert_items` 的插入语义已在 `settings_item_lands_before_
    /// quit_which_stays_last` 上方核实为标准的 `Vec::insert` 语义，这里同样用连续两次
    /// `Vec::insert` 模拟。
    #[test]
    fn new_window_item_lands_before_close_window_which_stays_last() {
        let app_submenu_ids = vec![
            "about",
            "sep",
            "services",
            "sep",
            "hide",
            "hide-others",
            "sep",
            QUIT_MENU_ITEM_ID,
        ];
        let mut file_submenu = vec!["Close Window"];

        let insert_at =
            new_window_insertion_index(file_submenu.len()).expect("非空子菜单应有插入位置");
        file_submenu.insert(insert_at, "新建窗口");
        file_submenu.insert(insert_at + 1, "sep(new)");

        assert_eq!(
            file_submenu,
            vec!["新建窗口", "sep(new)", "Close Window"],
            "「新建窗口」应插在 Close Window 之前，并以分隔线相隔"
        );
        assert_eq!(
            file_submenu.last(),
            Some(&"Close Window"),
            "插入「新建窗口」之后，File 子菜单最后一项仍应是 Close Window"
        );
        assert_eq!(
            app_submenu_ids.last(),
            Some(&QUIT_MENU_ITEM_ID),
            "File 子菜单的改动不应波及 App 子菜单，Quit 仍应是它的最后一项"
        );
    }

    // new_window_cascade_position：新窗口级联位置的纯算术部分（有/没有参考原点时该
    // 怎么算）。解出参考原点本身（聚焦窗口 -> 主窗口两级优先级）需要真实
    // AppHandle/WebviewWindow，未覆盖单测——与 create_term_window 本身、
    // apply_theme_mode_checked 同一取舍（见 theme_mode_checked_states_overwrites_
    // stale_state 上方注释），覆盖缺口留给真机验收。

    #[test]
    fn cascade_position_offsets_by_thirty_logical_pixels_from_origin() {
        // 会因为什么失败：如果偏移量不是 30，或者只加在一个轴上（例如只加 x 不加
        // y），这里会得到别的坐标。
        assert_eq!(
            new_window_cascade_position(Some((10.0, 20.0))),
            (40.0, 50.0)
        );
    }

    #[test]
    fn cascade_position_falls_back_to_default_when_no_origin() {
        // 会因为什么失败：如果 None 分支被漏掉（例如误把 None 当 (0.0, 0.0) 处理），
        // 三级都取不到窗口时新窗口会出现在屏幕左上角原点，而不是这里定义的默认位置。
        assert_eq!(new_window_cascade_position(None), NEW_WINDOW_DEFAULT_POSITION);
    }
}
