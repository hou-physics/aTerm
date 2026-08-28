//! sub-agent 计数（spec §5.3 的 ⑂n 徽章）。
//!
//! 与本 crate 其余读取路径不同，这里**覆盖整个文件**：徽章语义是"该会话总共派了几个
//! sub-agent"，而调用散落全文，头尾窗口数不全。代价用三点抵消：
//! 1. **逐行流式读取**（`BufReader::read_until`），任何时刻内存里只有一行——计划批准
//!    的是"读完整个文件"这个*覆盖范围*，不是"把整份 transcript 搬进 RAM"。这一点不是
//!    可有可无的优化：本机 `~/.claude/projects/-Volumes-HouAstro-master` 里就有一个
//!    64.0MB、一个 21.2MB、一个 5.2MB 的 transcript，而前端（OverviewPage.tsx）对同一
//!    个项目最多并发发 4 个计数请求，早先的 `read_to_end` 写法在那种项目上峰值要吃掉
//!    接近 90MB；现在的峰值是"最长的那一行"，与文件多大无关。
//! 2. 结果按 (文件, 大小, mtime) 缓存，只有新追加的字节会被再解析；
//! 3. 该命令不在首屏路径上，由前端在方块渲染完成后异步调用。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
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

/// 从 `start` 逐行读到 EOF，统计其中"完整行"（以 `\n` 结尾）里的 sub-agent 调用数，
/// 返回 `(数量, 已消费字节数)`。
///
/// **不把文件读进内存**：`BufReader::read_until(b'\n')` 一次只交出一行，同一个行缓冲
/// 在行之间 `clear()` 复用，峰值内存是"最长的那一行"，与文件本身多大无关（见本文件
/// 顶部注释里那三个真实的 MB 级 transcript）。
///
/// 调用方（`count_file_cached`）保证 `start` 始终是行边界——见下面对 `consumed` 的
/// 推进方式：`parsed_bytes` 只会被推进到某个 `\n` 之后，从不停在行中间——所以这里
/// 不需要、也不做任何"猜测边界"的重同步；那类问题已经在源头（`parsed_bytes` 的推进
/// 方式）被消除，不必在读取这一层反复补救。
///
/// 已消费字节数 = 最后一个 `\n` 之后的偏移。如果文件末尾还有一段没有换行符收尾的
/// 残余（很可能是写入方正在写、还没来得及落下换行符的半行），那段残余**既不计入
/// 数量、也不计入已消费字节**——原样留给下一次读取（那时它要么已经写完、要么还是
/// 半行，继续留到再下一次）。
///
/// 这一步是整个增量缓存正确性的关键：`parsed_bytes`（= 已消费字节数的累加）由此
/// 永远精确落在某个 `\n` 之后。
/// - 下一次续读的 `start` 因此天然就是行边界，不需要再猜测/探测/重同步。
/// - 更重要的是不会丢数据：如果 `parsed_bytes` 像最初版本那样直接取读到的总字节数，
///   一行在被读到时如果恰好只写了一半，会经历两次读取都数不到它的情况——第一次因为
///   JSON 不完整解析失败被跳过（这本身没问题，是设计内的行为），但 `parsed_bytes`
///   仍把这半行的字节计入"已消费"；第二次续读时，从 `parsed_bytes` 开始的新字节
///   只是"上一行残余的后半段"，若不知道这一点就直接整段计数，得到的是一句拼接
///   得不完整、同样解析失败的畸形行——那一整行的调用就永久漏计了，且没有任何
///   后续读取会重新捕获它。现在的做法是那半行的字节完全不计入 `parsed_bytes`，
///   下一次读取会把"半行的前半 + 现在补全的后半"作为同一段新字节完整地重新读入、
///   完整地解析一次，因此不会漏计，也不会重复计。
///   （回归测试：`line_caught_mid_write_is_counted_once_completed`。）
///
/// `\n`（0x0A）在合法 UTF-8 中绝不会出现在多字节序列内部（这一点与
/// `read_tail_lines`，见 `sessions::parser`，的注释同理），因此只在 `\n` 处切分
/// 绝不会切断一个多字节字符——逐行 `from_utf8_lossy` 与"整段读完再一次性 lossy"
/// 逐字节等价（一个非法字节序列同样不可能跨过 `\n`），不需要额外校验。
fn count_complete_lines_from(f: &mut std::fs::File, start: u64) -> std::io::Result<(u32, u64)> {
    f.seek(SeekFrom::Start(start))?;
    let mut reader = BufReader::new(f);
    let mut line: Vec<u8> = Vec::new();
    let mut count: u32 = 0;
    let mut consumed: u64 = 0;
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 { break; } // EOF
        // 没有以 `\n` 收尾 = 文件末尾那段还没写完的半行（`read_until` 只在 EOF 时才会
        // 返回不含分隔符的一段）：不计数、不计入 consumed，留给下一次读取。
        if line.last() != Some(&b'\n') { break; }
        consumed += n as u64;
        count += count_agent_calls(&String::from_utf8_lossy(&line));
    }
    Ok((count, consumed))
}

