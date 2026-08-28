use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Default, PartialEq)]
pub struct ParsedMeta {
    pub first_user_uuid: Option<String>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub last_ts_ms: Option<i64>,
    pub model: Option<String>,
    pub context_tokens: Option<u64>,
    pub preview: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
}

const PREVIEW_MAX_CHARS: usize = 80;
/// 合成记录的模型占位符，不是真实模型名。
const SYNTHETIC_MODEL: &str = "<synthetic>";

/// 从一条 assistant 记录的 usage 中求出该轮送入模型的上下文总量。
/// 只累加“入向”三项：output_tokens 是产出，不占用下一轮上下文预算。
fn context_tokens_of(usage: &serde_json::Value) -> Option<u64> {
    let g = |k: &str| usage.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    let total = g("input_tokens") + g("cache_creation_input_tokens") + g("cache_read_input_tokens");
    (total > 0).then_some(total)
}

/// 取 content 数组里第一个文本块，折叠空白并按字符（非字节）截断。
fn preview_of(content: &serde_json::Value) -> Option<String> {
    let text = content.as_array()?.iter().find_map(|b| {
        (b.get("type")?.as_str()? == "text").then(|| b.get("text")?.as_str()).flatten()
    })?;
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() { return None; }
    Some(collapsed.chars().take(PREVIEW_MAX_CHARS).collect())
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

/// 是否为注入文本（斜杠命令回显、系统提醒等）而非真实用户输入。
/// `pub(super)`：供 `sessions::conversation` 复用同一条规则，避免第二处实现漂移。
pub(super) fn is_injected(text: &str) -> bool {
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

    let parsed_tail: Vec<Value> = tail
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect();

    // title 优先级①：头部 + 尾部窗口内所有 type=="ai-title" 记录中，文件序最靠后
    // （最新）的一条胜出——本版本 Claude Code 会随对话推进反复重写 aiTitle（一份
    // 文件里可能有几十条），只有最后一条才是当前标题；空白标题一律跳过。
    for v in parsed_head.iter().chain(parsed_tail.iter()) {
        if v.get("type").and_then(|t| t.as_str()) == Some("ai-title") {
            if let Some(ai_title) = as_str(v, "aiTitle") {
                if !ai_title.trim().is_empty() {
                    m.title = Some(truncate_chars(ai_title.trim(), 60));
                }
            }
        }
    }

    // title 优先级②：未命中 ai-title 时，退回旧版本 Claude Code 的 type=="summary"
    // 记录（头部 + 尾部窗口，文件序最靠后者胜出）；空白摘要一律跳过。
    if m.title.is_none() {
        for v in parsed_head.iter().chain(parsed_tail.iter()) {
            if v.get("type").and_then(|t| t.as_str()) == Some("summary") {
                if let Some(summary) = as_str(v, "summary") {
                    if !summary.trim().is_empty() {
                        m.title = Some(truncate_chars(summary.trim(), 60));
                    }
                }
            }
        }
    }

    // title 优先级③：仍未命中时，回退到第一条非注入的真实用户消息文本。
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

    // model / context_tokens / preview / effort / permission_mode：倒序遍历尾部窗口，
    // 每个字段“第一个命中即定、已定则不再覆盖”，保证反映最新一条记录。
    for v in parsed_tail.iter().rev() {
        if m.effort.is_none() {
            m.effort = v.get("effort").and_then(|x| x.as_str()).map(str::to_string);
        }
        if m.permission_mode.is_none() {
            m.permission_mode = v.get("permissionMode").and_then(|x| x.as_str()).map(str::to_string);
        }
        if v.get("type").and_then(|t| t.as_str()) == Some("assistant") {
            if let Some(msg) = v.get("message") {
                let model = msg.get("model").and_then(|m| m.as_str());
                if model != Some(SYNTHETIC_MODEL) {
                    if m.model.is_none() {
                        m.model = model.map(str::to_string);
                    }
                    if m.context_tokens.is_none() {
                        m.context_tokens = msg.get("usage").and_then(context_tokens_of);
                    }
                    if m.preview.is_none() {
                        m.preview = msg.get("content").and_then(preview_of);
                    }
                }
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

    #[test]
    fn ai_title_wins_over_summary_and_user_message() {
        let head = vec![
            line_user("u1", "先写的用户消息", "2026-08-20T10:00:00.000Z"),
            r#"{"type":"summary","summary":"总结","leafUuid":"x"}"#.to_string(),
        ];
        let tail = vec![
            r#"{"type":"ai-title","aiTitle":"AI 标题","sessionId":"s"}"#.to_string(),
        ];
        let m = parse_meta(&head, &tail);
        assert_eq!(m.title.as_deref(), Some("AI 标题"));
    }

    #[test]
    fn last_ai_title_wins() {
        let head = vec![
            r#"{"type":"ai-title","aiTitle":"旧标题","sessionId":"s"}"#.to_string(),
        ];
        let tail = vec![
            r#"{"type":"ai-title","aiTitle":"新标题","sessionId":"s"}"#.to_string(),
        ];
        let m = parse_meta(&head, &tail);
        assert_eq!(m.title.as_deref(), Some("新标题"));
    }

    #[test]
    fn empty_ai_title_falls_through_to_summary() {
        let head = vec![
            r#"{"type":"ai-title","aiTitle":"  ","sessionId":"s"}"#.to_string(),
            r#"{"type":"summary","summary":"总结","leafUuid":"x"}"#.to_string(),
        ];
        let m = parse_meta(&head, &[]);
        assert_eq!(m.title.as_deref(), Some("总结"));
    }

    fn assistant_line(model: &str, input: u64, cache_c: u64, cache_r: u64, text: &str) -> String {
        format!(
            r#"{{"type":"assistant","effort":"xhigh","permissionMode":"acceptEdits","message":{{"role":"assistant","model":"{model}","content":[{{"type":"text","text":"{text}"}}],"usage":{{"input_tokens":{input},"cache_creation_input_tokens":{cache_c},"cache_read_input_tokens":{cache_r},"output_tokens":9}}}}}}"#
        )
    }

    #[test]
    fn extracts_model_context_and_preview_from_last_assistant() {
        let tail = vec![
            assistant_line("claude-fable-5", 1, 10, 20, "早先的回答"),
            assistant_line("claude-opus-5", 2, 13844, 26369, "正在核查解析器字段"),
        ];
        let meta = parse_meta(&[], &tail);
        assert_eq!(meta.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(meta.context_tokens, Some(2 + 13844 + 26369));
        assert_eq!(meta.preview.as_deref(), Some("正在核查解析器字段"));
        assert_eq!(meta.effort.as_deref(), Some("xhigh"));
        assert_eq!(meta.permission_mode.as_deref(), Some("acceptEdits"));
    }

    #[test]
    fn synthetic_model_is_skipped() {
        let tail = vec![
            assistant_line("claude-opus-5", 1, 2, 3, "真实回答"),
            assistant_line("<synthetic>", 0, 0, 0, "合成记录"),
        ];
        let meta = parse_meta(&[], &tail);
        assert_eq!(meta.model.as_deref(), Some("claude-opus-5"), "<synthetic> 不是模型名");
        assert_eq!(meta.preview.as_deref(), Some("真实回答"));
    }

    #[test]
    fn preview_collapses_whitespace_and_truncates() {
        let long = "啊".repeat(200);
        let tail = vec![assistant_line("claude-opus-5", 1, 1, 1, &format!("行一\\n\\n   行二 {long}"))];
        let meta = parse_meta(&[], &tail);
        let p = meta.preview.unwrap();
        assert!(p.starts_with("行一 行二"), "换行与连续空白应折叠为单个空格，实际: {p}");
        assert!(p.chars().count() <= 80, "应截断到 80 字符，实际 {} 字符", p.chars().count());
    }

    #[test]
    fn missing_fields_stay_none() {
        let tail = vec![r#"{"type":"user","message":{"role":"user","content":"你好"}}"#.to_string()];
        let meta = parse_meta(&[], &tail);
        assert_eq!(meta.model, None);
        assert_eq!(meta.context_tokens, None);
        assert_eq!(meta.preview, None);
    }
}
