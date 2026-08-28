mod pty;
mod pty_core;
mod sessions;
mod status;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

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

/// 窗口 `CloseRequested`、应用级 `ExitRequested`、（macOS 上替换掉默认 Quit 项后的）自定义
/// Quit 菜单项，三条路径共用的"通知前端弹确认"逻辑，避免各自维护一份重复代码。用
/// `AppHandle::emit` 而不是某个具体窗口的 `emit`：与被替换前的窗口路径（`window.emit`）
/// 语义一致——两者都是广播给所有 webview，不是发给某个特定窗口的定向事件，前端
/// `listen('app-close-requested', ...)` 本来就是全局监听，不区分来源窗口。
fn emit_close_requested(app_handle: &AppHandle) {
    let _ = app_handle.emit("app-close-requested", ());
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

#[cfg(target_os = "macos")]
fn replace_quit_menu_item<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyManager::default())
        .manage(sessions::subagents::SubagentCache::default())
        .manage(ExitConfirmed(AtomicBool::new(false)))
        .on_window_event(|window, event| {
            // 只关心主窗口（本应用只有一个窗口，label 固定为 "main"）；显式判断而非依赖
            // "反正只有一个窗口"这个隐含前提，未来加窗口也不会意外影响到它们。
            if window.label() != "main" {
                return;
            }
            // `CloseRequested` 是 `#[non_exhaustive]` 的结构体变体，匹配时必须带 `..`。
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 挡下这次关闭：真正退出与否交给前端弹出确认对话框后决定
                // （见 confirm_exit 命令与前端 src/closeRequest.ts）。
                api.prevent_close();
                emit_close_requested(window.app_handle());
            }
        })
        .on_menu_event(|app_handle, event| {
            #[cfg(target_os = "macos")]
            if event.id().as_ref() == QUIT_MENU_ITEM_ID {
                // 与窗口 CloseRequested 同一套处理：不在这里直接退出，只是把决定权转交
                // 前端确认弹窗（confirm_exit 才是真正退出的入口）。
                emit_close_requested(app_handle);
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
            status::get_session_statuses,
            status::installer::hooks_status,
            status::installer::install_hooks,
            status::installer::uninstall_hooks,
            confirm_exit
        ])
        .setup(|app| {
            // 状态引擎（P2b）：起文件监听 + 后台刷新线程，注册管理状态。返回的句柄
            // 必须交给 `.manage()` 存起来——它内部持有 `notify` 的监听器，drop 掉就会
            // 停止监听；必须活到应用退出，与下面 macOS 专属那段互不相干，谁先谁后
            // 不影响正确性，放在最前面只是顺序上更自然。
            app.manage(status::start(app.handle()));

            #[cfg(target_os = "macos")]
            {
                // 启动可用性优先于 ⌘Q 确认：这里替换的是 Tauri 默认菜单的内部结构（见
                // replace_quit_menu_item 上方的详细注释），一旦未来某次 tauri/muda 升级
                // 改变了默认菜单的项数/顺序导致这里返回 Err，原先的 `?` 会让它经由
                // `.setup()` 直接冒泡，被 `.build().expect(...)` 当场 panic 掉——应用
                // 直接无法启动，这比它想防护的问题（⌘Q 未经确认就退出）严重得多。
                // 因此改为失败即降级：打印警告后继续启动，此时 ⌘Q 会退回系统默认行为
                // （bypass 掉关闭确认弹窗，但至少应用能正常打开）。
                if let Err(e) = replace_quit_menu_item(app) {
                    eprintln!(
                        "警告：替换 Quit 菜单项失败，⌘Q 将退回系统默认行为（不会弹出关闭确认）：{e}"
                    );
                }
            }
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
                let already_confirmed = app_handle
                    .state::<ExitConfirmed>()
                    .0
                    .load(Ordering::SeqCst);
                if !already_confirmed {
                    api.prevent_exit();
                    emit_close_requested(app_handle);
                }
            }
        });
}
