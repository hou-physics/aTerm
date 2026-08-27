mod pty;
mod pty_core;
mod sessions;

use tauri::{AppHandle, Emitter, WindowEvent};

/// 前端确认"仍要关闭"后调用：真正退出应用。与 `CloseRequested` 里的 `prevent_close`
/// 配对——那一半只挡下系统的关闭请求并把决定权转交前端弹窗，这条命令才是那次弹窗
/// 点了"确定"之后真正执行退出的入口。
#[tauri::command]
fn confirm_exit(app_handle: AppHandle) {
    app_handle.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyManager::default())
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
                let _ = window.emit("app-close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            sessions::scan::list_projects,
            sessions::conversation::read_conversation,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_is_alive,
            confirm_exit
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
