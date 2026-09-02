mod pty;
mod pty_core;
mod reveal;
mod sessions;
mod status;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{MenuItem, PredefinedMenuItem};
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

/// macOS 专属：App 菜单里"设置…"项被点击（或按下 ⌘,）时，广播给前端打开设置浮层
/// （`useSettings.getState().openSettings()`，见 src/App.tsx 附近对 `menu-open-settings`
/// 的监听）。与 emit_close_requested 同一风格：用 `AppHandle::emit` 广播给所有
/// webview，不针对某个具体窗口——前端 `listen('menu-open-settings', ...)` 本来就是
/// 全局监听，不区分来源窗口。
#[cfg(target_os = "macos")]
fn emit_open_settings(app_handle: &AppHandle) {
    let _ = app_handle.emit("menu-open-settings", ());
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
/// 必须在 `replace_quit_menu_item` 之后调用——这是调用方（`setup` 里）的硬性顺序
/// 要求，理由见该函数上方那段长注释：让它看到的子菜单仍是默认菜单固定的那个顺序
/// （About / 分隔线 / Services / 分隔线 / Hide / HideOthers / 分隔线 / Quit(custom)），
/// 不会因为本函数先插入了"设置…"而打乱下标、让已经过真机验证过的替换逻辑意外失灵。
#[cfg(target_os = "macos")]
fn insert_settings_menu_item<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
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

/// macOS 专属：`setup()` 里菜单初始化的唯一入口，把"必须先 `replace_quit_menu_item`、
/// 再 `insert_settings_menu_item`"这条顺序不变式绑进一个函数里。
///
/// 为什么用结构而不是测试来守：这条顺序要求本身没法用 `cargo test` 自动化覆盖——
/// `tauri::test::mock_builder()` 会 `.enable_macos_default_menu(false)`，mock 出来的
/// `App` 没有真菜单可插，手工搭一份 8 项菜单成本高，且 mock runtime 未必忠实复现
/// AppKit 行为（见 `settings_insertion_index`/`insert_settings_menu_item` 上方注释、
/// `reveal.rs` 的同类先例）。原来这两次调用是 `setup()` 里两条独立语句，靠注释提醒
/// 顺序——评审实测过：把这两行对调，`cargo build`/`cargo test` 照样全绿（120 passed，
/// 0 failed），没有任何自动化信号能拦住这个回归。收进一个函数、顺序写死在函数体内部
/// 之后，顺序和解释它的这段注释从此相邻——比隔着 `setup()` 里其它语句的两条独立调用
/// 难破坏得多（想写错顺序，必须先看到、再无视紧挨着的这段注释去手动调换下面两行）。
///
/// `replace_quit_menu_item`/`insert_settings_menu_item` 两个函数本身保持独立、各自仍可
/// 单测（`settings_insertion_index` 的单测见文件末尾 `#[cfg(test)]` 模块）——这里只负责
/// 按正确顺序把它们粘在一起，不合并两者的实现，也不改动各自原有的失败即降级逻辑与
/// 警告文案。
#[cfg(target_os = "macos")]
fn setup_macos_menu<R: tauri::Runtime>(app: &tauri::App<R>) {
    // 启动可用性优先于 ⌘Q 确认：这里替换的是 Tauri 默认菜单的内部结构（见
    // replace_quit_menu_item 上方的详细注释），一旦未来某次 tauri/muda 升级改变了默认
    // 菜单的项数/顺序导致这里返回 Err，原先的 `?` 会让它经由 `.setup()` 直接冒泡，被
    // `.build().expect(...)` 当场 panic 掉——应用直接无法启动，这比它想防护的问题
    // （⌘Q 未经确认就退出）严重得多。因此改为失败即降级：打印警告后继续启动，此时 ⌘Q
    // 会退回系统默认行为（bypass 掉关闭确认弹窗，但至少应用能正常打开）。
    if let Err(e) = replace_quit_menu_item(app) {
        eprintln!(
            "警告：替换 Quit 菜单项失败，⌘Q 将退回系统默认行为（不会弹出关闭确认）：{e}"
        );
    }

    // 必须排在 replace_quit_menu_item 之后：见本函数上方注释——它假设看到的子菜单仍是
    // 默认菜单固定的那个顺序。同样的失败即降级理由（应用能打开比菜单项齐全重要）：
    // 这里返回 Err 只打印警告，不让 `?`/`.expect(...)` 把它变成启动期 panic。
    if let Err(e) = insert_settings_menu_item(app) {
        eprintln!("警告：插入\"设置…\"菜单项失败，⌘, 将不可用：{e}");
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
            {
                if event.id().as_ref() == QUIT_MENU_ITEM_ID {
                    // 与窗口 CloseRequested 同一套处理：不在这里直接退出，只是把决定权
                    // 转交前端确认弹窗（confirm_exit 才是真正退出的入口）。
                    emit_close_requested(app_handle);
                } else if event.id().as_ref() == SETTINGS_MENU_ITEM_ID {
                    emit_open_settings(app_handle);
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
            status::get_session_statuses,
            status::installer::hooks_status,
            status::installer::install_hooks,
            status::installer::uninstall_hooks,
            reveal::reveal_in_finder,
            confirm_exit
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
        // replace_quit_menu_item 上方注释核实过的 tauri 2.11.5 `Menu::default`）。
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

    /// 用一个 `Vec<&str>` 模拟真实的 App 子菜单，验证 `replace_quit_menu_item` 与
    /// `insert_settings_menu_item` 两步下标逻辑组合之后，Quit 仍稳居子菜单最后一位、
    /// 且整体顺序符合 macOS 惯例——不构造真实 `App` 句柄（那需要一整套窗口环境，见
    /// `settings_insertion_index` 上方注释里提到的、本仓库 `reveal.rs` 的既有先例）。
    ///
    /// 第二步用的下标（`settings_insertion_index(items.len())`）是生产代码
    /// `insert_settings_menu_item` 真正调用的那个函数；第一步（remove_at(len-1) 再
    /// append）抄的是 `replace_quit_menu_item` 里同样两行的下标算法，因为那一步的
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

        // 第一步：replace_quit_menu_item 的下标逻辑。
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
}
