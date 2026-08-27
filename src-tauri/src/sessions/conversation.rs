//! 对话正文解析：从会话链的 jsonl 文件中抽取用户轮次与 Claude 回答文字，
//! 供对话面板阅读——不解析、不呈现工具调用（`tool_use`/`tool_result`）。
//! 规则详见 docs/superpowers/specs/2026-08-27-conversation-panel-design.md §4。

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub role: String,
    pub text: String,
    pub ts_ms: i64,
    pub uuid: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub turns: Vec<Turn>,
    pub files: Vec<String>,
    pub total_bytes: u64,
}

// ---- 测试专用：磁盘读取次数计数（按路径），用于证明缓存命中确实不再触碰磁盘。
// 仅在测试构建中存在，不影响生产二进制；调用点用 #[cfg(test)] 语句属性包裹。

#[cfg(test)]
fn disk_read_counter() -> &'static Mutex<HashMap<PathBuf, usize>> {
    static COUNTER: OnceLock<Mutex<HashMap<PathBuf, usize>>> = OnceLock::new();
    COUNTER.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn record_disk_read(path: &Path) {
    *disk_read_counter().lock().unwrap().entry(path.to_path_buf()).or_insert(0) += 1;
}

#[cfg(test)]
fn disk_read_count(path: &Path) -> usize {
    *disk_read_counter().lock().unwrap().get(path).unwrap_or(&0)
}

/// 逐行解析：先做字节扫描筛选（不做 JSON 解析即可跳过绝大多数行），
/// 剩余候选行才解析 JSON 并抽取正文。规则顺序即 spec §4 的优化顺序。
fn parse_line(line: &str) -> Option<Turn> {
    // 规则 1：工具结果所在的行，体积主体，先于 JSON 解析跳过。
    if line.contains("\"tool_result\"") {
        return None;
    }
    // 规则 2：非 user/assistant 类型的行跳过。
    //
    // 刻意不按 "tool_use" 过滤整行——该串会与正文内容碰撞：任何正文里提到
    // tool_use 的消息都会被误杀。实测最大会话中，按 tool_use 过滤会静默丢失
    // 24k 字符（约 5%）真实正文。tool_use 项只在下面提取数组内容时被忽略，
    // 绝不能因为它的存在而丢弃整条记录。勿在此"优化"回去。
    if !line.contains("\"type\":\"user\"") && !line.contains("\"type\":\"assistant\"") {
        return None;
    }
    // 规则 3（同一顺序精神的延伸，spec §4 未明文列出、为达成 §5 冷读 <50ms
    // 预算而追加）：content 是数组形态、但连 "type":"text" 子串都不含时，说明
    // 这是一条纯工具调用记录——tool_use 项常携带体积不小的 input 负载
    // （如整份文件内容），既然它必然提取不出任何正文，不必为它整行做 JSON 解析。
    // content 为普通字符串（"content":"..."）时该子串天然不存在，不受此规则影响，
    // 照常往下解析；子串一旦真实出现在其他字段里（极小概率），只是多解析一次，
    // 不会造成漏判——真正的判定仍由下面的类型化提取完成。
    //
    // 这条规则依赖的假设是硬性的、必须写清楚：转录文件是**紧凑、不含空白的**
    // JSON 序列化（`serde_json` 默认输出），使得只要数组里存在一个文本块，
    // `"type":"text"` 这个子串就**逐字节**出现在该行里——不论键的先后顺序。
    // 若这份转录 JSON 的序列化方式将来发生变化（例如带上了空白/换行做美化输出，
    // 或者字段名/取值被重新拼接导致这个子串不再逐字符出现），这条假设就不成立，
    // 而此规则会在假阳性之外产生真正的假阴性——静默丢弃真实正文。届时**必须整条
    // 删除这条规则**，而不是打补丁（例如加更多子串变体）——保持规则的形状简单、
    // 可推理，比多留一层子串匹配更重要。删除后仍能通过下面的类型化 JSON 解析正确
    // 工作，只是慢回 spec §5 记录的 ~13ms，不影响正确性。见下方
    // `content_array_with_text_block_not_skipped_by_byte_heuristic` 测试，它把
    // "含文本块的数组不会被此规则误杀"这一契约钉死为回归测试。
    if line.contains("\"content\":[") && !line.contains("\"type\":\"text\"") {
        return None;
    }

    let v: Value = serde_json::from_str(line).ok()?; // 畸形行：跳过，不 panic

    if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false) {
        return None; // 子代理对话不属于主线
    }

    let msg = v.get("message");

    // role：优先取 message.role；缺失时退回记录顶层 type 字段。
    let role = msg
        .and_then(|m| m.get("role"))
        .and_then(|r| r.as_str())
        .map(|s| s.to_string())
        .or_else(|| v.get("type").and_then(|t| t.as_str()).map(|s| s.to_string()))?;

    // content：字符串直接取用；数组则拼接其中全部 type=="text" 项（tool_use 项忽略）。
    let content = msg.and_then(|m| m.get("content"))?;
    let text = if let Some(s) = content.as_str() {
        s.to_string()
    } else if let Some(arr) = content.as_array() {
        let parts: Vec<&str> = arr
            .iter()
            .filter(|item| item.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
            .collect();
        parts.join("\n")
    } else {
        return None;
    };

    if super::parser::is_injected(&text) {
        return None; // 注入文本（斜杠命令回显等），沿用 parser.rs 既有规则
    }
    if text.trim().is_empty() {
        return None; // trim 后为空的轮次丢弃
    }

    let uuid = v.get("uuid").and_then(|u| u.as_str()).unwrap_or("").to_string();
    let ts_ms = v
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0);

    Some(Turn { role, text, ts_ms, uuid })
}

