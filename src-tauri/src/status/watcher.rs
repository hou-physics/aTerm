//! 文件监听 + 去抖 + 内存态注册表：把 §3 架构图里"文件监听 → 去抖 → 增量元数据解析 →
//! 进程存活探测 → 状态引擎"这条链路串起来，并把变化过的状态发到前端。
//!
//! 三个监听根（spec §3/§5/`~/.claude/sessions`）：
//! - `~/.claude/projects/`：会话转录（`.jsonl`），只在目录已存在时监听——**绝不创建**
//!   `~/.claude/` 下的任何路径，缺失就跳过并打日志降级
//! - `~/.claude/sessions/`：Claude Code 自己的进程登记表，同样只读、缺失即跳过
//! - `~/Library/Application Support/aTerm/`：aTerm 自有数据目录，用来放
//!   `hook-events.jsonl`。这是我们自己的目录，不在"`~/.claude/` 只读"的约束范围内，
//!   缺失时可以创建（否则连"监听这个目录、等 hook 文件将来出现"都做不到）

use super::engine::{self, HookSignal, Status};
use super::hooks;
use super::{SessionStatusPayload, StatusStore};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// 每文件 120ms 去抖（spec §3/§8）。
const DEBOUNCE_MS: u64 = 120;

// ---------------------------------------------------------------------------
// Debouncer：纯粹的"尾部去抖"状态机，不碰真实时钟/线程，靠调用方喂时间戳。
// 测试可以完全用合成的毫秒数驱动，不需要真的 sleep。
// ---------------------------------------------------------------------------

pub struct Debouncer<K: Eq + Hash + Clone> {
    delay_ms: u64,
    /// key -> 触发时刻（毫秒）。同一 key 的新事件会推迟这个时刻，实现"合并为一次"。
    pending: HashMap<K, u64>,
}

impl<K: Eq + Hash + Clone> Debouncer<K> {
    pub fn new(delay_ms: u64) -> Self {
        Self { delay_ms, pending: HashMap::new() }
    }

    /// 记录一次事件；同一 key 在窗口内再次出现只会推迟触发时刻，不会产生第二次触发。
    pub fn record_event(&mut self, key: K, now_ms: u64) {
        self.pending.insert(key, now_ms + self.delay_ms);
    }

    /// 取出所有"触发时刻已到"的 key，并从 pending 里移除（每个 key 只会被取出一次，
    /// 除非之后又有新事件为它重新记录）。
    pub fn poll_ready(&mut self, now_ms: u64) -> Vec<K> {
        let ready: Vec<K> =
            self.pending.iter().filter(|&(_, &fires_at)| fires_at <= now_ms).map(|(k, _)| k.clone()).collect();
        for k in &ready {
            self.pending.remove(k);
        }
        ready
    }
}

// ---------------------------------------------------------------------------
// 进程存活探测：不轮询，只在需要时（规则 4/5）探测一次。用裸 `kill(pid, 0)`
// （POSIX 标准的"探测但不发送信号"用法）而不是引入额外的进程枚举依赖。
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn pid_is_alive(pid: u32) -> bool {
    // extern "C" 块直接链接系统 libc 的 kill(2)，unix 目标上标准库本身就会链接 libc，
    // 不需要额外引入 `libc` crate这一整个依赖。signal 0 是探测用法：不真的发信号，
    // 只探测目标 pid 是否存在（且我们有权限探测它）——返回 0 即存活。
    // 已知局限：同用户但因某些沙箱策略导致 EPERM 的极端情况会被误判为"已死"；
    // 这种情况在 aTerm 场景（同用户子进程）里预期不会出现，未特别处理。
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid as i32, 0) == 0 }
}

#[cfg(not(unix))]
fn pid_is_alive(_pid: u32) -> bool {
    // 本项目目前只发布 macOS；非 unix 平台没有零依赖的等价探测手段。保守起见当作
    // "存活"处理（不会把一个可能仍在运行的会话误判为已完成），后续若要支持其他
    // 平台需要在这里补上真实实现。
    true
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 读取 `~/.claude/sessions/*.json`（Claude Code 自己维护的进程登记表）。这是它的内部
/// 格式，可能变化——解析失败的单个文件直接跳过，不让整个目录的读取失败；目录本身
/// 不存在时返回空表（调用方按"无法判定存活性"处理，见 `engine::infer_status` 的
/// `process_alive: None` 语义）。
#[derive(Deserialize)]
struct RawSessionRecord {
    pid: u32,
    #[serde(rename = "sessionId")]
    session_id: String,
}

pub fn read_session_registry(dir: &Path) -> HashMap<String, u32> {
    let mut map = HashMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return map };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue; // 目录里还有 `.key` 等其它文件，只关心登记表本身
        }
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let Ok(raw) = serde_json::from_str::<RawSessionRecord>(&content) else { continue };
        map.insert(raw.session_id, raw.pid);
    }
    map
}

