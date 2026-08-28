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

/// 读取文件从 `start` 到 EOF 的原始字节。调用方（`count_file_cached`）保证
/// `start` 始终是行边界——见 `count_complete_lines`：`parsed_bytes` 只会被推进到
/// 某个 `\n` 之后，从不停在行中间——所以这里不需要、也不做任何"猜测边界"的重
/// 同步；那类问题已经在源头（`parsed_bytes` 的推进方式）被消除，不必在读取这一层
/// 反复补救。
fn read_appended(f: &mut std::fs::File, start: u64) -> std::io::Result<Vec<u8>> {
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(buf)
}

/// 统计原始字节 `buf` 中"完整行"（以 `\n` 结尾）里的 sub-agent 调用数，返回
/// `(数量, 已消费字节数)`。已消费字节数 = 最后一个 `\n` 之后的偏移；如果 `buf`
/// 末尾还有一段没有换行符收尾的残余（很可能是写入方正在写、还没来得及落下换行符
/// 的半行），那段残余**既不计入数量、也不计入已消费字节**——原样留给下一次读取
/// （那时它要么已经写完、要么还是半行，继续留到再下一次）。
///
/// 这一步是整个增量缓存正确性的关键：`parsed_bytes`（= 已消费字节数的累加）由此
/// 永远精确落在某个 `\n` 之后。
/// - 对 `read_appended` 而言，下一次续读的 `start` 因此天然就是行边界，不需要再
///   猜测/探测/重同步。
/// - 更重要的是不会丢数据：如果 `parsed_bytes` 像最初版本那样直接取 `len`，一行
///   在被读到时如果恰好只写了一半，会经历两次读取都数不到它的情况——第一次因为
///   JSON 不完整解析失败被跳过（这本身没问题，是设计内的行为），但 `parsed_bytes`
///   仍把这半行的字节计入"已消费"；第二次续读时，从 `parsed_bytes` 开始的新字节
///   只是"上一行残余的后半段"，若不知道这一点就直接整段计数，得到的是一句拼接
///   得不完整、同样解析失败的畸形行——那一整行的调用就永久漏计了，且没有任何
///   后续读取会重新捕获它。现在的做法是那半行的字节完全不计入 `parsed_bytes`，
///   下一次读取会把"半行的前半 + 现在补全的后半"作为同一段新字节完整地重新读入、
///   完整地解析一次，因此不会漏计，也不会重复计。
///
/// `\n`（0x0A）在合法 UTF-8 中绝不会出现在多字节序列内部（这一点与
/// `read_tail_lines`，见 `sessions::parser`，的注释同理），因此只在 `\n` 处切分
/// 绝不会切断一个多字节字符——`buf[..consumed]` 转字符串是安全的，不需要额外
/// 校验。
fn count_complete_lines(buf: &[u8]) -> (u32, usize) {
    let consumed = match buf.iter().rposition(|&b| b == b'\n') {
        Some(i) => i + 1,
        None => 0,
    };
    let text = String::from_utf8_lossy(&buf[..consumed]);
    (count_agent_calls(&text), consumed)
}

