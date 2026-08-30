use super::parser::{parse_meta, read_head_lines, read_tail_lines, ParsedMeta};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub root_key: String,
    pub resume_session_id: String,
    pub title: String,
    pub cwd: String,
    pub last_activity_ms: i64,
    pub file_count: u32,
    // 徽章数据：均可缺省（老会话或异常记录取不到时为 None），取自链上最后一个
    // 文件的 ParsedMeta——与 last_activity_ms 同一来源，保证徽章与时间描述同一时刻。
    pub model: Option<String>,
    pub context_tokens: Option<u64>,
    pub preview: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    /// 本链上所有 jsonl 文件的 session id，按时间升序（与 file_count 同源）。前端的
    /// 窗格对账靠它把"我起进程时用 --session-id 指定的那个 id"映射回当前的 root_key
    /// ——root_key 会在首条用户消息出现时翻一次，不能作为窗格的稳定身份。
    pub session_ids: Vec<String>,
    /// 本链是否已有真实标题。false 表示 `title` 是 session_id 前 8 位的回退值（见下方
    /// scan_projects 里 title 的 unwrap_or_else），前端据此决定要不要采纳它——采纳了
    /// 会把标签标题变成一串 uuid。
    pub titled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub dir_name: String,
    pub cwd: String,
    pub last_activity_ms: i64,
    pub threads: Vec<ThreadInfo>,
}

/// 文件名（不含扩展名）是否是一个合法的 session id。`group_chain_files` 用它过滤目录
/// 项；`subagents::count_subagents_in` 用它校验**前端传回来的** session id——那条路径
/// 会把 session id 直接拼进文件名（`<session_id>.jsonl`），必须先确认它只由十六进制
/// 字符与短横线组成，`.`/`/` 一律不可能通过，从而在文件名这一半上关掉路径穿越。
pub(crate) fn is_uuid_stem(stem: &str) -> bool {
    stem.len() == 36 && stem.chars().filter(|c| *c == '-').count() == 4
        && stem.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// 一个会话链内的单个 jsonl 文件及其头尾元信息。
pub struct ChainFile {
    pub session_id: String,
    pub path: PathBuf,
    pub meta: ParsedMeta,
    pub mtime_ms: i64,
}

/// 扫描单个项目目录（如 `~/.claude/projects/<dir_name>`）下的会话文件，
/// 按链键（root_key，即首条用户消息 uuid；缺失时退回自身 session_id）分组。
/// 供 `scan_projects`（会话列表）与 `conversation::read_conversation`（正文读取）
/// 共用，分组规则只在此处实现一次。
pub fn group_chain_files(dir: &Path) -> std::collections::HashMap<String, Vec<ChainFile>> {
    let mut groups: std::collections::HashMap<String, Vec<ChainFile>> = Default::default();
    let Ok(inner) = std::fs::read_dir(dir) else { return groups };
    for f in inner.flatten() {
        let p = f.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else { continue };
        if !is_uuid_stem(stem) { continue; }
        let head = read_head_lines(&p, 40, 256 * 1024).unwrap_or_default();
        let tail = read_tail_lines(&p, 64 * 1024).unwrap_or_default();
        let mtime_ms = f.metadata().ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64).unwrap_or(0);
        let meta = parse_meta(&head, &tail);
        let key = meta.first_user_uuid.clone().unwrap_or_else(|| stem.to_string());
        groups.entry(key).or_default().push(ChainFile { session_id: stem.to_string(), path: p, meta, mtime_ms });
    }
    groups
}