/// 与 `sessions::scan::is_uuid_stem` 同一条判定规则，在此单独维护一份小拷贝——
/// 那边是私有函数，不想为了这一个用途扩大它的可见性（本任务的改动面刻意限制在
/// `status/` 目录内）。两处如果将来分叉，靠各自的测试各自兜底。
fn is_uuid_stem(stem: &str) -> bool {
    stem.len() == 36
        && stem.chars().filter(|c| *c == '-').count() == 4
        && stem.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

// ---------------------------------------------------------------------------
// EngineState：监听线程私有的内存态注册表。单线程独占访问（只在 run_loop 里被
// 修改/读取），不需要额外加锁。
// ---------------------------------------------------------------------------

struct ThreadState {
    dir_name: String,
    root_key: String,
    last_append_ms: i64,
    active_session_id: String,
}

pub struct EngineState {
    projects_dir: PathBuf,
    sessions_dir: PathBuf,
    hook_events_path: PathBuf,
    /// jsonl 文件的 session_id（文件名去掉扩展名）→ 它所属的线程键
    /// （`"{dir_name}::{root_key}"`，与 `scan.rs` 的 root_key 语义一致，见 mod.rs 的
    /// payload 文档）。一条链上的所有 resume 文件都映射到同一个线程键。
    session_to_thread: HashMap<String, String>,
    threads: HashMap<String, ThreadState>,
    /// session_id → 该会话最近一条 hook 事件（若有）
    hook_last: HashMap<String, hooks::HookEvent>,
    /// session_id → pid（来自 `~/.claude/sessions/*.json`）
    pids: HashMap<String, u32>,
}

impl EngineState {
    pub fn new(projects_dir: PathBuf, sessions_dir: PathBuf, hook_events_path: PathBuf) -> Self {
        Self {
            projects_dir,
            sessions_dir,
            hook_events_path,
            session_to_thread: HashMap::new(),
            threads: HashMap::new(),
            hook_last: HashMap::new(),
            pids: HashMap::new(),
        }
    }

    /// 启动时的一次性全量扫描：复用 `sessions::scan::group_chain_files` 的分组逻辑
    /// （链键计算规则只在那一处实现，这里不重复一份），为每个已存在的会话建立初始
    /// 线程状态。之后的更新都走增量路径（`refresh_transcript` 等），不再整目录重扫。
    pub fn rescan_projects_dir(&mut self) {
        self.session_to_thread.clear();
        self.threads.clear();
        let Ok(entries) = std::fs::read_dir(&self.projects_dir) else { return };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let dir_name = dir.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            let groups = crate::sessions::scan::group_chain_files(&dir);
            for (root_key, mut files) in groups {
                files.sort_by_key(|f| f.meta.last_ts_ms.unwrap_or(f.mtime_ms));
                let thread_key = format!("{dir_name}::{root_key}");
                for f in &files {
                    self.session_to_thread.insert(f.session_id.clone(), thread_key.clone());
                }
                if let Some(newest) = files.last() {
                    self.threads.insert(
                        thread_key,
                        ThreadState {
                            dir_name: dir_name.clone(),
                            root_key: root_key.clone(),
                            last_append_ms: newest.meta.last_ts_ms.unwrap_or(newest.mtime_ms),
                            active_session_id: newest.session_id.clone(),
                        },
                    );
                }
            }
        }
    }

    pub fn seed_hook_events(&mut self) {
        self.hook_last = hooks::read_last_events_per_session(&self.hook_events_path);
    }

    pub fn seed_process_registry(&mut self) {
        self.pids = read_session_registry(&self.sessions_dir);
    }

    pub fn thread_keys(&self) -> Vec<String> {
        self.threads.keys().cloned().collect()
    }

    /// 单个转录文件变化后的增量刷新：只读该文件的头部（链键）+尾部（最后活动时间），
    /// 有界读取，绝不整篇解析（spec §8）。文件在读取过程中消失/损坏时，两个读取函数
    /// 本身就是防御式的（`Err` 时退回空结果），这里不会 panic，只会得到一个"信息量
    /// 很少"的更新（例如 last_ts 退回 0），不会破坏已有的、更新的状态——见下方
    /// "只在新时间戳不早于已记录值时才覆盖"的判断。
    pub fn refresh_transcript(&mut self, path: &Path) -> Option<String> {
        let stem = path.file_stem().and_then(|s| s.to_str())?.to_string();
        let dir_name = path.parent().and_then(|p| p.file_name()).and_then(|s| s.to_str())?.to_string();

        let head = crate::sessions::parser::read_head_lines(path, 40, 256 * 1024).unwrap_or_default();
        let tail = crate::sessions::parser::read_tail_lines(path, 64 * 1024).unwrap_or_default();
        let meta = crate::sessions::parser::parse_meta(&head, &tail);
        let root_key = meta.first_user_uuid.unwrap_or_else(|| stem.clone());

        let mtime_ms = std::fs::metadata(path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let last_ts = meta.last_ts_ms.unwrap_or(mtime_ms);

        let thread_key = format!("{dir_name}::{root_key}");
        self.session_to_thread.insert(stem.clone(), thread_key.clone());
        let entry = self.threads.entry(thread_key.clone()).or_insert_with(|| ThreadState {
            dir_name: dir_name.clone(),
            root_key: root_key.clone(),
            last_append_ms: i64::MIN,
            active_session_id: stem.clone(),
        });
        if last_ts >= entry.last_append_ms {
            entry.last_append_ms = last_ts;
            entry.active_session_id = stem;
        }
        Some(thread_key)
    }

    /// hook 事件文件变化后的刷新：先按 spec §5 轮转，再重新读取"每个 session 的最后
    /// 一条事件"，与上一次的快照逐条比较，只把真正变化了的 session 映射到的线程键
    /// 收集出来交给上层重新判定状态。
    pub fn refresh_hooks(&mut self) -> Vec<String> {
        if let Err(e) = hooks::rotate_if_needed(&self.hook_events_path) {
            eprintln!("警告：hook 事件文件轮转失败，将继续尝试读取（不影响状态判定）：{e}");
        }
        let latest = hooks::read_last_events_per_session(&self.hook_events_path);
        let mut touched = Vec::new();
        for (session_id, event) in &latest {
            let changed = self.hook_last.get(session_id) != Some(event);
            if changed {
                if let Some(thread_key) = self.session_to_thread.get(session_id) {
                    touched.push(thread_key.clone());
                }
            }
        }
        self.hook_last = latest;
        touched
    }

    /// `~/.claude/sessions/` 变化后的刷新：整目录重读（本身很小），与上一次快照比较
    /// pid 是否变化（含新增/消失），变化涉及的 session 映射到的线程键收集出来。
    pub fn refresh_sessions_registry(&mut self) -> Vec<String> {
        let latest = read_session_registry(&self.sessions_dir);
        let mut all_ids: HashSet<String> = self.pids.keys().cloned().collect();
        all_ids.extend(latest.keys().cloned());

        let mut touched = Vec::new();
        for session_id in &all_ids {
            if self.pids.get(session_id) != latest.get(session_id) {
                if let Some(thread_key) = self.session_to_thread.get(session_id) {
                    touched.push(thread_key.clone());
                }
            }
        }
        self.pids = latest;
        touched
    }

    /// 对一个线程键调用 spec §4 的纯判定函数，拼出下一版状态。`thread_key` 必须来自
    /// `self.threads`（不存在时返回 `None`，调用方直接跳过——不会发生，但防御式处理）。
    pub fn compute_status(&self, thread_key: &str, now: i64) -> Option<ComputedStatus> {
        let t = self.threads.get(thread_key)?;
        let last_hook =
            self.hook_last.get(&t.active_session_id).map(|e| HookSignal { kind: e.signal.kind, ts_ms: e.signal.ts_ms });
        let alive = self.pids.get(&t.active_session_id).map(|pid| pid_is_alive(*pid));
        let status = engine::infer_status(last_hook, Some(t.last_append_ms), alive, now);
        Some(ComputedStatus {
            dir_name: t.dir_name.clone(),
            root_key: t.root_key.clone(),
            session_id: t.active_session_id.clone(),
            status,
            last_activity_ms: t.last_append_ms,
        })
    }
}

pub struct ComputedStatus {
    pub dir_name: String,
    pub root_key: String,
    pub session_id: String,
    pub status: Status,
    pub last_activity_ms: i64,
}

// ---------------------------------------------------------------------------
// 路径分类 + 主循环
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum WatchTarget {
    Transcript(PathBuf),
    HookEvents,
    SessionsRegistry,
}

struct Roots {
    projects_dir: PathBuf,
    sessions_dir: PathBuf,
    hook_events_path: PathBuf,
}

fn classify(path: &Path, roots: &Roots) -> Option<WatchTarget> {
    if path == roots.hook_events_path {
        return Some(WatchTarget::HookEvents);
    }
    if !roots.sessions_dir.as_os_str().is_empty() && path.starts_with(&roots.sessions_dir) {
        return Some(WatchTarget::SessionsRegistry);
    }
    if !roots.projects_dir.as_os_str().is_empty()
        && path.starts_with(&roots.projects_dir)
        && path.extension().and_then(|e| e.to_str()) == Some("jsonl")
        && path.file_stem().and_then(|s| s.to_str()).map(is_uuid_stem).unwrap_or(false)
    {
        return Some(WatchTarget::Transcript(path.to_path_buf()));
    }
    None
}

fn apply_and_collect_changes(
    engine_state: &EngineState,
    store: &StatusStore,
    touched_threads: &[String],
) -> Vec<SessionStatusPayload> {
    let now = now_ms();
    let mut changed = Vec::new();
    let mut guard = match store.0.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(), // 前一个持锁者 panic 不该让整条状态推送链路瘫痪
    };
    for tk in touched_threads {
        let Some(c) = engine_state.compute_status(tk, now) else { continue };
        let payload = SessionStatusPayload {
            dir_name: c.dir_name,
            root_key: c.root_key,
            session_id: c.session_id,
            status: c.status,
            last_activity_ms: c.last_activity_ms,
            updated_at_ms: now,
        };
        let status_changed = guard.get(tk).map(|prev| prev.status != payload.status).unwrap_or(true);
        if status_changed {
            changed.push(payload.clone());
        }
        // 元数据（lastActivityMs 等）无论状态是否变化都写回快照，保证
        // `get_session_statuses()` 读到的永远是最新值；只有"是否发 Tauri 事件"
        // 才受"状态是否变化"约束（spec §8）。
        guard.insert(tk.clone(), payload);
    }
    changed
}