/// 按 `\n` 切分为行并逐行解析；末尾若有不完整的行（无换行符，通常是运行中
/// 会话写到一半），原样返回其字节，供下次增量续接，不当作已处理丢弃。
///
/// 整块先做一次 UTF-8 校验、再用 `str::split('\n')` 切行（标准库内部走加速路径），
/// 而不是手写逐字节循环——同一份 67MB 级真实会话文件上实测后者明显更慢
/// （手写逐字节循环 ~53ms，此写法 ~30ms），是 §5 冷读预算能否达标的关键一环。
fn scan_lines(data: &[u8]) -> (Vec<Turn>, Vec<u8>) {
    match std::str::from_utf8(data) {
        Ok(text) => {
            let ends_with_nl = data.last() == Some(&b'\n');
            let mut split = text.split('\n');
            // 不以换行符结尾时，末段是尚未写完的半行，摘出来当 pending，不参与解析。
            let pending_str = if ends_with_nl { None } else { split.next_back() };
            let mut turns = Vec::new();
            for line in split {
                if let Some(t) = parse_line(line) {
                    turns.push(t);
                }
            }
            let pending = pending_str.map(|s| s.as_bytes().to_vec()).unwrap_or_default();
            (turns, pending)
        }
        // 整块不是合法 UTF-8：理论上不应发生（jsonl 逐行都是合法 UTF-8），
        // 但仍需防御——退回逐字节扫描，单行非法就跳过那一行，绝不 panic。
        Err(_) => scan_lines_bytewise(data),
    }
}

fn scan_lines_bytewise(data: &[u8]) -> (Vec<Turn>, Vec<u8>) {
    let mut turns = Vec::new();
    let mut line_start = 0usize;
    for (i, &b) in data.iter().enumerate() {
        if b == b'\n' {
            if let Ok(line) = std::str::from_utf8(&data[line_start..i]) {
                if let Some(t) = parse_line(line) {
                    turns.push(t);
                }
            } // 非法 UTF-8 的行：跳过，不 panic
            line_start = i + 1;
        }
    }
    (turns, data[line_start..].to_vec())
}

struct CacheEntry {
    size: u64,
    mtime_ms: i64,
    turns: Vec<Turn>,
    /// 上次读到文件末尾时，尚未凑成完整一行的尾部字节（无换行符）。
    pending: Vec<u8>,
}

