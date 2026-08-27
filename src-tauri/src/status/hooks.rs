//! hook 事件文件（spec §5）：`~/Library/Application Support/aTerm/hook-events.jsonl`。
//!
//! 每行 `{"event":"Notification"|"Stop","sessionId":"...","ts":<毫秒>}`，由（另一个任务
//! 负责安装的）hook 命令追加写入，不依赖 aTerm 是否在运行。本模块只负责**读**与**轮转**：
//! - 读取时逐行防御式解析，畸形行直接跳过，不 panic
//! - 只保留每个 sessionId 的最后一条事件（按文件行序，后出现者覆盖先出现者）
//! - 文件超过 1MB 时轮转：截断只保留最后 200 行——状态判定只关心"每个会话的最后一条
//!   事件"，历史无价值（spec §5）。这个文件位于 aTerm 自有数据目录，不在 `~/.claude/`
//!   之内，轮转时的写入不违反"`~/.claude/` 全程只读"的约束。

use super::engine::{HookEventKind, HookSignal};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

const ROTATE_THRESHOLD_BYTES: u64 = 1024 * 1024;
const ROTATE_KEEP_LINES: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct HookEvent {
    pub session_id: String,
    pub signal: HookSignal,
}

#[derive(Deserialize)]
struct RawHookEvent {
    event: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    ts: i64,
}

fn parse_event_kind(raw: &str) -> Option<HookEventKind> {
    match raw {
        "Notification" => Some(HookEventKind::Notification),
        "Stop" => Some(HookEventKind::Stop),
        _ => None, // 未知事件类型：跳过，不当作信号处理（防未来新增事件类型误判）
    }
}

/// 从原始文本按行解析，跳过任何解析失败或事件类型未知的行；同一 sessionId
/// 出现多次时，文件序更靠后的一条覆盖更靠前的一条（"最后一条事件"）。
///
/// 拆成 `&str` 输入的纯函数版本，方便测试不依赖真实文件；`read_last_events_per_session`
/// 是读文件的薄封装。
pub fn parse_last_events_per_session(content: &str) -> HashMap<String, HookEvent> {
    let mut last: HashMap<String, HookEvent> = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(raw) = serde_json::from_str::<RawHookEvent>(line) else {
            continue; // 畸形行：跳过，不 panic
        };
        let Some(kind) = parse_event_kind(&raw.event) else {
            continue;
        };
        last.insert(
            raw.session_id.clone(),
            HookEvent { session_id: raw.session_id, signal: HookSignal { kind, ts_ms: raw.ts } },
        );
    }
    last
}

/// 读取 hook 事件文件并返回每个 sessionId 的最后一条事件。文件不存在（尚未安装
/// hooks，或从未触发过）时返回空表，不是错误——调用方按"没有 hook 信号"处理。
pub fn read_last_events_per_session(path: &Path) -> HashMap<String, HookEvent> {
    match std::fs::read_to_string(path) {
        Ok(content) => parse_last_events_per_session(&content),
        Err(_) => HashMap::new(),
    }
}

/// spec §5 的轮转：文件超过 1MB 时截断只保留最后 200 行。文件不存在或无法读取时
/// 静默跳过（不是这个函数的职责去创建它——hook 命令负责首次追加创建）。
/// 用"写临时文件再 rename"而不是原地截断，避免并发读者（下一次 watcher 触发的读取）
/// 观察到写了一半的文件。
pub fn rotate_if_needed(path: &Path) -> std::io::Result<()> {
    let len = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return Ok(()), // 文件不存在：无需轮转
    };
    if len <= ROTATE_THRESHOLD_BYTES {
        return Ok(());
    }
    let content = std::fs::read_to_string(path)?;
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(ROTATE_KEEP_LINES);
    let mut kept = lines[start..].join("\n");
    if !kept.is_empty() {
        kept.push('\n');
    }
    let tmp_path = path.with_extension("jsonl.rotate.tmp");
    std::fs::write(&tmp_path, &kept)?;
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn event_line(event: &str, session_id: &str, ts: i64) -> String {
        format!(r#"{{"event":"{event}","sessionId":"{session_id}","ts":{ts}}}"#)
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let content = format!(
            "{}\nnot json at all\n{}\n{{\"event\":\"Notification\"}}\n",
            event_line("Notification", "s1", 100),
            event_line("Stop", "s2", 200),
        );
        let events = parse_last_events_per_session(&content);
        assert_eq!(events.len(), 2);
        assert_eq!(events["s1"].signal.kind, HookEventKind::Notification);
        assert_eq!(events["s2"].signal.kind, HookEventKind::Stop);
    }

    #[test]
    fn unknown_event_kind_is_skipped() {
        let content = event_line("SomeFutureEvent", "s1", 100);
        assert!(parse_last_events_per_session(&content).is_empty());
    }

    #[test]
    fn last_event_per_session_wins_by_file_order() {
        let content = format!(
            "{}\n{}\n{}\n",
            event_line("Notification", "s1", 100),
            event_line("Stop", "s1", 50), // 时间戳更早，但文件序更靠后——应该胜出
            event_line("Notification", "s2", 999),
        );
        let events = parse_last_events_per_session(&content);
        assert_eq!(events.len(), 2);
        assert_eq!(events["s1"].signal.kind, HookEventKind::Stop);
        assert_eq!(events["s1"].signal.ts_ms, 50);
    }

    #[test]
    fn empty_or_missing_file_yields_no_events() {
        assert!(parse_last_events_per_session("").is_empty());
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist.jsonl");
        assert!(read_last_events_per_session(&missing).is_empty());
    }

    #[test]
    fn read_from_real_file_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("hook-events.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "{}", event_line("Notification", "s1", 42)).unwrap();
        drop(f);
        let events = read_last_events_per_session(&path);
        assert_eq!(events["s1"].signal.ts_ms, 42);
    }

    #[test]
    fn rotation_leaves_small_file_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("hook-events.jsonl");
        std::fs::write(&path, format!("{}\n", event_line("Notification", "s1", 1))).unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        rotate_if_needed(&path).unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn rotation_missing_file_is_a_noop_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist.jsonl");
        assert!(rotate_if_needed(&missing).is_ok());
    }

    #[test]
    fn rotation_truncates_to_last_200_lines_and_preserves_last_events() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("hook-events.jsonl");

        // 构造一个体积超过 1MB、行数远多于 200 的文件。每行 pad 到 ~6KB，
        // 这样只需要约 200 行就能越过阈值，测试运行更快。
        let pad = "x".repeat(6000);
        let mut content = String::new();
        for i in 0..250 {
            content.push_str(&format!(
                r#"{{"event":"Notification","sessionId":"s{i}","ts":{i},"pad":"{pad}"}}"#
            ));
            content.push('\n');
        }
        std::fs::write(&path, &content).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > ROTATE_THRESHOLD_BYTES, "测试前提：文件必须超过阈值");

        rotate_if_needed(&path).unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        let line_count = after.lines().count();
        assert_eq!(line_count, ROTATE_KEEP_LINES, "轮转后应恰好保留最后 200 行");

        // 保留的必须是文件序最后 200 行（s50..s249），最早的 50 行（s0..s49）被丢弃。
        let events = parse_last_events_per_session(&after);
        assert_eq!(events.len(), ROTATE_KEEP_LINES);
        assert!(!events.contains_key("s0"), "轮转必须丢弃最旧的行");
        assert!(events.contains_key("s249"), "轮转必须保留最新的行");
        assert!(events.contains_key("s50"), "边界：倒数第 200 行应被保留");
        assert!(!events.contains_key("s49"), "边界：倒数第 201 行应被丢弃");
    }
}