fn run_loop(app: AppHandle, rx: std::sync::mpsc::Receiver<notify::Result<notify::Event>>, roots: Roots) {
    let mut engine_state = EngineState::new(roots.projects_dir.clone(), roots.sessions_dir.clone(), roots.hook_events_path.clone());
    engine_state.rescan_projects_dir();
    engine_state.seed_hook_events();
    engine_state.seed_process_registry();

    // 初始快照：写入 store，并在扫描完成的这一刻发一次 `session-status` 事件（哪怕这次
    // 扫描一个会话都没找到，空数组本身也是"初始扫描已经跑完"这个事实的信号）。
    //
    // 这里刻意不套用"只在状态变化时才发事件"那条规则（spec §8 那条规则针对的是*之后*
    // 的增量更新，见 apply_and_collect_changes）：`get_session_statuses()` 命令是前端在
    // 挂载时主动拉取的，但初始扫描本身跑在这个后台线程里、异步完成，二者之间存在竞态
    // ——前端拉取的那一刻这份 store 很可能还是空的（`rescan_projects_dir` 遍历
    // `~/.claude/projects` 全量目录，量级接近 `list_projects()`），此后就再也没有第二次
    // 拉取的机会（后续只靠事件驱动的增量合并）。如果这里不额外发一次事件，前端会永远
    // 停留在那次过早调用拿到的空快照上，直到*下一次真实变化*才第一次收到数据——现实里
    // 可能是几分钟甚至更久之后。发这一次事件后，前端 `applyEntries` 会按
    // `updatedAtMs` 合并（见 `src/store/status.ts`），不需要关心它和先前拉取的快照
    // 谁先谁后到达。
    let store = app.state::<StatusStore>();
    let mut initial_payloads: Vec<SessionStatusPayload> = Vec::new();
    {
        let now = now_ms();
        let mut guard = match store.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        for tk in engine_state.thread_keys() {
            if let Some(c) = engine_state.compute_status(&tk, now) {
                let payload = SessionStatusPayload {
                    dir_name: c.dir_name,
                    root_key: c.root_key,
                    session_id: c.session_id,
                    status: c.status,
                    last_activity_ms: c.last_activity_ms,
                    updated_at_ms: now,
                };
                guard.insert(tk, payload.clone());
                initial_payloads.push(payload);
            }
        }
    }
    let _ = app.emit("session-status", initial_payloads);

    let mut debouncer: Debouncer<WatchTarget> = Debouncer::new(DEBOUNCE_MS);
    loop {
        match rx.recv_timeout(std::time::Duration::from_millis(50)) {
            Ok(Ok(event)) => {
                let now = now_ms() as u64;
                for p in &event.paths {
                    if let Some(target) = classify(p, &roots) {
                        debouncer.record_event(target, now);
                    }
                }
            }
            Ok(Err(e)) => {
                eprintln!("警告：文件监听报告了一个错误，已忽略并继续运行：{e}");
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                eprintln!("警告：文件监听通道已断开（监听器可能已被丢弃），状态引擎监听线程退出，状态将不再实时更新");
                return;
            }
        }

        let ready = debouncer.poll_ready(now_ms() as u64);
        if ready.is_empty() {
            continue;
        }

        let mut touched_threads: Vec<String> = Vec::new();
        for target in ready {
            match target {
                WatchTarget::Transcript(path) => {
                    if let Some(tk) = engine_state.refresh_transcript(&path) {
                        touched_threads.push(tk);
                    }
                }
                WatchTarget::HookEvents => touched_threads.extend(engine_state.refresh_hooks()),
                WatchTarget::SessionsRegistry => touched_threads.extend(engine_state.refresh_sessions_registry()),
            }
        }
        touched_threads.sort();
        touched_threads.dedup();
        if touched_threads.is_empty() {
            continue;
        }

        let changed = apply_and_collect_changes(&engine_state, &store, &touched_threads);
        if !changed.is_empty() {
            let _ = app.emit("session-status", changed);
        }
    }
}

