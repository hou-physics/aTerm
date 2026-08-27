//! 状态引擎（P2b）：让 aTerm 实时知道每个会话此刻在干什么。
//! 权威设计见 docs/superpowers/specs/2026-08-27-status-engine-design.md。
//!
//! 模块划分：
//! - `engine`：spec §4 五条状态判定规则的纯函数实现（可穷举测试的核心）
//! - `hooks`：hook 事件文件（spec §5）的解析与轮转
//! - `watcher`：文件监听 + 去抖 + 内存态注册表，把上面两者与进程存活探测串起来，
//!   并把变化过的状态发到前端

pub mod engine;
pub mod hooks;
pub mod watcher;

use engine::Status;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// `session-status` 事件与 `get_session_statuses()` 命令共用的负载形状。
///
/// **身份键**：沿用 `sessions::scan.rs` 已经建立的 `dirName`（`~/.claude/projects` 下的
/// 项目目录名，即 `ProjectInfo.dirName`）+ `rootKey`（链键：链上第一条用户消息的
/// uuid，缺失时退回该文件自身的 session id，即 `ThreadInfo.rootKey`）——与前端已经在
/// 用的 `list_projects()` 返回结构完全同一套语义、同一份取值，不需要额外的映射表，
/// 前端 store 用 `(dirName, rootKey)`（或它们拼接成的字符串）作为 key 去匹配某个
/// `ThreadInfo` 即可。
///
/// `sessionId` 是该线程当前"活跃"（时间戳最新，或最后一次被增量刷新过）的那个转录
/// 文件的 session id——与 `ThreadInfo.resumeSessionId` 是同一个概念、通常同一个值
/// （细微差别：`resumeSessionId` 由 `list_projects()` 在调用瞬间重新排序算出，这里是
/// 状态引擎增量维护的结果；两者应当总是一致，若观察到不一致，说明某处的"最新文件"
/// 判定逻辑出现了分歧，需要排查）。
///
/// `lastActivityMs` 是该 session 最后一次转录追加的时间戳（毫秒，Unix epoch）；
/// `updatedAtMs` 是这条 payload 被状态引擎计算出来的时刻（毫秒）——两者用途不同，
/// 不要混用：前者反映"内容"，后者反映"这次判定是什么时候做的"，前端如果要展示
/// "更新于 x 秒前"应该用 `updatedAtMs`。
///
/// **数组、非单条**：`session-status` 事件的负载是 `Vec<SessionStatusPayload>`（本次
/// 去抖批次里所有"状态确实变化了"的会话，可能是 1 条也可能是多条——例如 hook 事件
/// 文件一次性带来多个 session 的新事件时），不是单个对象。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusPayload {
    pub dir_name: String,
    pub root_key: String,
    pub session_id: String,
    pub status: Status,
    pub last_activity_ms: i64,
    pub updated_at_ms: i64,
}

/// 当前已知的会话状态快照，作为 Tauri 管理状态存在，供 `get_session_statuses()`
/// 命令与后台监听线程共同访问（写入方只有监听线程，读取方是命令处理器；
/// `pty.rs` 里 `PtyManager` 是同一种"内部 `Mutex` 包一层、`.manage()` 交给 Tauri"
/// 的写法，这里沿用同一习惯）。key 是 `"{dirName}::{rootKey}"`。
#[derive(Default)]
pub struct StatusStore(pub Mutex<HashMap<String, SessionStatusPayload>>);

/// 启动状态引擎：注册管理状态、起文件监听 + 后台刷新线程。在 `lib.rs` 的
/// `.setup()` 里调用一次；返回的 `WatcherGuard` 必须交给 `.manage()` 存起来——它内部
/// 持有 `notify` 的监听器句柄，一旦被 drop 监听就会停止，必须活到应用退出。
pub fn start(app: &AppHandle) -> watcher::WatcherGuard {
    app.manage(StatusStore::default());
    watcher::start(app.clone())
}

/// 返回当前的状态快照，供前端启动时直接拉取一次，不必等待第一条 `session-status`
/// 事件——初始扫描在后台线程异步完成，命令被调用的瞬间快照可能还是空的或不完整，
/// 这是预期行为：初始扫描本身不发事件（见 `watcher::run_loop` 里的说明），随后台
/// 扫描推进 store 会被逐步填满；前端可以在收到第一条 `session-status` 事件后视为
/// "增量更新已经开始"，但不应假设 `get_session_statuses()` 在应用刚启动的一瞬间就
/// 是完整的。
#[tauri::command]
pub fn get_session_statuses(store: State<StatusStore>) -> Vec<SessionStatusPayload> {
    match store.0.lock() {
        Ok(guard) => guard.values().cloned().collect(),
        Err(poisoned) => poisoned.into_inner().values().cloned().collect(),
    }
}
