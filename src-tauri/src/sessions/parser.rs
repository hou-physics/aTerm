use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Default, PartialEq)]
pub struct ParsedMeta {
    pub first_user_uuid: Option<String>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub last_ts_ms: Option<i64>,
}

fn as_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn user_text(v: &Value) -> Option<String> {
    let msg = v.get("message")?;
    if msg.get("role")?.as_str()? != "user" { return None; }
    let content = msg.get("content")?;
    if let Some(s) = content.as_str() { return Some(s.to_string()); }
    content.as_array()?.iter()
        .find(|item| item.get("type").and_then(|t| t.as_str()) == Some("text"))
        .and_then(|item| item.get("text")).and_then(|t| t.as_str()).map(|s| s.to_string())
}

fn is_injected(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with('<') || t.starts_with("Caveat:")
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

pub fn parse_meta(head: &[String], tail: &[String]) -> ParsedMeta {
    let mut m = ParsedMeta::default();
    for line in head {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if m.cwd.is_none() { m.cwd = as_str(&v, "cwd"); }
        if m.title.is_none() && v.get("type").and_then(|t| t.as_str()) == Some("summary") {
            m.title = as_str(&v, "summary");
        }
        let sidechain = v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false);
        if !sidechain {
            if let Some(text) = user_text(&v) {
                if m.first_user_uuid.is_none() { m.first_user_uuid = as_str(&v, "uuid"); }
                if m.title.is_none() && !is_injected(&text) {
                    let first_line = text.lines().next().unwrap_or("").trim();
                    if !first_line.is_empty() { m.title = Some(truncate_chars(first_line, 60)); }
                }
            }
        }
    }
    for line in tail {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(ts) = as_str(&v, "timestamp") {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&ts) {
                m.last_ts_ms = Some(dt.timestamp_millis());
            }
        }
    }
    m
}

pub fn read_head_lines(path: &Path, max_lines: usize, max_bytes: usize) -> std::io::Result<Vec<String>> {
    let f = std::fs::File::open(path)?;
    let limited = BufReader::new(f).take(max_bytes as u64);
    Ok(limited.lines().map_while(Result::ok).take(max_lines).collect())
}

pub fn read_tail_lines(path: &Path, max_bytes: u64) -> std::io::Result<Vec<String>> {
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok(); // 非 UTF-8 边界容忍：失败则返回空
    let mut lines: Vec<String> = buf.lines().map(|s| s.to_string()).collect();
    if start > 0 && !lines.is_empty() { lines.remove(0); } // 丢弃被截断的首行
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn line_user(uuid: &str, text: &str, ts: &str) -> String {
        format!(r#"{{"parentUuid":null,"isSidechain":false,"cwd":"/tmp/fake-proj","sessionId":"s","timestamp":"{ts}","type":"user","message":{{"role":"user","content":"{text}"}},"uuid":"{uuid}"}}"#)
    }

    #[test]
    fn title_prefers_summary_entry() {
        let head = vec![
            r#"{"type":"summary","summary":"修复登录","leafUuid":"x"}"#.to_string(),
            line_user("u1", "帮我修复登录 bug", "2026-08-20T10:00:00.000Z"),
        ];
        let m = parse_meta(&head, &[]);
        assert_eq!(m.title.as_deref(), Some("修复登录"));
        assert_eq!(m.first_user_uuid.as_deref(), Some("u1"));
        assert_eq!(m.cwd.as_deref(), Some("/tmp/fake-proj"));
    }

    #[test]
    fn title_falls_back_to_first_user_message_skipping_injected() {
        let head = vec![
            r#"{"type":"mode","mode":"normal","sessionId":"s"}"#.to_string(),
            line_user("u0", "<command-name>/clear</command-name>", "2026-08-20T09:00:00.000Z"),
            line_user("u1", "写一个贪吃蛇", "2026-08-20T10:00:00.000Z"),
        ];
        let m = parse_meta(&head, &[]);
        assert_eq!(m.title.as_deref(), Some("写一个贪吃蛇"));
        // 链键仍是第一条真实用户消息（含被跳过标题的那条）
        assert_eq!(m.first_user_uuid.as_deref(), Some("u0"));
    }

    #[test]
    fn last_ts_from_tail_and_garbage_tolerated() {
        let tail = vec![
            "not-json-at-all".to_string(),
            r#"{"type":"assistant","uuid":"u9","timestamp":"2026-08-21T08:30:00.000Z","message":{"role":"assistant","model":"claude-opus-5"}}"#.to_string(),
        ];
        let m = parse_meta(&[], &tail);
        let expected = chrono::DateTime::parse_from_rfc3339("2026-08-21T08:30:00.000Z").unwrap().timestamp_millis();
        assert_eq!(m.last_ts_ms, Some(expected));
        assert!(m.title.is_none());
    }

    #[test]
    fn head_and_tail_file_reads_are_bounded() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for i in 0..100 { writeln!(f, r#"{{"n":{i}}}"#).unwrap(); }
        let head = read_head_lines(f.path(), 5, 1024).unwrap();
        assert_eq!(head.len(), 5);
        assert!(head[0].contains(r#""n":0"#));
        let tail = read_tail_lines(f.path(), 40).unwrap(); // 40 字节必然截断出部分行
        assert!(tail.iter().all(|l| l.starts_with('{')), "首个不完整行必须被丢弃: {tail:?}");
        assert!(tail.last().unwrap().contains("99"));
    }
}
