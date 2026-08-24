use super::parser::{parse_meta, read_head_lines, read_tail_lines};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub root_key: String,
    pub resume_session_id: String,
    pub title: String,
    pub cwd: String,
    pub last_activity_ms: i64,
    pub file_count: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub dir_name: String,
    pub cwd: String,
    pub last_activity_ms: i64,
    pub threads: Vec<ThreadInfo>,
}

fn is_uuid_stem(stem: &str) -> bool {
    stem.len() == 36 && stem.chars().filter(|c| *c == '-').count() == 4
        && stem.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

struct FileMeta { session_id: String, meta: super::parser::ParsedMeta, mtime_ms: i64 }

pub fn scan_projects(projects_dir: &Path) -> Vec<ProjectInfo> {
    let Ok(entries) = std::fs::read_dir(projects_dir) else { return vec![] };
    let mut projects: Vec<ProjectInfo> = vec![];
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() { continue; }
        let mut files: Vec<FileMeta> = vec![];
        let Ok(inner) = std::fs::read_dir(&dir) else { continue };
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
            files.push(FileMeta { session_id: stem.to_string(), meta: parse_meta(&head, &tail), mtime_ms });
        }
        if files.is_empty() { continue; }

        let mut groups: std::collections::HashMap<String, Vec<&FileMeta>> = Default::default();
        for fm in &files {
            let key = fm.meta.first_user_uuid.clone().unwrap_or_else(|| fm.session_id.clone());
            groups.entry(key).or_default().push(fm);
        }
        let mut threads: Vec<ThreadInfo> = groups.into_iter().map(|(key, mut fs)| {
            fs.sort_by_key(|fm| fm.meta.last_ts_ms.unwrap_or(fm.mtime_ms));
            let newest = fs.last().unwrap();
            let title = fs.iter().rev().find_map(|fm| fm.meta.title.clone())
                .unwrap_or_else(|| newest.session_id.chars().take(8).collect());
            let cwd = fs.iter().rev().find_map(|fm| fm.meta.cwd.clone()).unwrap_or_default();
            ThreadInfo {
                root_key: key,
                resume_session_id: newest.session_id.clone(),
                title, cwd,
                last_activity_ms: newest.meta.last_ts_ms.unwrap_or(newest.mtime_ms),
                file_count: fs.len() as u32,
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
}