/// 对单个文件求 sub-agent 调用数，命中缓存时只解析新追加的字节。
/// 文件被截短（轮转/重写，`len < parsed_bytes`）或未命中缓存时整读重算。
pub fn count_file_cached(path: &Path, cache: &SubagentCache) -> std::io::Result<u32> {
    let mut f = std::fs::File::open(path)?;
    let meta = f.metadata()?;
    let len = meta.len();
    let mtime_ms = mtime_ms_of(&meta);

    // 锁只用来保护 HashMap 的读取——立刻拷出 entry（`CacheEntry` 是 `Copy`）后马上
    // 释放锁，文件 I/O 和 JSON 解析全部在锁外进行。这不是可有可无的细节：一次
    // `count_subagents` 调用如今只碰一个文件，但**并发是从前端来的**——OverviewPage.tsx
    // 的徽章补齐队列（`SUBAGENT_FETCH_CONCURRENCY = 4`）会同时把 4 个 `count_subagents`
    // 命令送进来，每个命令都标了 `#[tauri::command(async)]`、跑在各自的线程上，因此
    // 本函数确实会被 4 个不同文件并发调用。若把锁一路握到 `insert`，这 4 个徽章查询
    // 就会排队等在同一把全局锁后面，每一个都要等前一个把一整个可能几十 MB 的文件
    // 逐行解析完才能拿到锁——这正是本项目已经在
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
            let (added, consumed) = count_complete_lines_from(&mut f, entry.parsed_bytes)?;
            (entry.count + added, entry.parsed_bytes + consumed)
        }
        _ => {
            // 未命中缓存，或文件被截短（len < parsed_bytes）：从头重扫全文，绝不沿用
            // 旧计数（同样是逐行流式，不整入内存）。
            count_complete_lines_from(&mut f, 0)?
        }
    };

    let mut map = cache.0.lock().unwrap_or_else(|e| e.into_inner());
    map.insert(path.to_path_buf(), CacheEntry { parsed_bytes, mtime_ms, count });
    Ok(count)
}

