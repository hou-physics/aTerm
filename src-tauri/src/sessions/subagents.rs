//! sub-agent 计数（spec §5.3 的 ⑂n 徽章）。
//!
//! 与本 crate 其余读取路径不同，这里**整读**文件：徽章语义是"该会话总共派了几个
//! sub-agent"，而调用散落全文，头尾窗口数不全。代价用两点抵消：
//! 1. 结果按 (文件, 大小, mtime) 缓存，只有新追加的字节会被再解析；
//! 2. 该命令不在首屏路径上，由前端在方块渲染完成后异步调用。

use super::scan::group_chain_files;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

/// 本版本 Claude Code 的 sub-agent 工具名为 `Agent`；旧版本为 `Task`。两者都认，
/// 以免用户升级/降级后徽章归零。
const SUBAGENT_TOOL_NAMES: [&str; 2] = ["Agent", "Task"];

#[derive(Debug, Clone, Copy)]
pub struct CacheEntry {
    pub parsed_bytes: u64,
    pub mtime_ms: i64,
    pub count: u32,
}

#[derive(Default)]
pub struct SubagentCache(pub Mutex<HashMap<PathBuf, CacheEntry>>);

/// 统计一段 JSONL 文本中的 sub-agent 调用数。畸形行跳过，不 panic。
pub fn count_agent_calls(text: &str) -> u32 {
    let mut n = 0;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(content) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) else { continue };
        for b in content {
            if b.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                if let Some(name) = b.get("name").and_then(|x| x.as_str()) {
                    if SUBAGENT_TOOL_NAMES.contains(&name) { n += 1; }
                }
            }
        }
    }
    n
}