type Cache = HashMap<PathBuf, CacheEntry>;

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_size_and_mtime(path: &Path) -> std::io::Result<(u64, i64)> {
    let m = std::fs::metadata(path)?;
    let mtime_ms = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok((m.len(), mtime_ms))
}

/// 解析单个 jsonl 文件的正文轮次。以 (路径, 大小, 修改时间) 判定缓存是否命中：
/// - 大小/修改时间均未变 → 直接返回缓存结果，不碰磁盘
/// - 仅大小变大（运行中的会话持续追加）→ 只读取新增字节，从上次的行边界续接
/// - 其余情况（变小/原地改写）→ 无法信任增量状态，整篇重新解析
fn parse_file_cached(path: &Path) -> std::io::Result<Vec<Turn>> {
    let (size, mtime_ms) = file_size_and_mtime(path)?;
    let mut guard = cache().lock().unwrap();

    // 先取出需要的字段的拥有型拷贝，避免在后续写回缓存时与这里的不可变借用冲突。
    let prior = guard
        .get(path)
        .map(|e| (e.size, e.mtime_ms, e.turns.clone(), e.pending.clone()));

    if let Some((prev_size, prev_mtime, prev_turns, prev_pending)) = prior {
        if prev_size == size && prev_mtime == mtime_ms {
            return Ok(prev_turns); // 缓存命中：零 IO
        }
        if size > prev_size {
            #[cfg(test)]
            record_disk_read(path);

            let mut pending = prev_pending;
            let mut turns = prev_turns;
            let mut f = File::open(path)?;
            f.seek(SeekFrom::Start(prev_size))?;
            // 预分配到已知的新增字节数，避免 Vec 倍增扩容期间的多次搬迁拷贝。
            let mut new_bytes = Vec::with_capacity((size - prev_size) as usize);
            f.read_to_end(&mut new_bytes)?;
            pending.extend_from_slice(&new_bytes);
            let (mut new_turns, new_pending) = scan_lines(&pending);
            turns.append(&mut new_turns);
            guard.insert(
                path.to_path_buf(),
                CacheEntry { size, mtime_ms, turns: turns.clone(), pending: new_pending },
            );
            return Ok(turns);
        }
        // 文件变小或原地改写：落到下面整篇重扫。
    }

    #[cfg(test)]
    record_disk_read(path);

    let mut f = File::open(path)?;
    // 预分配到已知文件大小，避免 Vec 倍增扩容期间的多次搬迁拷贝（63MB 级文件上
    // 实测这一项就能省下可观的一段耗时）。
    let mut buf = Vec::with_capacity(size as usize);
    f.read_to_end(&mut buf)?;
    let (turns, pending) = scan_lines(&buf);
    guard.insert(path.to_path_buf(), CacheEntry { size, mtime_ms, turns: turns.clone(), pending });
    Ok(turns)
}

/// `read_conversation` 的可测试内核：`projects_dir` 由调用方传入，测试可指向
/// 临时目录，无需触碰真实的 `~/.claude/projects`。
pub fn read_conversation_in(projects_dir: &Path, dir_name: &str, root_key: &str) -> Result<Conversation, String> {
    let dir = projects_dir.join(dir_name);
    if !dir.is_dir() {
        return Err(format!("找不到项目目录：{dir_name}"));
    }

    // 复用 scan.rs 既有的链分组逻辑，不另起一套。
    let mut groups = super::scan::group_chain_files(&dir);
    let Some(mut files) = groups.remove(root_key) else {
        return Err(format!("找不到会话链：{root_key}"));
    };
    // 按时间升序拼接：与 scan.rs 选取链上"最新文件"时使用的同一排序键一致。
    files.sort_by_key(|f| f.meta.last_ts_ms.unwrap_or(f.mtime_ms));

    let mut turns: Vec<Turn> = Vec::new();
    let mut file_paths: Vec<String> = Vec::new();
    let mut total_bytes: u64 = 0;

    for cf in &files {
        let parsed = parse_file_cached(&cf.path)
            .map_err(|e| format!("读取会话文件失败：{}（{e}）", cf.path.display()))?;
        turns.extend(parsed);
        total_bytes += std::fs::metadata(&cf.path).map(|m| m.len()).unwrap_or(0);
        file_paths.push(cf.path.to_string_lossy().to_string());
    }

    Ok(Conversation { turns, files: file_paths, total_bytes })
}