/// `count_subagents` 的可测试内核：`projects_dir` 由调用方传入，测试可指向临时目录，
/// 无需触碰真实的 `~/.claude/projects`（Global Constraints 明令禁止）。与
/// `conversation::read_conversation_in` 是同一条缝、同一个理由，那边怎么拆这边就
/// 怎么拆。
///
/// **只统计一个文件：调用方指名的那一个。** 前端传进来的 `session_id` 就是
/// `ThreadInfo.resume_session_id`（`scan.rs` 为这条链选出的"最新文件"，见
/// `scan_projects` 与它的 `resumed_session_merges_into_one_thread` 测试）。绝不能把
/// 链上所有文件的计数相加。
///
/// 关于"为什么只数最新那一个"，本仓库有一条诚实的记录（`docs/BACKLOG.md`
/// 「会话链的已知局限」）：**实测行为是 `--resume` 复用同一 sessionId 并追加到原
/// 文件**，因此多文件链在实测数据里根本不出现，`group_chain_files` 的串链逻辑目前
/// 是防御性的空转。这里因此**不对"多文件链一旦真的出现，各文件之间是什么关系"给出
/// 任何机制性断言**——本项目从未测到过那种数据，任何这类断言都是猜测。（此前这段
/// 注释断言"resume 会把原始首条用户消息重放进新文件，所以链上文件层层重叠、求和会
/// 重复计数"；那是一句仓库自己的实测结果并不支持的话，已删除。）
///
/// 保留"只数最新那一个"是务实取舍，理由与机制无关：
/// - 它与 Task 2 的其它徽章字段（model / context_tokens / preview，同样只取自
///   `newest.meta`）指向同一个文件、同一个"最新时刻"，一枚方块上的几个徽章因此自洽；
/// - 它与"继续对话"真正会 resume 的那个文件是同一个（前端传来的正是
///   `resume_session_id`），用户看到的数字和他点下去会进入的会话对得上；
/// - 求和则是明确错误的选项：链若真的成立，重叠部分会被按恢复次数重复计入。
///
/// 顺带记一笔：`conversation.rs` 的 `read_conversation_in` 对同一条链的处理是**按
/// 时间升序拼接全部文件、不做任何去重**——那是第三套模型，与这里的取舍并不自洽。
/// 两者当前都不会在实测数据上触发（链恒为单文件），因此本期不动行为，只把这笔账
/// 记进 `docs/BACKLOG.md`（「会话链语义待统一」）。
pub fn count_subagents_in(
    projects_dir: &Path,
    dir_name: &str,
    session_id: &str,
    cache: &SubagentCache,
) -> Result<u32, String> {
    // 文件名这一半的路径穿越在这里关掉：`session_id` 直接来自前端，先过 `scan.rs`
    // 既有的 `is_uuid_stem`（只允许十六进制字符与短横线，`.` 与 `/` 一律不通过）。
    // 目录名那一半沿用 `read_conversation` 既有的同一种拼接方式，不在本次改动范围内。
    if !super::scan::is_uuid_stem(session_id) { return Ok(0); }
    let path = projects_dir.join(dir_name).join(format!("{session_id}.jsonl"));
    // 文件不存在（会话被删了，或前端传来一个这台机器上没有的组合）按既有约定返回
    // `Ok(0)`，而不是 Err：在前端它与"这个会话没派过 sub-agent"是同一种表现
    // （spec §5.3：n 为 0 时不显示徽章），`ipc.ts` 的 `countSubagents` 注释记录的
    // 就是这条约定。
    if !path.is_file() { return Ok(0); }
    count_file_cached(&path, cache).map_err(|e| e.to_string())
}