fn mtime_ms_of(meta: &std::fs::Metadata) -> i64 {
    meta.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 读取文件 `[start, EOF)` 字节区间的增量段。`start` 就是上一次读到的
/// `parsed_bytes`——通常它紧跟在上一行的 `\n` 之后（写入方一次性把一整行连同换行符
/// 写完，读到 EOF 自然落在行边界上），这种正常情况下新增内容可以直接使用。
/// 但不能想当然地假设这一点：如果上次读到 EOF 时，写入方刚好还没来得及写完那一行
/// 的换行符（写入与读取竞争），`start` 就会落在行中间，从这里往后读到的第一段
/// 字节其实是"上一行的残余"，其中可能出现半个多字节 UTF-8 字符。因此在拼字符串
/// 之前先探测 `start` 是否真的是行边界（`start == 0` 或前一个字节是 `\n`）；只有
/// 不是的时候才需要按 `\n` 重新同步、跳过这半行——与 `read_tail_lines`（见
/// `sessions::parser`）同样的道理：绝不能对原始字节做定长 `read_to_string`，否则
/// 一旦切点非法就会在多字节字符中间截断，静默丢失中文内容（本项目曾出过这个真实
/// 事故）。若无脑对每次增量读都做这种丢弃，则会在最常见的"start 已经是行边界"
/// 场景下把刚追加的第一整行也丢掉，因此这里先探测再决定是否需要重同步。
fn read_appended(f: &mut std::fs::File, start: u64) -> std::io::Result<String> {
    let needs_resync = if start == 0 {
        false
    } else {
        let mut prev_byte = [0u8; 1];
        f.seek(SeekFrom::Start(start - 1))?;
        f.read_exact(&mut prev_byte)?;
        prev_byte[0] != b'\n'
    };
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    if needs_resync {
        buf = match buf.iter().position(|&b| b == b'\n') {
            Some(i) => buf[i + 1..].to_vec(),
            None => Vec::new(), // 窗口内没有完整行可用
        };
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// 对单个文件求 sub-agent 调用数，命中缓存时只解析新追加的字节。
/// 文件被截短（轮转/重写，`len < parsed_bytes`）或未命中缓存时整读重算。
pub fn count_file_cached(path: &Path, cache: &SubagentCache) -> std::io::Result<u32> {
    let mut f = std::fs::File::open(path)?;
    let meta = f.metadata()?;
    let len = meta.len();
    let mtime_ms = mtime_ms_of(&meta);

    let mut map = cache.0.lock().unwrap_or_else(|e| e.into_inner());
    let prior = map.get(path).copied();

    // 大小和 mtime 都与上次记录的完全一致：文件自上次统计后确定未被碰过，
    // 直接复用旧计数，连增量段都不必读。只看 len 不够——截断后再重写出等长的新
    // 内容是可能的（len 相等但内容已变），mtime 未变才是"确实原封未动"的更强信号，
    // 这也是 mtime_ms 被放进缓存的意义。
    if let Some(entry) = prior {
        if len == entry.parsed_bytes && mtime_ms == entry.mtime_ms {
            return Ok(entry.count);
        }
    }

    let (count, parsed_bytes) = match prior {
        Some(entry) if len >= entry.parsed_bytes => {
            let appended = read_appended(&mut f, entry.parsed_bytes)?;
            (entry.count + count_agent_calls(&appended), len)
        }
        _ => {
            // 未命中缓存，或文件被截短（len < parsed_bytes）：整读重算，绝不沿用旧计数。
            let mut text = String::new();
            f.seek(SeekFrom::Start(0))?;
            f.read_to_string(&mut text)?;
            (count_agent_calls(&text), len)
        }
    };

    map.insert(path.to_path_buf(), CacheEntry { parsed_bytes, mtime_ms, count });
    Ok(count)
}

/// 由 `dir_name`（`~/.claude/projects/<dir_name>`）+ `root_key`（链键）定位该会话链
/// 上的所有文件，逐个 `count_file_cached` 求和。分组逻辑复用
/// `sessions::scan::group_chain_files`，不在此处重新推导文件名→链的映射规则。
///
/// **必须标 `#[tauri::command(async)]`**——Tauri 命令默认跑在 macOS 主线程上，
/// 整读大文件会卡住 UI（本项目已在 `pty_write` / `list_projects` 上踩过这个坑）。
/// 该命令也不在首屏路径上：前端先用 Task 2 的 bounded 数据把方块画出来，再异步
/// 补这枚徽章（Task 11 的工作）。
#[tauri::command(async)]
pub async fn count_subagents(
    dir_name: String,
    root_key: String,
    state: State<'_, SubagentCache>,
) -> Result<u32, String> {
    let home = dirs::home_dir().ok_or("找不到用户目录")?;
    let dir = home.join(".claude").join("projects").join(dir_name);
    let mut groups = group_chain_files(&dir);
    let Some(files) = groups.remove(&root_key) else { return Ok(0) };
    let mut total = 0u32;
    for file in files {
        total += count_file_cached(&file.path, &state).map_err(|e| e.to_string())?;
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_call_line(name: &str) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"t1","name":"{name}","input":{{}}}}]}}}}"#
        )
    }

    #[test]
    fn counts_agent_and_task_tool_uses() {
        let text = format!(
            "{}\n{}\n{}\n",
            agent_call_line("Agent"),   // 本版本的 sub-agent 工具名
            agent_call_line("Task"),    // 旧版本的名字，也要认
            agent_call_line("Bash"),    // 普通工具，不计
        );
        assert_eq!(count_agent_calls(&text), 2);
    }

    #[test]
    fn malformed_lines_are_skipped_not_panicking() {
        let text = format!("not json\n\n{}\n{{\"type\":\"assistant\"}}\n", agent_call_line("Agent"));
        assert_eq!(count_agent_calls(&text), 1);
    }

    #[test]
    fn incremental_recount_picks_up_appended_calls() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("s.jsonl");
        std::fs::write(&f, format!("{}\n", agent_call_line("Agent"))).unwrap();
        let cache = SubagentCache::default();
        assert_eq!(count_file_cached(&f, &cache).unwrap(), 1);

        // 追加两次调用后重数，应为 3（且只解析新增部分）
        let mut fh = std::fs::OpenOptions::new().append(true).open(&f).unwrap();
        use std::io::Write;
        writeln!(fh, "{}", agent_call_line("Agent")).unwrap();
        writeln!(fh, "{}", agent_call_line("Task")).unwrap();
        drop(fh);
        assert_eq!(count_file_cached(&f, &cache).unwrap(), 3);
    }

    #[test]
    fn truncated_file_triggers_full_reparse() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("s.jsonl");
        std::fs::write(&f, format!("{}\n{}\n", agent_call_line("Agent"), agent_call_line("Agent"))).unwrap();
        let cache = SubagentCache::default();
        assert_eq!(count_file_cached(&f, &cache).unwrap(), 2);

        // 文件被截短（轮转/重写）：缓存的 parsed_bytes 已大于文件大小，必须整读重算
        std::fs::write(&f, format!("{}\n", agent_call_line("Agent"))).unwrap();
        assert_eq!(count_file_cached(&f, &cache).unwrap(), 1, "截断后必须重新整读，不能沿用旧计数");
    }
}