pub fn scan_projects(projects_dir: &Path) -> Vec<ProjectInfo> {
    let Ok(entries) = std::fs::read_dir(projects_dir) else { return vec![] };
    let mut projects: Vec<ProjectInfo> = vec![];
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() { continue; }
        let groups = group_chain_files(&dir);
        if groups.is_empty() { continue; }

        let mut threads: Vec<ThreadInfo> = groups.into_iter().map(|(key, mut fs)| {
            fs.sort_by_key(|fm| fm.meta.last_ts_ms.unwrap_or(fm.mtime_ms));
            let newest = fs.last().unwrap();
            let title_opt = fs.iter().rev().find_map(|fm| fm.meta.title.clone());
            let titled = title_opt.is_some();
            let title = title_opt.unwrap_or_else(|| newest.session_id.chars().take(8).collect());
            let session_ids: Vec<String> = fs.iter().map(|fm| fm.session_id.clone()).collect();
            let cwd = fs.iter().rev().find_map(|fm| fm.meta.cwd.clone()).unwrap_or_default();
            ThreadInfo {
                root_key: key,
                resume_session_id: newest.session_id.clone(),
                title, cwd,
                last_activity_ms: newest.meta.last_ts_ms.unwrap_or(newest.mtime_ms),
                file_count: fs.len() as u32,
                model: newest.meta.model.clone(),
                context_tokens: newest.meta.context_tokens,
                preview: newest.meta.preview.clone(),
                effort: newest.meta.effort.clone(),
                permission_mode: newest.meta.permission_mode.clone(),
                session_ids,
                titled,
            }
        }).collect();
        threads.sort_by_key(|t| std::cmp::Reverse(t.last_activity_ms));

        let dir_name = dir.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let cwd = threads.iter().find(|t| !t.cwd.is_empty()).map(|t| t.cwd.clone())
            .unwrap_or_else(|| dir_name.replace('-', "/"));
        projects.push(ProjectInfo {
            dir_name,
            cwd,
            last_activity_ms: threads.first().map(|t| t.last_activity_ms).unwrap_or(0),
            threads,
        });
    }
    projects.sort_by_key(|p| std::cmp::Reverse(p.last_activity_ms));
    projects
}