/// 对单个文件求 sub-agent 调用数，命中缓存时只解析新追加的字节。
/// 文件被截短（轮转/重写，`len < parsed_bytes`）或未命中缓存时整读重算。
pub fn count_file_cached(path: &Path, cache: &SubagentCache) -> std::io::Result<u32> {
    let mut f = std::fs::File::open(path)?;
    let meta = f.metadata()?;
    let len = meta.len();
    let mtime_ms = mtime_ms_of(&meta);

    // 锁只用来保护 HashMap 的读取——立刻拷出 entry（`CacheEntry` 是 `Copy`）后马上
    // 释放锁，文件 I/O 和 JSON 解析全部在锁外进行。这不是可有可无的细节：
    // `count_subagents` 会对链上/多个会话并发调用本函数，若把锁一路握到
    // `insert`，N 个并发徽章查询就会排队等在同一把全局锁后面，每一个都要等前一个
    // 读完一整个可能几 MB 的文件、逐行解析完才能拿到锁——这正是本项目已经在
    // `pty::with_pty`（见其函数头注释）上踩过、并特意修掉的"锁盖住 I/O"反模式，
    // 不能在这里重犯。放弃的只是"读到的 entry 和随后的重算之间不再原子"这一点：
    // 两次并发调用都读到同一个旧 entry、都各自做了一遍重算，最后谁后写入谁的结果
    // 留下——两边算出来的数字在文件没有再变的前提下应当一致，无非是白算一次，
    // 不会算错；如果文件在两次调用之间又变了，那反正下一次调用也会追上，不会永久
    // 停留在错误值上。
    let prior = {
        let map = cache.0.lock().unwrap_or_else(|e| e.into_inner());
        map.get(path).copied()
    };

    // 大小和 mtime 都与上次记录的完全一致：文件自上次统计后确定未被碰过，
    // 直接复用旧计数，连文件都不必再读。只看 len 不够——截断后再重写出等长的新
    // 内容是可能的（len 相等但内容已变），mtime 未变才是"确实原封未动"的更强信号，
    // 这也是 mtime_ms 被放进缓存的意义。
    if let Some(entry) = prior {
        if len == entry.parsed_bytes && mtime_ms == entry.mtime_ms {
            return Ok(entry.count);
        }
    }

    let (count, parsed_bytes) = match prior {
        Some(entry) if len >= entry.parsed_bytes => {
            let buf = read_appended(&mut f, entry.parsed_bytes)?;
            let (added, consumed) = count_complete_lines(&buf);
            (entry.count + added, entry.parsed_bytes + consumed as u64)
        }
        _ => {
            // 未命中缓存，或文件被截短（len < parsed_bytes）：整读重算，绝不沿用旧计数。
            f.seek(SeekFrom::Start(0))?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            let (count, consumed) = count_complete_lines(&buf);
            (count, consumed as u64)
        }
    };

    let mut map = cache.0.lock().unwrap_or_else(|e| e.into_inner());
    map.insert(path.to_path_buf(), CacheEntry { parsed_bytes, mtime_ms, count });
    Ok(count)
}

/// 由 `dir_name`（`~/.claude/projects/<dir_name>`）+ `root_key`（链键）定位该会话链，
/// 只统计链上**最新**的一个文件——绝不能把链上所有文件的计数相加。
///
/// `group_chain_files`（见 `scan.rs`）按首条用户消息的 uuid 分组：同一条链里除了
/// 最新文件外，每个更早的文件都是"被恢复的会话"——`resume` 时 Claude Code 会把
/// 原始的第一条用户消息连同它的 uuid 一起重放到新文件的开头，链键才因此相同。
/// 也就是说链上的文件天然是互相包含、层层重叠的历史，而不是互不相干、各自新增
/// 的片段；对它们的计数求和会把同一批 sub-agent 调用按恢复次数重复计入，徽章
/// 数字会被明显虚高。只统计最新文件才是正确、而且完整的：它重放了链上迄今为止
/// 的全部历史，因此本身已经包含了完整的调用记录。选取方式与 `scan_projects` 完全
/// 一致（按 `last_ts_ms` 排序、缺失时退回 `mtime_ms`，取最后一个），这也让徽章与
/// Task 2 里的其它字段（同样只取自 `newest.meta`）指向同一个文件、同一个"最新
/// 时刻"。
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
    let Some(mut files) = groups.remove(&root_key) else { return Ok(0) };
    files.sort_by_key(|fm| fm.meta.last_ts_ms.unwrap_or(fm.mtime_ms));
    let Some(newest) = files.last() else { return Ok(0) };
    count_file_cached(&newest.path, &state).map_err(|e| e.to_string())
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
    fn line_caught_mid_write_is_counted_once_completed() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("s.jsonl");
        let a = agent_call_line("Agent");
        let b = agent_call_line("Task");
        let c = agent_call_line("Agent");
        let split = b.len() / 2;
        let (b_head, b_tail) = b.split_at(split);
        // 模拟写入方正在写 B 这一行、还没落下换行符时被读到（A 已完整落盘）。
        std::fs::write(&f, format!("{a}\n{b_head}")).unwrap();
        let cache = SubagentCache::default();
        assert_eq!(count_file_cached(&f, &cache).unwrap(), 1, "B 尚未写完，只应计入 A");

        // 写入方续写完 B（含换行符），再写完整的 C。
        let mut fh = std::fs::OpenOptions::new().append(true).open(&f).unwrap();
        use std::io::Write;
        write!(fh, "{b_tail}\n{c}\n").unwrap();
        drop(fh);
        assert_eq!(count_file_cached(&f, &cache).unwrap(), 3, "B 补完后必须被计入，不能永久丢失");
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