/// 监听器需要在 app 整个生命周期内存活；这个句柄本身不暴露任何方法，只是靠
/// `Drop`（隐式，未自定义）在 app 退出时随管理状态一起被丢弃。字段用 `Mutex` 包一层
/// 只是为了满足 Tauri `.manage()` 要求的 `Sync`（`RecommendedWatcher` 本身是否 `Sync`
/// 取决于底层平台实现，不依赖这个假设更稳妥）。
pub struct WatcherGuard {
    _watcher: Mutex<Option<RecommendedWatcher>>,
}

/// 启动状态引擎：建立/校验三个监听根、起监听器、把主循环丢到专用后台线程。
/// 任何一步的失败都只导致"这一部分的实时更新不可用"，绝不 panic、绝不阻塞
/// 应用启动（`~/.claude/` 下两个目录本就可能在全新安装时还不存在）。
pub fn start(app: AppHandle) -> WatcherGuard {
    let home = dirs::home_dir();
    let projects_dir = canonical_or(home.as_ref().map(|h| h.join(".claude").join("projects")).unwrap_or_default());
    let sessions_dir = canonical_or(home.as_ref().map(|h| h.join(".claude").join("sessions")).unwrap_or_default());
    let app_data_dir_raw = dirs::data_dir().map(|d| d.join("aTerm")).unwrap_or_default();

    // 这是 aTerm 自己的数据目录（不在 `~/.claude/` 之下），创建它不违反"`~/.claude/`
    // 全程只读"的约束——不创建的话，hook-events.jsonl 出现之前我们连"监听它父目录、
    // 等它出现"都做不到（spec §3 明确要求容忍该文件尚不存在）。
    if !app_data_dir_raw.as_os_str().is_empty() {
        if let Err(e) = std::fs::create_dir_all(&app_data_dir_raw) {
            eprintln!("警告：无法创建 aTerm 数据目录 {}：{e}（hook 事件文件监听将不可用）", app_data_dir_raw.display());
        }
    }
    // 规范化（解析符号链接）后再用作 classify() 的比较基准：macOS 上 `/tmp`、`/var`
    // 都是指向 `/private/...` 的符号链接，FSEvents 报告的路径是已解析过的真实路径，
    // 用未解析的原始路径去 `starts_with` 比较会永远不匹配（这里的三个根路径在真实
    // 用户主目录下通常不会撞上这个问题，但 `dirs::data_dir()`/`home_dir()` 在个别
    // 系统配置下仍可能经过符号链接，规范化一次、只在启动时做一次，代价可忽略）。
    let app_data_dir = canonical_or(app_data_dir_raw);
    let hook_events_path = app_data_dir.join("hook-events.jsonl");

    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let watcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(mut w) => {
            watch_if_exists(&mut w, &projects_dir, "~/.claude/projects");
            watch_if_exists(&mut w, &sessions_dir, "~/.claude/sessions");
            watch_if_exists(&mut w, &app_data_dir, "aTerm 数据目录");
            Some(w)
        }
        Err(e) => {
            eprintln!("警告：创建文件监听器失败，状态引擎不可用（其余功能不受影响）：{e}");
            None
        }
    };

    let roots = Roots { projects_dir, sessions_dir, hook_events_path };
    std::thread::spawn(move || {
        // 整条链路跑在专用线程里；用 catch_unwind 兜底，任何未预见到的 panic 只会
        // 让这一个线程退出（状态不再更新），不会带崩整个应用（spec §10）。
        // `app` 内部本身就是一个 Arc（`AppHandle` 设计如此），克隆代价很低，这里
        // 跟 `pty.rs` 里 `on_exit`/`OutPayload` 回调访问 `PtyManager` 的方式同一套
        // 习惯：不额外自建 `Arc<Mutex<_>>`，直接用 `app.state::<T>()` 取managed state。
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_loop(app, rx, roots);
        }));
        if outcome.is_err() {
            eprintln!("警告：状态引擎监听线程发生 panic 并已退出，状态将不再实时更新（应用其余部分不受影响）");
        }
    });

    WatcherGuard { _watcher: Mutex::new(watcher) }
}