#[tauri::command]
pub fn read_conversation(dir_name: String, root_key: String) -> Result<Conversation, String> {
    let home = dirs::home_dir().ok_or_else(|| "找不到用户目录".to_string())?;
    let projects_dir = home.join(".claude").join("projects");
    read_conversation_in(&projects_dir, &dir_name, &root_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // ---- 测试用的行构造辅助：用 serde_json 安全转义，避免手工拼字符串时
    // 正文本身含引号/换行/"tool_use" 等敏感子串时破坏 JSON 结构。

    fn user_line(uuid: &str, content: &Value, ts: &str, sidechain: bool) -> String {
        let content = serde_json::to_string(content).unwrap();
        format!(
            r#"{{"type":"user","isSidechain":{sidechain},"uuid":"{uuid}","timestamp":"{ts}","message":{{"role":"user","content":{content}}}}}"#
        )
    }

    fn assistant_line(uuid: &str, content: &Value, ts: &str) -> String {
        let content = serde_json::to_string(content).unwrap();
        format!(
            r#"{{"type":"assistant","isSidechain":false,"uuid":"{uuid}","timestamp":"{ts}","message":{{"role":"assistant","content":{content}}}}}"#
        )
    }

    fn write_jsonl(dir: &Path, session_id: &str, lines: &[String]) -> PathBuf {
        let path = dir.join(format!("{session_id}.jsonl"));
        fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
        path
    }

    /// 建一个最小可用的两行会话文件：首条用户消息（作为链键）+ 传入的额外行。
    fn setup_chain(
        tmp: &Path,
        dir_name: &str,
        session_id: &str,
        root_uuid: &str,
        extra_lines: Vec<String>,
    ) -> (PathBuf, String) {
        let proj = tmp.join(dir_name);
        fs::create_dir_all(&proj).unwrap();
        let mut lines = vec![user_line(
            root_uuid,
            &serde_json::json!("根消息，用作链键"),
            "2026-08-20T09:00:00.000Z",
            false,
        )];
        lines.extend(extra_lines);
        let path = write_jsonl(&proj, session_id, &lines);
        (proj, path.to_string_lossy().to_string())
    }

    const SID_A: &str = "11111111-1111-1111-1111-111111111111";
    const SID_B: &str = "22222222-2222-2222-2222-222222222222";

    #[test]
    fn content_string_extracted_directly() {
        let tmp = tempfile::tempdir().unwrap();
        let (proj, _) = setup_chain(
            tmp.path(),
            "-tmp-proj-a",
            SID_A,
            "root-u",
            vec![assistant_line(
                "a1",
                &serde_json::json!("你好，我能帮你做什么"),
                "2026-08-20T09:00:05.000Z",
            )],
        );
        let out = read_conversation_in(tmp.path(), "-tmp-proj-a", "root-u").unwrap();
        let turn = out.turns.iter().find(|t| t.uuid == "a1").expect("assistant turn 应存在");
        assert_eq!(turn.role, "assistant");
        assert_eq!(turn.text, "你好，我能帮你做什么");
        let _ = proj;
    }

    #[test]
    fn content_array_multi_text_blocks_collapse_to_one_turn() {
        let tmp = tempfile::tempdir().unwrap();
        setup_chain(
            tmp.path(),
            "-tmp-proj-b",
            SID_A,
            "root-u",
            vec![assistant_line(
                "a1",
                &serde_json::json!([
                    {"type": "text", "text": "第一段"},
                    {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}},
                    {"type": "text", "text": "第二段"}
                ]),
                "2026-08-20T09:00:05.000Z",
            )],
        );
        let out = read_conversation_in(tmp.path(), "-tmp-proj-b", "root-u").unwrap();
        let a_turns: Vec<_> = out.turns.iter().filter(|t| t.uuid == "a1").collect();
        assert_eq!(a_turns.len(), 1, "一条记录最多产生一条 Turn");
        assert_eq!(a_turns[0].text, "第一段\n第二段", "多个 text 块以换行拼接");
    }

    #[test]
    fn array_with_only_tool_use_yields_no_turn() {
        let tmp = tempfile::tempdir().unwrap();
        setup_chain(
            tmp.path(),
            "-tmp-proj-c",
            SID_A,
            "root-u",
            vec![assistant_line(
                "a1",
                &serde_json::json!([
                    {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}
                ]),
                "2026-08-20T09:00:05.000Z",
            )],
        );
        let out = read_conversation_in(tmp.path(), "-tmp-proj-c", "root-u").unwrap();
        assert!(out.turns.iter().all(|t| t.uuid != "a1"), "无文本可提取时不应产生 Turn");
    }

    #[test]
    fn tool_result_line_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        setup_chain(
            tmp.path(),
            "-tmp-proj-d",
            SID_A,
            "root-u",
            vec![user_line(
                "u1",
                &serde_json::json!([{"type": "tool_result", "content": "ok"}]),
                "2026-08-20T09:00:05.000Z",
                false,
            )],
        );
        let out = read_conversation_in(tmp.path(), "-tmp-proj-d", "root-u").unwrap();
        assert!(out.turns.iter().all(|t| t.uuid != "u1"), "含 tool_result 的行必须整行跳过");
    }

    #[test]
    fn non_user_or_assistant_type_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-tmp-proj-e");
        fs::create_dir_all(&proj).unwrap();
        let lines = vec![
            user_line("root-u", &serde_json::json!("根消息"), "2026-08-20T09:00:00.000Z", false),
            r#"{"type":"system","uuid":"s1","timestamp":"2026-08-20T09:00:01.000Z","message":{"role":"system","content":"系统提示"}}"#.to_string(),
        ];
        write_jsonl(&proj, SID_A, &lines);
        let out = read_conversation_in(tmp.path(), "-tmp-proj-e", "root-u").unwrap();
        assert!(out.turns.iter().all(|t| t.uuid != "s1"), "非 user/assistant 类型必须跳过");
    }

    #[test]
    fn sidechain_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        setup_chain(
            tmp.path(),
            "-tmp-proj-f",
            SID_A,
            "root-u",
            vec![user_line(
                "u1",
                &serde_json::json!("子代理里的消息"),
                "2026-08-20T09:00:05.000Z",
                true,
            )],
        );
        let out = read_conversation_in(tmp.path(), "-tmp-proj-f", "root-u").unwrap();
        assert!(out.turns.iter().all(|t| t.uuid != "u1"), "isSidechain=true 必须跳过");
    }

    #[test]
    fn injected_text_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        setup_chain(
            tmp.path(),
            "-tmp-proj-g",
            SID_A,
            "root-u",
            vec![
                user_line(
                    "u1",
                    &serde_json::json!("<command-name>/clear</command-name>"),
                    "2026-08-20T09:00:05.000Z",
                    false,
                ),
                user_line(
                    "u2",
                    &serde_json::json!("Caveat: 这是系统注入的提醒"),
                    "2026-08-20T09:00:06.000Z",
                    false,
                ),
            ],
        );
        let out = read_conversation_in(tmp.path(), "-tmp-proj-g", "root-u").unwrap();
        assert!(out.turns.iter().all(|t| t.uuid != "u1" && t.uuid != "u2"), "注入文本必须跳过");
    }

    #[test]
    fn whitespace_only_turn_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        setup_chain(
            tmp.path(),
            "-tmp-proj-h",
            SID_A,
            "root-u",
            vec![assistant_line("a1", &serde_json::json!("   \n  \n"), "2026-08-20T09:00:05.000Z")],
        );
        let out = read_conversation_in(tmp.path(), "-tmp-proj-h", "root-u").unwrap();
        assert!(out.turns.iter().all(|t| t.uuid != "a1"), "trim 后为空的轮次必须跳过");
    }

    /// 回归测试：spec 明确要求不得按 "tool_use" 过滤整行——正文中合法提到
    /// "tool_use" 一词的消息必须完整保留，不能被误杀。
    #[test]
    fn text_legitimately_containing_tool_use_substring_is_not_dropped() {
        let tmp = tempfile::tempdir().unwrap();
        let text = "请解释一下 tool_use 参数应该如何构造，它和 tool_result 有什么区别？";
        setup_chain(
            tmp.path(),
            "-tmp-proj-i",
            SID_A,
            "root-u",
            vec![assistant_line("a1", &serde_json::json!(text), "2026-08-20T09:00:05.000Z")],
        );
        let out = read_conversation_in(tmp.path(), "-tmp-proj-i", "root-u").unwrap();
        let turn = out.turns.iter().find(|t| t.uuid == "a1");
        assert!(turn.is_some(), "文本仅仅提到 tool_use 一词不应导致整条记录被丢弃");
        assert_eq!(turn.unwrap().text, text);
    }

    #[test]
    fn role_falls_back_to_record_type_when_message_role_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-tmp-proj-j");
        fs::create_dir_all(&proj).unwrap();
        let lines = vec![
            user_line("root-u", &serde_json::json!("根消息"), "2026-08-20T09:00:00.000Z", false),
            r#"{"type":"assistant","isSidechain":false,"uuid":"a1","timestamp":"2026-08-20T09:00:05.000Z","message":{"content":"没有 role 字段的回答"}}"#.to_string(),
        ];
        write_jsonl(&proj, SID_A, &lines);
        let out = read_conversation_in(tmp.path(), "-tmp-proj-j", "root-u").unwrap();
        let turn = out.turns.iter().find(|t| t.uuid == "a1").expect("应回退到记录 type 字段");
        assert_eq!(turn.role, "assistant");
    }

    #[test]
    fn chain_across_two_files_ordered_by_time() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-tmp-proj-k");
        fs::create_dir_all(&proj).unwrap();

        // 文件 A：链的起点，较早。
        let lines_a = vec![
            user_line("root-u", &serde_json::json!("第一轮提问"), "2026-08-20T09:00:00.000Z", false),
            assistant_line("a1", &serde_json::json!("第一轮回答"), "2026-08-20T09:00:05.000Z"),
        ];
        let path_a = write_jsonl(&proj, SID_A, &lines_a);

        // 文件 B：恢复会话，较晚。头部复用同一 uuid（root-u）以命中同一链键，但内容为
        // tool_result（不可提取正文）——与 parser.rs 的
        // chain_key_captured_even_when_content_is_not_extractable_text 用例同构，
        // 避免链键复用导致根消息在拼接结果里重复出现。
        let root_replay = format!(
            r#"{{"type":"user","isSidechain":false,"uuid":"root-u","timestamp":"2026-08-21T09:59:00.000Z","message":{{"role":"user","content":[{{"type":"tool_result","content":"ok"}}]}}}}"#
        );
        let lines_b = vec![
            root_replay,
            user_line("u2", &serde_json::json!("第二轮提问"), "2026-08-21T10:00:00.000Z", false),
            assistant_line("a2", &serde_json::json!("第二轮回答"), "2026-08-21T10:00:05.000Z"),
        ];
        let path_b = write_jsonl(&proj, SID_B, &lines_b);

        let out = read_conversation_in(tmp.path(), "-tmp-proj-k", "root-u").unwrap();

        let uuids: Vec<&str> = out.turns.iter().map(|t| t.uuid.as_str()).collect();
        assert_eq!(uuids, vec!["root-u", "a1", "u2", "a2"], "两文件的正文须按时间升序拼接");

        assert_eq!(out.files.len(), 2);
        assert!(out.files[0].ends_with(&format!("{SID_A}.jsonl")), "较早的文件排在前面");
        assert!(out.files[1].ends_with(&format!("{SID_B}.jsonl")));

        let expected_bytes = fs::metadata(&path_a).unwrap().len() + fs::metadata(&path_b).unwrap().len();
        assert_eq!(out.total_bytes, expected_bytes);
    }

    #[test]
    fn missing_dir_returns_err_not_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let out = read_conversation_in(tmp.path(), "-does-not-exist", "root-u");
        assert!(out.is_err());
    }

    #[test]
    fn missing_root_key_returns_err_not_panic() {
        let tmp = tempfile::tempdir().unwrap();
        setup_chain(tmp.path(), "-tmp-proj-l", SID_A, "root-u", vec![]);
        let out = read_conversation_in(tmp.path(), "-tmp-proj-l", "no-such-chain");
        assert!(out.is_err());
    }

    #[test]
    fn cache_hit_does_not_touch_disk_again() {
        let tmp = tempfile::tempdir().unwrap();
        setup_chain(
            tmp.path(),
            "-tmp-proj-m",
            SID_A,
            "root-u",
            vec![assistant_line("a1", &serde_json::json!("缓存测试回答"), "2026-08-20T09:00:05.000Z")],
        );

        let first = read_conversation_in(tmp.path(), "-tmp-proj-m", "root-u").unwrap();
        let path = PathBuf::from(&first.files[0]);
        let reads_after_first = disk_read_count(&path);
        assert!(reads_after_first >= 1, "首次读取必须触碰磁盘");

        let second = read_conversation_in(tmp.path(), "-tmp-proj-m", "root-u").unwrap();
        let reads_after_second = disk_read_count(&path);

        assert_eq!(second, first, "缓存命中时结果必须与首次一致");
        assert_eq!(reads_after_second, reads_after_first, "大小/修改时间不变时不应重新解析（不触碰磁盘）");
    }

    #[test]
    fn append_only_growth_parses_new_turn_and_keeps_old_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let (proj, _) = setup_chain(
            tmp.path(),
            "-tmp-proj-n",
            SID_A,
            "root-u",
            vec![assistant_line("a1", &serde_json::json!("第一条回答"), "2026-08-20T09:00:05.000Z")],
        );

        let first = read_conversation_in(tmp.path(), "-tmp-proj-n", "root-u").unwrap();
        assert!(first.turns.iter().any(|t| t.uuid == "a1"));

        // 只追加，不改写既有内容——模拟运行中的会话持续写入。
        let path = proj.join(format!("{SID_A}.jsonl"));
        let new_line = assistant_line("a2", &serde_json::json!("追加的第二条回答"), "2026-08-20T09:00:10.000Z");
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        use std::io::Write as _;
        writeln!(f, "{new_line}").unwrap();
        drop(f);

        let second = read_conversation_in(tmp.path(), "-tmp-proj-n", "root-u").unwrap();
        assert!(second.turns.iter().any(|t| t.uuid == "a1"), "旧轮次必须保留");
        assert!(second.turns.iter().any(|t| t.uuid == "a2"), "新追加的轮次必须被解析出来");
    }

    /// 钉住字节筛选规则 3（"content 数组但不含 type:text 子串则跳过"）的契约：
    /// content 数组里真实存在文本块时，该行必然逐字节含 "type":"text" 子串，
    /// 规则 3 绝不能把它连同数组一起跳过。若这个断言有一天失败，说明规则 3
    /// 依赖的"紧凑无空白 JSON 序列化"假设已经不成立，应删除该规则而非修补它
    /// （见 parse_line 里规则 3 上方的注释）。
    #[test]
    fn content_array_with_text_block_not_skipped_by_byte_heuristic() {
        let tmp = tempfile::tempdir().unwrap();
        setup_chain(
            tmp.path(),
            "-tmp-proj-o",
            SID_A,
            "root-u",
            vec![assistant_line(
                "a1",
                &serde_json::json!([{"type": "text", "text": "数组形态的单个文本块"}]),
                "2026-08-20T09:00:05.000Z",
            )],
        );
        let out = read_conversation_in(tmp.path(), "-tmp-proj-o", "root-u").unwrap();
        let turn = out.turns.iter().find(|t| t.uuid == "a1");
        assert!(turn.is_some(), "content 数组含文本块时必须产生 Turn，不能被字节筛选规则 3 误杀");
        assert_eq!(turn.unwrap().text, "数组形态的单个文本块");
    }

    fn append_raw(path: &Path, s: &str) {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(s.as_bytes()).unwrap();
    }

    fn append_line(path: &Path, s: &str) {
        append_raw(path, s);
        append_raw(path, "\n");
    }

    /// 在一个合法的 UTF-8 字符边界上把 `s` 切成"约一半"，供构造撕裂的半行写入。
    fn safe_torn_point(s: &str, approx: usize) -> usize {
        let mut idx = approx.min(s.len());
        while idx > 0 && !s.is_char_boundary(idx) {
            idx -= 1;
        }
        idx
    }

    /// 多步增量续读：至少追加三次，每次追加后都调用一次 read，断言每一步累积的
    /// 轮次都完整、正确；其中一步以"半行"（无换行符，模拟运行中会话写到一半）
    /// 落地，下一步补完该行后再追加新内容，断言补完的轮次恰好出现一次——既不
    /// 丢失也不重复。P2b 的实时跟随会高频命中这条路径，这里补齐 review 指出的
    /// 覆盖缺口（此前只测过单次增量）。
    #[test]
    fn multi_step_incremental_append_including_torn_final_line() {
        let tmp = tempfile::tempdir().unwrap();
        let (proj, _) = setup_chain(
            tmp.path(),
            "-tmp-proj-q",
            SID_A,
            "root-u",
            vec![assistant_line("a1", &serde_json::json!("第一条回答"), "2026-08-20T09:00:05.000Z")],
        );
        let path = proj.join(format!("{SID_A}.jsonl"));

        let uuids = |c: &Conversation| c.turns.iter().map(|t| t.uuid.clone()).collect::<Vec<_>>();

        // 步骤 1：基线读取。
        let r1 = read_conversation_in(tmp.path(), "-tmp-proj-q", "root-u").unwrap();
        assert_eq!(uuids(&r1), vec!["root-u", "a1"]);

        // 步骤 2：完整追加第二轮，读取。
        append_line(&path, &assistant_line("a2", &serde_json::json!("第二条回答"), "2026-08-20T09:00:10.000Z"));
        let r2 = read_conversation_in(tmp.path(), "-tmp-proj-q", "root-u").unwrap();
        assert_eq!(uuids(&r2), vec!["root-u", "a1", "a2"], "第二步：旧轮次保留、新轮次出现");

        // 步骤 3：只追加半行（无换行符），模拟运行中会话写到一半就被读到。
        let line3 = assistant_line("a3", &serde_json::json!("第三条回答，写入中被截断"), "2026-08-20T09:00:15.000Z");
        let split = safe_torn_point(&line3, line3.len() / 2);
        append_raw(&path, &line3[..split]);
        let r3 = read_conversation_in(tmp.path(), "-tmp-proj-q", "root-u").unwrap();
        assert_eq!(
            uuids(&r3),
            vec!["root-u", "a1", "a2"],
            "第三步：未写完的半行不应产生 Turn，也不应丢失此前已解析的轮次"
        );

        // 步骤 4：补完那一行，再追加第四轮，读取。
        append_raw(&path, &line3[split..]);
        append_raw(&path, "\n");
        append_line(&path, &assistant_line("a4", &serde_json::json!("第四条回答"), "2026-08-20T09:00:20.000Z"));
        let r4 = read_conversation_in(tmp.path(), "-tmp-proj-q", "root-u").unwrap();
        assert_eq!(
            uuids(&r4),
            vec!["root-u", "a1", "a2", "a3", "a4"],
            "第四步：补完的轮次必须恰好出现一次，且新轮次正确解析"
        );
        assert_eq!(r4.turns.iter().filter(|t| t.uuid == "a3").count(), 1, "补完的轮次不能重复");
        let a3 = r4.turns.iter().find(|t| t.uuid == "a3").unwrap();
        assert_eq!(a3.text, "第三条回答，写入中被截断", "跨两次追加拼接后的正文必须完整、不截断");
    }
}

