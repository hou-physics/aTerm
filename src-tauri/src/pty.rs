use crate::pty_core::{self, PtyHandle};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct PtyManager(pub Mutex<HashMap<String, Arc<PtyHandle>>>);

#[derive(Clone, Serialize)]
struct OutPayload { id: String, data: String }
#[derive(Clone, Serialize)]
struct ExitPayload { id: String, code: u32 }

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
pub fn pty_spawn(app: AppHandle, state: State<PtyManager>, cwd: Option<String>, inject: Option<String>, cols: u16, rows: u16) -> Result<String, String> {
    let id = format!("pty-{}", NEXT_ID.fetch_add(1, Ordering::SeqCst));
    let cwd_path = cwd.map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir());
    let (a1, a2, id1, id2) = (app.clone(), app.clone(), id.clone(), id.clone());
    let handle = pty_core::spawn(
        "/bin/zsh", &["-l".to_string()], cwd_path.as_deref(), inject.as_deref(), cols, rows,
        Box::new(move |bytes| {
            let _ = a1.emit("pty-output", OutPayload { id: id1.clone(), data: B64.encode(bytes) });
        }),
        Box::new(move |code| {
            a2.state::<PtyManager>().0.lock().ok().map(|mut m| m.remove(&id2));
            let _ = a2.emit("pty-exit", ExitPayload { id: id2.clone(), code });
        }),
    )?;
    // 子进程可能在 insert 之前就已退出：此时 on_exit 里的 remove 是空操作，
    // 若不补一次自查，这条已死的记录会永久滞留在 map 里。
    // 安全性依据：alive 严格先于 on_exit 被置为 false（两者均 SeqCst），
    // 所以「on_exit 已跑过」蕴含「is_alive() == false」，这里必定能兜住。
    let arc = Arc::new(handle);
    state.0.lock().map_err(|e| e.to_string())?.insert(id.clone(), arc.clone());
    if !arc.is_alive() {
        let _ = state.0.lock().map(|mut m| m.remove(&id));
    }
    Ok(id)
}

/// 取出 `Arc<PtyHandle>` 后**先释放 map 锁**再执行回调。
/// 回调里可能是阻塞的 `write_all`（tty 输入队列写满时会阻塞），
/// 若持锁执行，全局所有 pty 命令（含 `pty_kill`）都会被卡死。
fn with_pty<T>(map: &Mutex<HashMap<String, Arc<PtyHandle>>>, id: &str, f: impl FnOnce(&PtyHandle) -> T) -> Result<T, String> {
    let h = {
        let map = map.lock().map_err(|e| e.to_string())?;
        map.get(id).cloned()
    };
    h.map(|h| f(&h)).ok_or_else(|| format!("pty 不存在: {id}"))
}

#[tauri::command]
pub fn pty_write(state: State<PtyManager>, id: String, data: String) -> Result<(), String> {
    with_pty(&state.0, &id, |h| h.write(data.as_bytes()))?
}
#[tauri::command]
pub fn pty_resize(state: State<PtyManager>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    with_pty(&state.0, &id, |h| h.resize(cols, rows))?
}
#[tauri::command]
pub fn pty_kill(state: State<PtyManager>, id: String) -> Result<(), String> {
    with_pty(&state.0, &id, |h| h.kill())
}
#[tauri::command]
pub fn pty_is_alive(state: State<PtyManager>, id: String) -> bool {
    with_pty(&state.0, &id, |h| h.is_alive()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// 回归：回调阻塞时（真实场景是子进程不读 stdin 导致 `write_all` 卡住），
    /// 全局 map 锁必须已经释放，否则 `pty_kill` 等命令会一并被卡死、用户无法自救。
    #[test]
    fn with_pty_releases_map_lock_before_running_callback() {
        let handle = crate::pty_core::spawn(
            "/bin/cat", &[], None, None, 80, 24,
            Box::new(|_| {}), Box::new(|_| {}),
        ).expect("测试用 pty 应能创建");
        let map: Arc<Mutex<HashMap<String, Arc<PtyHandle>>>> = Arc::new(Mutex::new(HashMap::new()));
        map.lock().unwrap().insert("pty-1".to_string(), Arc::new(handle));

        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let map2 = map.clone();
        let worker = std::thread::spawn(move || {
            with_pty(&map2, "pty-1", move |_h| {
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            })
        });

        entered_rx.recv_timeout(Duration::from_secs(5)).expect("回调应被调用");
        // 关键断言：回调仍在执行中，此刻 map 锁必须是空闲的
        assert!(map.try_lock().is_ok(), "回调执行期间不得持有全局 map 锁");
        release_tx.send(()).unwrap();
        worker.join().unwrap().expect("with_pty 应返回 Ok");

        let removed = map.lock().unwrap().remove("pty-1");
        if let Some(h) = removed { h.kill(); }
    }

    /// 回归：会话被并发移除后，各命令的降级语义 —— write/resize/kill 返回 Err，
    /// is_alive 返回 false，均不 panic。
    #[test]
    fn missing_pty_degrades_to_err_without_panicking() {
        let map: Mutex<HashMap<String, Arc<PtyHandle>>> = Mutex::new(HashMap::new());
        let err = with_pty(&map, "pty-404", |h| h.is_alive()).unwrap_err();
        assert!(err.contains("pty 不存在: pty-404"), "实际错误: {err}");
        assert!(!with_pty(&map, "pty-404", |h| h.is_alive()).unwrap_or(false));
    }
}