/// 由 `dir_name`（`~/.claude/projects/<dir_name>`）+ `session_id` 定位单个 transcript，
/// 统计它的 sub-agent 调用数。
///
/// `session_id` 由前端传入（它手里的 `ThreadInfo.resume_session_id`），而不是像最初
/// 那样在这里从 `root_key` 重新推导：后者要对整个项目目录跑一次 `group_chain_files`
/// ——读每个 `.jsonl` 的头 40 行/256KB **和**尾 64KB，再对每个文件各跑一次
/// `parse_meta`——只为算出一个前端本来就已经握在手里的文件名。总览页每个方块都会发
/// 一次这个命令，于是 N 个会话 × F 个文件次 bounded 读取 + 同样多次 `parse_meta`；
/// 由前端把 id 传进来之后是 O(N)，顺带也把文件名这一半的路径穿越面关掉了。
///
/// **必须标 `#[tauri::command(async)]`**——Tauri 命令默认跑在 macOS 主线程上，
/// 逐行读完一个大文件会卡住 UI（本项目已在 `pty_write` / `list_projects` 上踩过这个
/// 坑）。该命令也不在首屏路径上：前端先用 Task 2 的 bounded 数据把方块画出来，再
/// 异步补这枚徽章（Task 11 的工作）。
#[tauri::command(async)]
pub async fn count_subagents(
    dir_name: String,
    session_id: String,
    state: State<'_, SubagentCache>,
) -> Result<u32, String> {
    let home = dirs::home_dir().ok_or("找不到用户目录")?;
    let projects_dir = home.join(".claude").join("projects");
    count_subagents_in(&projects_dir, &dir_name, &session_id, &state)
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

    // ---- count_subagents_in：文件选取规则与未知键回退 ----
    //
    // 这三条规则此前完全没有覆盖：`count_subagents` 过去直接调 `dirs::home_dir()`，
    // 除非触碰真实的 `~/.claude`（Global Constraints 明令禁止）否则测不了。抽出
    // `count_subagents_in` 之后就能用 tempfile 覆盖——与 `conversation.rs` 的
    // `read_conversation_in` 同一条缝。
    //
    // 「链上取最新那一个」这条规则由两半共同保证，两半各有各的测试：
    //   1. 哪个文件是"最新"，由 `scan.rs` 决定（`ThreadInfo.resume_session_id`），
    //      覆盖它的是 scan.rs 的 `resumed_session_merges_into_one_thread`；
    //   2. 拿到这个 id 之后**只数这一个文件、绝不求和**，覆盖它的是下面第一条。

    const S_OLD: &str = "11111111-1111-1111-1111-111111111111";
    const S_NEW: &str = "22222222-2222-2222-2222-222222222222";
    const PROJ_DIR: &str = "-tmp-fake-proj";

    fn write_calls(proj: &Path, sid: &str, calls: usize) {
        let body: String = (0..calls).map(|_| format!("{}\n", agent_call_line("Agent"))).collect();
        std::fs::write(proj.join(format!("{sid}.jsonl")), body).unwrap();
    }

    fn fake_projects_dir() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join(PROJ_DIR)).unwrap();
        tmp
    }

    #[test]
    fn counts_only_the_named_file_never_the_sum_of_the_chain() {
        let tmp = fake_projects_dir();
        let proj = tmp.path().join(PROJ_DIR);
        // 同一条链上的两个文件：旧的 2 次调用、新的 3 次。求和会得到 5，是明确
        // 错误的答案（见 count_subagents_in 的文档注释）。
        write_calls(&proj, S_OLD, 2);
        write_calls(&proj, S_NEW, 3);
        let cache = SubagentCache::default();

        assert_eq!(
            count_subagents_in(tmp.path(), PROJ_DIR, S_NEW, &cache).unwrap(), 3,
            "只数被指名的那个文件；5（求和）必须是错的",
        );
        // 指名旧文件时同样只数它自己——这个函数不做任何"链上还有别的文件"的推导，
        // 选哪个文件完全由调用方（前端传来的 resume_session_id）决定。
        assert_eq!(count_subagents_in(tmp.path(), PROJ_DIR, S_OLD, &cache).unwrap(), 2);
    }

    #[test]
    fn unknown_session_id_falls_back_to_zero_not_error() {
        let tmp = fake_projects_dir();
        write_calls(&tmp.path().join(PROJ_DIR), S_NEW, 3);
        let cache = SubagentCache::default();

        // 项目目录里没有这个 session：Ok(0)，不是 Err（ipc.ts 记录的既有约定）。
        let missing = "99999999-9999-9999-9999-999999999999";
        assert_eq!(count_subagents_in(tmp.path(), PROJ_DIR, missing, &cache).unwrap(), 0);
        // 项目目录本身不存在时同样是 Ok(0)。
        assert_eq!(count_subagents_in(tmp.path(), "-no-such-project", S_NEW, &cache).unwrap(), 0);
    }

    #[test]
    fn non_uuid_session_id_is_rejected_before_touching_the_filesystem() {
        let tmp = fake_projects_dir();
        // 项目目录的上一层放一个"不该被读到"的文件，名字刚好能被 `../` 拼中。
        std::fs::write(tmp.path().join("secret.jsonl"), format!("{}\n", agent_call_line("Agent"))).unwrap();
        let cache = SubagentCache::default();

        for bad in ["../secret", "..", "/etc/passwd", "not-a-uuid", ""] {
            assert_eq!(
                count_subagents_in(tmp.path(), PROJ_DIR, bad, &cache).unwrap(), 0,
                "非法 session id（{bad}）必须在拼路径之前就被 is_uuid_stem 挡掉",
            );
        }
    }
}
