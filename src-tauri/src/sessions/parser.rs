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

/// 是否是一条 role=="user" 的消息记录——不要求 content 能提取出文本。
/// first_user_uuid（链键）只依赖这一条件，必须与 user_text() 能否成功解耦，
/// 否则纯 tool_result 数组内容的用户消息会被跳过，链键错位到更晚的消息。
fn is_user_message(v: &Value) -> bool {
    v.get("message")
        .and_then(|msg| msg.get("role"))
        .and_then(|r| r.as_str())
        == Some("user")
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

    // 防御式解析：逐行尝试 JSON 解析，失败的行直接跳过，绝不 panic。
    let parsed_head: Vec<Value> = head
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect();

    // cwd：头部任意记录中首个出现者
    for v in &parsed_head {
        if let Some(cwd) = as_str(v, "cwd") {
            m.cwd = Some(cwd);
            break;
        }
    }

    // first_user_uuid（链键）：头部第一条 role=="user" 且 isSidechain != true 的记录的
    // uuid，与该记录的 content 是否能提取出文本无关（见 is_user_message 注释）。
    for v in &parsed_head {
        let sidechain = v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false);
        if !sidechain && is_user_message(v) {
            m.first_user_uuid = as_str(v, "uuid");
            break;
        }
    }

    // title 优先级①：头部 + 尾部窗口内所有 type=="summary" 记录中，文件序最靠后
    // （最新）的一条胜出——摘要通常在文件中段/尾部追加（如 compaction 时），仅扫
    // 头部会错过大多数会话的 AI 摘要；空白摘要一律跳过，不允许其锁定为空标题。
    let parsed_tail: Vec<Value> = tail
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect();
    for v in parsed_head.iter().chain(parsed_tail.iter()) {
        if v.get("type").and_then(|t| t.as_str()) == Some("summary") {
            if let Some(summary) = as_str(v, "summary") {
                if !summary.trim().is_empty() {
                    m.title = Some(summary);
                }
            }
        }
    }

    // title 优先级②：仍未命中 summary 时，回退到第一条非注入的真实用户消息文本。
    if m.title.is_none() {
        for v in &parsed_head {
            let sidechain = v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false);
            if sidechain || !is_user_message(v) { continue; }
            let Some(text) = user_text(v) else { continue };
            if is_injected(&text) { continue; }
            let first_line = text.lines().next().unwrap_or("").trim();
            if !first_line.is_empty() {
                m.title = Some(truncate_chars(first_line, 60));
                break;
            }
        }
    }

    for v in &parsed_tail {
        if let Some(ts) = as_str(v, "timestamp") {
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
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    if start > 0 {
        // start 是原始字节偏移，可能落在多字节 UTF-8 字符内部。'\n' (0x0A) 在合法
        // UTF-8 中绝不会出现在多字节序列内部，因此以第一个换行符为界重新定位切点，
        // 保证后续转换必然落在字符边界上——绝不能像 read_to_string 那样，一旦起点
        // 非法就把整段尾部数据（包括后面本来完整合法的行）一起丢弃。
        buf = match buf.iter().position(|&b| b == b'\n') {
            Some(i) => buf[i + 1..].to_vec(),
            None => Vec::new(), // 窗口内没有完整行可用
        };
    }
    let text = String::from_utf8_lossy(&buf);
    Ok(text.lines().map(|s| s.to_string()).collect())
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

    #[test]
    fn tail_read_survives_mid_char_byte_cut() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for i in 0..5 {
            writeln!(f, r#"{{"t":"中文中文","n":{i}}}"#).unwrap();
        }
        let bytes = std::fs::read(f.path()).unwrap();
        // UTF-8 续字节 (0x80..=0xBF) 只可能出现在多字节字符内部；以它作为窗口起点，
        // 确保截断点必然落在汉字中间（非法字符边界）。
        let mid_char_offset = bytes.iter().position(|&b| (0x80..=0xBF).contains(&b)).unwrap();
        let max_bytes = bytes.len() as u64 - mid_char_offset as u64;
        let tail = read_tail_lines(f.path(), max_bytes).unwrap();
        assert!(!tail.is_empty(), "多字节字符边界切割不应导致整段尾部数据丢失");
        assert!(tail.iter().all(|l| l.starts_with('{')));
        assert!(tail.last().unwrap().contains("\"n\":4"));
    }

    #[test]
    fn chain_key_captured_even_when_content_is_not_extractable_text() {
        let head = vec![
            r#"{"isSidechain":false,"cwd":"/tmp/fake-proj","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]},"uuid":"u0"}"#.to_string(),
            line_user("u1", "写一个贪吃蛇", "2026-08-20T10:00:00.000Z"),
        ];
        let m = parse_meta(&head, &[]);
        assert_eq!(m.first_user_uuid.as_deref(), Some("u0"));
        assert_eq!(m.title.as_deref(), Some("写一个贪吃蛇"));
    }

    #[test]
    fn summary_wins_even_when_it_appears_after_a_user_message() {
        let head = vec![
            line_user("u1", "先写的用户消息", "2026-08-20T10:00:00.000Z"),
            r#"{"type":"summary","summary":"后到的摘要","leafUuid":"x"}"#.to_string(),
        ];
        let m = parse_meta(&head, &[]);
        assert_eq!(m.title.as_deref(), Some("后到的摘要"));
        assert_eq!(m.first_user_uuid.as_deref(), Some("u1"));
    }

    #[test]
    fn summary_in_tail_wins_over_head_user_message() {
        let head = vec![
            line_user("u1", "写一个贪吃蛇", "2026-08-20T10:00:00.000Z"),
        ];
        let tail = vec![
            r#"{"type":"assistant","uuid":"u9","timestamp":"2026-08-21T08:30:00.000Z","message":{"role":"assistant","model":"claude-opus-5"}}"#.to_string(),
            r#"{"type":"summary","summary":"尾部总结","leafUuid":"x"}"#.to_string(),
        ];
        let m = parse_meta(&head, &tail);
        assert_eq!(m.title.as_deref(), Some("尾部总结"));
        assert_eq!(m.first_user_uuid.as_deref(), Some("u1"));
    }

    #[test]
    fn last_summary_wins_when_multiple() {
        let head = vec![
            r#"{"type":"summary","summary":"旧总结","leafUuid":"x"}"#.to_string(),
        ];
        let tail = vec![
            r#"{"type":"assistant","uuid":"u9","timestamp":"2026-08-21T08:30:00.000Z","message":{"role":"assistant","model":"claude-opus-5"}}"#.to_string(),
            r#"{"type":"summary","summary":"新总结","leafUuid":"y"}"#.to_string(),
        ];
        let m = parse_meta(&head, &tail);
        assert_eq!(m.title.as_deref(), Some("新总结"));
    }

    #[test]
    fn empty_summary_is_skipped() {
        let head = vec![
            r#"{"type":"summary","summary":"  "}"#.to_string(),
            line_user("u1", "写贪吃蛇", "2026-08-20T10:00:00.000Z"),
        ];
        let m = parse_meta(&head, &[]);
        assert_eq!(m.title.as_deref(), Some("写贪吃蛇"));
    }
}