/// 规范化路径（解析符号链接）；路径为空或尚不存在（`canonicalize` 要求路径存在）时
/// 原样返回——空路径本就代表"取不到用户主目录"这类已经在别处处理过的降级情形，
/// 不存在的路径会在 `watch_if_exists` 里被单独判定并跳过监听，不需要在这里重复处理。
fn canonical_or(path: PathBuf) -> PathBuf {
    if path.as_os_str().is_empty() {
        return path;
    }
    std::fs::canonicalize(&path).unwrap_or(path)
}

fn watch_if_exists(watcher: &mut RecommendedWatcher, dir: &Path, label: &str) {
    if dir.as_os_str().is_empty() {
        return;
    }
    if !dir.is_dir() {
        eprintln!("提示：{label}（{}）不存在，跳过监听（不会创建它）", dir.display());
        return;
    }
    if let Err(e) = watcher.watch(dir, RecursiveMode::Recursive) {
        eprintln!("警告：无法监听 {label}（{}）：{e}", dir.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // Debouncer：合成时间戳驱动，不依赖真实 sleep。
    // ------------------------------------------------------------------

    #[test]
    fn debounce_single_event_fires_after_delay() {
        let mut d: Debouncer<&str> = Debouncer::new(120);
        d.record_event("a", 0);
        assert!(d.poll_ready(100).is_empty(), "延迟未到不应触发");
        assert_eq!(d.poll_ready(120), vec!["a"], "延迟恰好到达应触发（含边界）");
    }

    #[test]
    fn debounce_repeated_events_coalesce_into_one_fire() {
        // 高频事件（模拟会话快速输出）：每次都记录一次事件，但最终只应触发一次。
        let mut d: Debouncer<&str> = Debouncer::new(120);
        d.record_event("a", 0);
        d.record_event("a", 50); // 窗口内又来一次：应该推迟触发时刻到 50+120=170
        d.record_event("a", 90); // 再来一次：推迟到 90+120=210
        assert!(d.poll_ready(170).is_empty(), "第三次事件应把触发时刻继续往后推");
        let ready = d.poll_ready(210);
        assert_eq!(ready, vec!["a"]);
        // 触发之后 pending 已清空，不会重复触发。
        assert!(d.poll_ready(1_000).is_empty());
    }

    #[test]
    fn debounce_different_keys_are_independent() {
        let mut d: Debouncer<&str> = Debouncer::new(120);
        d.record_event("a", 0);
        d.record_event("b", 200);
        let ready_at_120 = d.poll_ready(120);
        assert_eq!(ready_at_120, vec!["a"], "b 的延迟还没到，不该被取出");
        let ready_at_320 = d.poll_ready(320);
        assert_eq!(ready_at_320, vec!["b"]);
    }

    #[test]
    fn debounce_new_event_after_fire_schedules_a_fresh_window() {
        let mut d: Debouncer<&str> = Debouncer::new(120);
        d.record_event("a", 0);
        assert_eq!(d.poll_ready(120), vec!["a"]);
        // 触发之后，同一个 key 再来一次事件应该重新计时，而不是永远不再触发。
        d.record_event("a", 500);
        assert!(d.poll_ready(600).is_empty());
        assert_eq!(d.poll_ready(620), vec!["a"]);
    }

    // ------------------------------------------------------------------
    // 路径分类
    // ------------------------------------------------------------------

    fn test_roots(tmp: &Path) -> Roots {
        Roots {
            projects_dir: tmp.join(".claude").join("projects"),
            sessions_dir: tmp.join(".claude").join("sessions"),
            hook_events_path: tmp.join("aTerm").join("hook-events.jsonl"),
        }
    }

    #[test]
    fn classifies_transcript_hook_events_and_sessions_registry_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = test_roots(tmp.path());

        let transcript = roots.projects_dir.join("-some-proj").join("11111111-1111-1111-1111-111111111111.jsonl");
        assert_eq!(classify(&transcript, &roots), Some(WatchTarget::Transcript(transcript.clone())));

        assert_eq!(classify(&roots.hook_events_path, &roots), Some(WatchTarget::HookEvents));

        let session_json = roots.sessions_dir.join("12345.json");
        assert_eq!(classify(&session_json, &roots), Some(WatchTarget::SessionsRegistry));
    }

    #[test]
    fn ignores_non_uuid_jsonl_and_unrelated_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = test_roots(tmp.path());

        // agent-*.jsonl 不是合法的 uuid 文件名——group_chain_files 也会跳过它。
        let agent_file = roots.projects_dir.join("-some-proj").join("agent-xyz.jsonl");
        assert_eq!(classify(&agent_file, &roots), None);

        // 轮转产生的临时文件不应被当成 hook-events.jsonl 本体处理。
        let rotate_tmp = roots.hook_events_path.with_extension("jsonl.rotate.tmp");
        assert_eq!(classify(&rotate_tmp, &roots), None);

        let unrelated = tmp.path().join("some-other-file.txt");
        assert_eq!(classify(&unrelated, &roots), None);
    }

    // ------------------------------------------------------------------
    // 进程存活探测：用当前测试进程自己的 pid（必然存活）与一个几乎不可能存在的 pid。
    // ------------------------------------------------------------------

    #[test]
    fn current_process_pid_is_alive() {
        assert!(pid_is_alive(std::process::id()));
    }

    #[test]
    fn implausible_pid_is_not_alive() {
        // PID_MAX 在 macOS 上是 99998；用一个明显超界的值确保它不可能是真实进程。
        assert!(!pid_is_alive(u32::MAX / 2));
    }

    // ------------------------------------------------------------------
    // 会话登记表解析：畸形/缺字段的记录被跳过，不让整个目录读取失败；
    // 不存在的目录返回空表而不是 panic。
    // ------------------------------------------------------------------

    #[test]
    fn session_registry_skips_malformed_entries_and_non_json_files() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("111.json"), r#"{"pid":111,"sessionId":"s1","status":"busy"}"#).unwrap();
        std::fs::write(tmp.path().join("222.json"), "not json at all").unwrap();
        std::fs::write(tmp.path().join("333.json"), r#"{"pid":333}"#).unwrap(); // 缺 sessionId
        std::fs::write(tmp.path().join("111.key"), "should be ignored").unwrap();

        let registry = read_session_registry(tmp.path());
        assert_eq!(registry.len(), 1);
        assert_eq!(registry.get("s1"), Some(&111));
    }

    #[test]
    fn session_registry_missing_dir_returns_empty_not_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");
        assert!(read_session_registry(&missing).is_empty());
    }

    // ------------------------------------------------------------------
    // EngineState 增量刷新：单文件变化只影响它自己的线程状态，元信息读取即便文件
    // 损坏/消失也不 panic。
    // ------------------------------------------------------------------

    fn write_transcript(dir: &Path, session_id: &str, root_uuid: &str, text: &str, ts: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(format!("{session_id}.jsonl"));
        let line = format!(
            r#"{{"parentUuid":null,"isSidechain":false,"cwd":"/tmp/x","sessionId":"{session_id}","timestamp":"{ts}","type":"user","message":{{"role":"user","content":"{text}"}},"uuid":"{root_uuid}"}}"#
        );
        std::fs::write(&path, format!("{line}\n")).unwrap();
        path
    }

    #[test]
    fn refresh_transcript_creates_a_thread_and_tracks_last_activity() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-tmp-proj");
        let path = write_transcript(
            &proj,
            "11111111-1111-1111-1111-111111111111",
            "root-u",
            "你好",
            "2026-08-20T10:00:00.000Z",
        );

        let mut state = EngineState::new(tmp.path().join("projects"), tmp.path().join("sessions"), tmp.path().join("hook-events.jsonl"));
        let thread_key = state.refresh_transcript(&path).expect("应识别出线程键");
        assert_eq!(thread_key, "-tmp-proj::root-u");

        let now = chrono::DateTime::parse_from_rfc3339("2026-08-20T10:00:00.000Z").unwrap().timestamp_millis();
        let computed = state.compute_status(&thread_key, now).expect("应能算出状态");
        assert_eq!(computed.dir_name, "-tmp-proj");
        assert_eq!(computed.root_key, "root-u");
        assert_eq!(computed.session_id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(computed.last_activity_ms, now);
    }

    #[test]
    fn refresh_transcript_survives_vanished_file_without_panicking() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("does-not-exist").join("11111111-1111-1111-1111-111111111111.jsonl");
        let mut state = EngineState::new(tmp.path().join("projects"), tmp.path().join("sessions"), tmp.path().join("hook-events.jsonl"));
        // 文件从未存在：应优雅降级（返回 Some，root_key 退回文件名），不 panic。
        let thread_key = state.refresh_transcript(&path);
        assert!(thread_key.is_some());
    }

    #[test]
    fn refresh_hooks_reports_only_threads_whose_event_changed() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-tmp-proj");
        let path = write_transcript(
            &proj,
            "11111111-1111-1111-1111-111111111111",
            "root-u",
            "你好",
            "2026-08-20T10:00:00.000Z",
        );
        let hook_path = tmp.path().join("hook-events.jsonl");

        let mut state = EngineState::new(tmp.path().join("projects"), tmp.path().join("sessions"), hook_path.clone());
        let thread_key = state.refresh_transcript(&path).unwrap();

        std::fs::write(
            &hook_path,
            r#"{"event":"Notification","sessionId":"11111111-1111-1111-1111-111111111111","ts":123}"#.to_string() + "\n",
        )
        .unwrap();
        let touched = state.refresh_hooks();
        assert_eq!(touched, vec![thread_key.clone()]);

        // 再次刷新、文件内容未变：不应报告任何变化。
        let touched_again = state.refresh_hooks();
        assert!(touched_again.is_empty(), "hook 事件未变化时不应重复上报");
    }

    #[test]
    fn refresh_hooks_for_unknown_session_is_silently_ignored() {
        // hook 事件先于任何转录文件被观察到——不应 panic，也不应报告一个不存在的线程键。
        let tmp = tempfile::tempdir().unwrap();
        let hook_path = tmp.path().join("hook-events.jsonl");
        std::fs::write(&hook_path, r#"{"event":"Stop","sessionId":"unknown-session","ts":1}"#.to_string() + "\n").unwrap();

        let mut state = EngineState::new(tmp.path().join("projects"), tmp.path().join("sessions"), hook_path);
        let touched = state.refresh_hooks();
        assert!(touched.is_empty());
    }

    #[test]
    fn refresh_sessions_registry_reports_changes_on_add_and_remove() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-tmp-proj");
        let path = write_transcript(
            &proj,
            "11111111-1111-1111-1111-111111111111",
            "root-u",
            "你好",
            "2026-08-20T10:00:00.000Z",
        );
        let sessions_dir = tmp.path().join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();

        let mut state = EngineState::new(tmp.path().join("projects"), sessions_dir.clone(), tmp.path().join("hook-events.jsonl"));
        let thread_key = state.refresh_transcript(&path).unwrap();
        state.seed_process_registry(); // 初始为空登记表

        std::fs::write(
            sessions_dir.join("999.json"),
            r#"{"pid":999999,"sessionId":"11111111-1111-1111-1111-111111111111"}"#,
        )
        .unwrap();
        let touched = state.refresh_sessions_registry();
        assert_eq!(touched, vec![thread_key.clone()], "新增登记应触发该线程重新判定");

        std::fs::remove_file(sessions_dir.join("999.json")).unwrap();
        let touched_after_remove = state.refresh_sessions_registry();
        assert_eq!(touched_after_remove, vec![thread_key], "进程登记消失也应触发重新判定");
    }

    // ------------------------------------------------------------------
    // 端到端：真的起一个 notify 监听器指向临时目录，写文件，断言变化被观察到并
    // 触发去抖后的一次回调——覆盖"debounce coalescing"在真实监听链路里的行为，
    // 不只是纯函数层面。用较宽松的超时容忍 FSEvents 的调度延迟。
    // ------------------------------------------------------------------

    #[test]
    fn real_watcher_observes_rapid_writes_as_a_single_coalesced_batch() {
        let tmp = tempfile::tempdir().unwrap();
        let watch_dir = tmp.path().join("watched");
        std::fs::create_dir_all(&watch_dir).unwrap();
        // 与生产代码（`canonical_or`）同样的道理：macOS 上系统临时目录经由 `/var` ->
        // `/private/var` 的符号链接，FSEvents 报告的是已解析的真实路径；不这样处理，
        // 下面 `p == &target` 的比较会因为两边路径字符串不同而永远不成立，与真实的
        // 文件系统变化是否发生无关，纯粹是测试自身路径规范化没跟上。
        let watch_dir = watch_dir.canonicalize().unwrap();
        let target = watch_dir.join("probe.txt");
        std::fs::write(&target, "0").unwrap();

        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .expect("创建监听器应成功");
        watcher.watch(&watch_dir, RecursiveMode::NonRecursive).expect("监听临时目录应成功");

        let mut debouncer: Debouncer<PathBuf> = Debouncer::new(DEBOUNCE_MS);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut fired = 0usize;

        // 模拟"高频输出"：短时间内连续写好几次，同一个文件路径的事件应该被去抖
        // 合并，而不是每次写入都触发一次刷新。
        for i in 1..=5 {
            std::fs::write(&target, i.to_string()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(15));
        }

        while std::time::Instant::now() < deadline {
            if let Ok(Ok(event)) = rx.recv_timeout(std::time::Duration::from_millis(50)) {
                let now = now_ms() as u64;
                for p in &event.paths {
                    if p == &target {
                        debouncer.record_event(p.clone(), now);
                    }
                }
            }
            let ready = debouncer.poll_ready(now_ms() as u64);
            fired += ready.len();
            if fired > 0 {
                // 再多等一小段时间，确认没有迟到的第二次触发（真正证明"合并为一次"）。
                std::thread::sleep(std::time::Duration::from_millis(300));
                let late = debouncer.poll_ready(now_ms() as u64);
                assert!(late.is_empty(), "去抖窗口内的连续写入不应触发第二次");
                break;
            }
        }

        assert_eq!(fired, 1, "连续写入应合并为恰好一次触发（实际: {fired}）");
    }
}