#[tauri::command(async)]
pub fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    let home = dirs::home_dir().ok_or("找不到用户目录")?;
    Ok(scan_projects(&home.join(".claude").join("projects")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const S_A: &str = "11111111-1111-1111-1111-111111111111"; // 原始会话
    const S_B: &str = "22222222-2222-2222-2222-222222222222"; // A 的恢复（同 first_user_uuid）
    const S_C: &str = "33333333-3333-3333-3333-333333333333"; // 独立会话

    fn write_session(dir: &std::path::Path, sid: &str, first_uuid: &str, text: &str, ts: &str) {
        let l1 = format!(r#"{{"parentUuid":null,"isSidechain":false,"cwd":"/tmp/fake-proj","sessionId":"{sid}","timestamp":"{ts}","type":"user","message":{{"role":"user","content":"{text}"}},"uuid":"{first_uuid}"}}"#);
        let l2 = format!(r#"{{"type":"assistant","uuid":"{first_uuid}-a","timestamp":"{ts}","sessionId":"{sid}","message":{{"role":"assistant","model":"claude-opus-5"}}}}"#);
        fs::write(dir.join(format!("{sid}.jsonl")), format!("{l1}\n{l2}\n")).unwrap();
    }

    #[test]
    fn resumed_session_merges_into_one_thread() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-tmp-fake-proj");
        fs::create_dir(&proj).unwrap();
        write_session(&proj, S_A, "u-root", "修复登录 bug", "2026-08-20T10:00:00.000Z");
        write_session(&proj, S_B, "u-root", "修复登录 bug", "2026-08-21T09:00:00.000Z"); // 恢复：链键相同、更新
        write_session(&proj, S_C, "u-other", "写贪吃蛇", "2026-08-19T08:00:00.000Z");
        fs::write(proj.join("agent-xyz.jsonl"), "{}\n").unwrap(); // 必须被忽略

        let out = scan_projects(tmp.path());
        assert_eq!(out.len(), 1);
        let p = &out[0];
        assert_eq!(p.cwd, "/tmp/fake-proj");
        assert_eq!(p.threads.len(), 2, "A+B 应合并为一条链");
        let t0 = &p.threads[0]; // 降序第一 = 登录链
        assert_eq!(t0.root_key, "u-root");
        assert_eq!(t0.resume_session_id, S_B, "恢复目标必须是链上最新文件");
        assert_eq!(t0.file_count, 2);
        assert_eq!(p.threads[1].title, "写贪吃蛇");
    }

    #[test]
    fn empty_or_invalid_dirs_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("-empty")).unwrap();
        assert!(scan_projects(tmp.path()).is_empty());
        assert!(scan_projects(&tmp.path().join("nonexistent")).is_empty());
    }

    #[test]
    fn thread_info_carries_badge_fields() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("-tmp-demo");
        fs::create_dir_all(&proj).unwrap();
        // 文件名必须是合法 UUID stem（group_chain_files 靠 is_uuid_stem 过滤），
        // 与本文件其它测试的 S_A/S_B/S_C 命名约定一致。scan_projects_at 在本文件
        // 不存在，本文件既有的、接受调用方传入根目录的测试入口是 scan_projects
        // （见上面两个测试），因此改用它。
        let sid = "44444444-4444-4444-4444-444444444444";
        let line = format!(
            r#"{{"type":"assistant","effort":"max","permissionMode":"plan","timestamp":"2026-08-28T00:00:00Z","message":{{"role":"assistant","model":"claude-opus-5","content":[{{"type":"text","text":"预览文本"}}],"usage":{{"input_tokens":1,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":4}}}}}}"#
        );
        fs::write(proj.join(format!("{sid}.jsonl")), format!("{line}\n")).unwrap();

        let projects = scan_projects(dir.path());
        let t = &projects[0].threads[0];
        assert_eq!(t.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(t.context_tokens, Some(6));
        assert_eq!(t.preview.as_deref(), Some("预览文本"));
        assert_eq!(t.effort.as_deref(), Some("max"));
        assert_eq!(t.permission_mode.as_deref(), Some("plan"));
    }

    /// 只有 assistant 记录、没有任何 user 消息的会话文件——对应"新对话刚建、用户还
    /// 没发第一句话"。此时 parse_meta 取不到标题，ThreadInfo.titled 必须为 false。
    fn write_untitled_session(dir: &std::path::Path, sid: &str, ts: &str) {
        let l = format!(r#"{{"type":"assistant","uuid":"{sid}-a","timestamp":"{ts}","sessionId":"{sid}","cwd":"/tmp/fake-proj","message":{{"role":"assistant","model":"claude-opus-5"}}}}"#);
        fs::write(dir.join(format!("{sid}.jsonl")), format!("{l}\n")).unwrap();
    }

    #[test]
    fn session_ids_lists_whole_chain_in_time_order() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-tmp-fake-proj");
        fs::create_dir(&proj).unwrap();
        // 同一条链的两个文件：A 早、B 晚
        write_session(&proj, S_A, "u-root", "修复登录 bug", "2026-08-20T10:00:00.000Z");
        write_session(&proj, S_B, "u-root", "修复登录 bug", "2026-08-21T09:00:00.000Z");

        let out = scan_projects(tmp.path());
        let t = &out[0].threads[0];
        assert_eq!(t.session_ids, vec![S_A.to_string(), S_B.to_string()],
            "必须按时间升序列出链上全部 session id——前端靠它把自己指定的 id 映射回当前 root_key");
        assert_eq!(t.session_ids.len() as u32, t.file_count,
            "session_ids 与 file_count 必须同源，否则两者会各自漂移");
    }

    #[test]
    fn titled_false_when_chain_has_no_user_message() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-tmp-fake-proj");
        fs::create_dir(&proj).unwrap();
        write_untitled_session(&proj, S_C, "2026-08-22T10:00:00.000Z");

        let out = scan_projects(tmp.path());
        let t = &out[0].threads[0];
        assert_eq!(t.titled, false, "没有 user 消息就没有真实标题");
        assert_eq!(t.title, S_C.chars().take(8).collect::<String>(),
            "此时 title 是 session_id 前 8 位的回退值——前端必须靠 titled 才能分辨，不能采纳它");
        assert_eq!(t.session_ids, vec![S_C.to_string()]);
    }

    #[test]
    fn titled_true_when_chain_has_a_real_title() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-tmp-fake-proj");
        fs::create_dir(&proj).unwrap();
        write_session(&proj, S_A, "u-root", "修复登录 bug", "2026-08-20T10:00:00.000Z");

        let out = scan_projects(tmp.path());
        let t = &out[0].threads[0];
        assert_eq!(t.titled, true);
        assert_eq!(t.title, "修复登录 bug");
    }
}
