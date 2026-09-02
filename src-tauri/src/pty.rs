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

#[tauri::command(async)]
pub fn pty_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
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

/// 存活 PTY 的**全应用**总数——不区分是哪个窗口持有的。
///
/// 为什么必须由 Rust 来数（V3.3 设计文档 §5.2）：前端原来的 `countLiveTerminalTabs()`
/// 遍历的是**本窗口**的标签，多窗口之后那只是全部会话的一个子集。而 ⌘Q 是**应用级**
/// 退出，会连同别的窗口里正在跑的 claude 一起终止——确认框却只报本窗口那几个，用户
/// 据此点"确定"就等于在不知情的情况下杀掉了另一个窗口里的会话。`PtyManager` 本就掌握
/// 全部 PTY（每个窗口的 `pty_spawn` 都落进同一张 map），是这个数字唯一的、也是天然
/// 跨窗口的真相来源。
///
/// **必须逐个 `is_alive()` 过滤，不能直接用 `map.len()`**：子进程自己退出（用户在终端
/// 里敲了 exit）之后要等 `pty_spawn` 里注册的 on_exit 回调跑到才会被摘出 map，两者之间
/// 有一段窗口期；这段时间里 `len()` 会把已经死掉的记录也算进去，确认框于是报出一个虚高
/// 的数字（"还有 3 个会话在运行"而其实只剩 1 个）。
///
/// 锁中毒时返回 `Err` 而不是悄悄给个 0：0 会让确认框退化成"确定关闭 aTerm？"这条不含
/// 任何警告的文案，而这恰恰是最需要警告的时刻。调用方（src/closeRequest.ts）接住这个
/// `Err` 时会 console.warn 留痕，与本仓库对"静默吞异常"的一贯态度一致。
pub fn count_alive(map: &Mutex<HashMap<String, Arc<PtyHandle>>>) -> Result<usize, String> {
    let map = map.lock().map_err(|e| e.to_string())?;
    Ok(map.values().filter(|h| h.is_alive()).count())
}

#[tauri::command]
pub fn pty_alive_count(state: State<PtyManager>) -> Result<usize, String> {
    count_alive(&state.0)
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

    /// 造一个真实的、会一直活着的 PTY（`/bin/cat` 不读到 EOF 就不退出），交给
    /// `count_alive` 数。不用 mock：`is_alive` 的真值来自 `pty_core::spawn` 起的那条
    /// 等待线程，只有真实进程才能让"存活"这件事有意义。
    fn spawn_living_pty() -> PtyHandle {
        crate::pty_core::spawn(
            "/bin/cat", &[], None, None, 80, 24,
            Box::new(|_| {}), Box::new(|_| {}),
        ).expect("测试用 pty 应能创建")
    }

    /// V3.3 §5.2：⌘Q 的确认框要报的是**全应用**存活会话数。空 map 必须给 0，
    /// 否则应用刚启动、一个终端都没开时也会弹出"还有 N 个会话在运行"。
    #[test]
    fn count_alive_is_zero_when_no_ptys() {
        let map: Mutex<HashMap<String, Arc<PtyHandle>>> = Mutex::new(HashMap::new());
        assert_eq!(count_alive(&map), Ok(0));
    }

    /// 多个 PTY 一起数——这正是多窗口场景（每个窗口的 pty_spawn 都落进同一张 map）。
    /// 会因为什么失败：如果实现只数第一个、或返回布尔/Option 之类的退化值。
    #[test]
    fn count_alive_counts_every_living_pty() {
        let map: Mutex<HashMap<String, Arc<PtyHandle>>> = Mutex::new(HashMap::new());
        {
            let mut m = map.lock().unwrap();
            m.insert("pty-1".to_string(), Arc::new(spawn_living_pty()));
            m.insert("pty-2".to_string(), Arc::new(spawn_living_pty()));
            m.insert("pty-3".to_string(), Arc::new(spawn_living_pty()));
        }
        assert_eq!(count_alive(&map), Ok(3));
        for h in map.lock().unwrap().values() { h.kill(); }
    }

    /// 核心断言：已经死掉、但**还没被 on_exit 摘出 map** 的记录不算数。
    ///
    /// 会因为什么失败：如果实现写成 `map.len()`（少了 `is_alive()` 过滤），被 kill 掉的
    /// 那个仍留在这张 map 里（这里的 on_exit 是空回调，与真实的 pty_spawn 不同——而真实
    /// 路径上 on_exit 也只是**稍后**才跑，同样存在这段窗口期），计数会停在 2，确认框于是
    /// 报出一个虚高的数字。
    #[test]
    fn count_alive_ignores_dead_ptys_still_present_in_the_map() {
        let map: Mutex<HashMap<String, Arc<PtyHandle>>> = Mutex::new(HashMap::new());
        {
            let mut m = map.lock().unwrap();
            m.insert("pty-alive".to_string(), Arc::new(spawn_living_pty()));
            m.insert("pty-doomed".to_string(), Arc::new(spawn_living_pty()));
        }
        assert_eq!(count_alive(&map), Ok(2), "前置：两个都活着");

        map.lock().unwrap().get("pty-doomed").unwrap().kill();
        // kill 之后 alive 标志由 pty_core 那条 wait 线程置位，不是同步的——轮询到
        // 超时，避免固定 sleep 在慢机器上偶发失败。
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if count_alive(&map) == Ok(1) { break; }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(count_alive(&map), Ok(1), "被 kill 的那个虽然还在 map 里，但不该被算进存活数");

        for h in map.lock().unwrap().values() { h.kill(); }
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
