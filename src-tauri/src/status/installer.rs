//! hooks 安装器（spec §6）：把 aTerm 的 `Notification`/`Stop` 两个 hook 写入/移出用户的
//! `~/.claude/settings.json`。**这是本项目唯一会写 `~/.claude/` 内容的地方**——写入前
//! 备份、只做外科手术式的增删、任何解析失败或结构异常都放弃写入并原样保留原文件
//! （安装/卸载的写入逻辑在后续提交里补上；这个提交先落地 hook 命令本身的生成规则、
//! 事件文件的字段契约，以及只读的 `hooks_status()` 查询）。
//!
//! ## schema 核对来源（STEP 0，动手写代码前完成，勿凭记忆编造）
//!
//! 1. **官方文档** <https://code.claude.com/docs/en/hooks>（`docs.claude.com/.../hooks`
//!    301 重定向到这里）：`settings.json` 的 `hooks` 是一个对象，key 是事件名，value 是
//!    「匹配组」数组，每个匹配组是 `{ "matcher"?: string, "hooks": [ { "type": "command",
//!    "command": string, "args"?: [...], "timeout"?: number, ... } ] }`；文档明确指出
//!    `Notification`（Claude Code 发出通知时，含权限等待/idle 提示）与 `Stop`（Claude
//!    结束这一轮响应时）**都不支持 `matcher`**，官方给出的示例里这两个事件的匹配组直接
//!    省略 `matcher` 字段。
//! 2. **本机安装的 `claude` 2.1.246 可执行文件**（`~/.local/share/claude/versions/2.1.246`，
//!    Mach-O arm64，`strings -a` 核实，命令与产出见本次任务记录，不在此重复贴全部输出）：
//!    - 事件名字面量确实存在于二进制里：`PreToolUse`/`PostToolUse`/`Notification`/`Stop`/
//!      `SubagentStop`/`UserPromptSubmit`/`SessionStart`/`SessionEnd`/`PreCompact`——与文档
//!      列出的名字一致，`Notification`/`Stop` 拼写确认无误。
//!    - hook 输入 JSON 的字段名在反混淆前的源码片段里直接可见：
//!      `{session_id:e.id,transcript_path:gu(e.id),cwd:t,prompt_id:...,permission_mode:n,
//!      agent_id:r?.agentId,agent_type:o,effort:a}`，以及 Stop 专属分支
//!      `hook_event_name:"Stop",stop_hook_active:r,...,last_assistant_message:p`——
//!      确认字段是 snake_case 的 `session_id`（不是 `sessionId`），与文档一致。
//!    - hook 输入通过子进程的 **stdin** 写入，二进制里能看到
//!      `` G.stdin.write(r+`\n`) ``、错误兜底文案
//!      `"hook command likely exited without reading stdin"`，确认是"启动子进程后把 JSON
//!      写进它的 stdin"，不是环境变量、不是命令行参数。
//!    - `"command"` 类型的 hook 最终通过 Bun/Node 风格的 `child_process` 語意执行，
//!      二进制里能看到 `shell` 为真时 `file = "/bin/sh"; args = ["-c", command]` 的分支——
//!      确认 `command` 字段整体交给 `/bin/sh -c` 执行，因此可以写成一整行 POSIX shell
//!      语句（管道、子命令替换、`;` 分号连接语句均可用）。
//!
//! 结论：本模块生成的 hook 命令是标准 POSIX `/bin/sh` 单行脚本，只依赖 `cat`/`printf`/
//! `sed`/`date`/`mkdir`（macOS 系统自带，不引入任何新依赖），从 stdin 读取的 JSON 里用
//! `sed` 正则摘出 `"session_id":"..."` 的值（真实解析 JSON 需要 `jq`/`python3` 这类不保证
//! 一定装了的外部依赖，这里选择了"极小、免依赖"优先于"绝对严谨的 JSON 解析"，与 spec
//! 要求的"极小、免依赖 shell 单行"一致；已知的降级场景见 `build_hook_command` 上的文档）。

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// 嵌在生成的 shell 命令最前面的一条无副作用语句（POSIX shell 的 `:` 内建命令会原样
/// 丢弃它的参数、什么都不做、返回 0），只是用来在 `settings.json` 里给"这是 aTerm 装的
/// 哪一个 hook"打一个跨版本稳定的标记。之所以不能直接用整条命令字符串做身份判断：
/// spec 要求 `hooks_status()` 能区分"已安装但命令内容是旧版本"，这就意味着命令正文本身
/// 会随 aTerm 版本演进而变化，必须有一个独立于命令正文的稳定锚点。
const NOTIFICATION_MARKER: &str = "aterm-hook:notification:v1";
const STOP_MARKER: &str = "aterm-hook:stop:v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HookKind {
    Notification,
    Stop,
}

const ALL_HOOKS: [HookKind; 2] = [HookKind::Notification, HookKind::Stop];

impl HookKind {
    fn event_name(self) -> &'static str {
        match self {
            HookKind::Notification => "Notification",
            HookKind::Stop => "Stop",
        }
    }

    fn marker(self) -> &'static str {
        match self {
            HookKind::Notification => NOTIFICATION_MARKER,
            HookKind::Stop => STOP_MARKER,
        }
    }
}

/// 按 POSIX shell 单引号规则转义一段文本，用来把任意路径（含空格、单引号等特殊字符）
/// 安全地嵌进生成的 shell 命令里：整体用一对单引号包起来，文本内部出现的单引号自身换成
/// `'\''`（先用单引号结束当前引用、插入一个反斜杠转义的单引号字面量、再用单引号重新
/// 开始引用）——这是 shell 里转义单引号内容的标准写法，比双引号更安全（双引号仍会展开
/// `$`、`` ` ``、`\`，单引号不会）。
fn shell_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// 生成安装到 `settings.json` 里的 hook 命令正文（spec §5/§6）。
///
/// 效果：从 stdin 读取 Claude Code 传入的 hook 输入 JSON，摘出 `session_id`，追加一行
/// `{"event":"Notification"|"Stop","sessionId":"...","ts":<毫秒>}` 到
/// `hook_events_path`（父目录若不存在则创建），字段形状与 `status::hooks` 模块的读取器
/// （`parse_last_events_per_session`）逐字段对应——本文件底部的
/// `emitted_command_matches_reader_exactly` 测试真的起了一个 `/bin/sh` 子进程跑这条命令、
/// 把结果喂给那个读取器验证过。
///
/// 已知的启发式局限（可接受的降级，未使用外部 JSON 解析器）：
/// - 时间戳精度只到秒（`date +%s` 后补三个零凑成"毫秒"），而不是真毫秒——状态判定的
///   窗口是 5 秒量级（spec §4 `ACTIVE_WINDOW`），秒级精度足够，换真毫秒需要 GNU
///   `date +%N`（macOS 系统 `date` 是 BSD 版本，不支持 `%N`）或额外语言运行时，与
///   "免依赖"冲突，故不追求真毫秒。
/// - 用 `sed` 正则而非真正的 JSON 解析器摘取 `session_id`：如果 hook 输入 JSON 里某个
///   *其它*字段的值恰好包含字面量子串 `"session_id":"..."`（例如项目路径极端巧合地
///   包含这段文本），会摘到错的值。这在真实场景里概率可忽略；即便摘错，最坏结果也只是
///   一条被写入了错误 sessionId 的事件行，状态引擎那边找不到对应线程会静默丢弃（见
///   `status::watcher::EngineState::refresh_hooks` 的"未知 session 静默忽略"行为），
///   不会造成任何崩溃或状态错乱扩散。
fn build_hook_command(event: &str, marker: &str, hook_events_path: &Path) -> String {
    let file_str = hook_events_path.to_string_lossy();
    let dir_str = hook_events_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let marker_q = shell_single_quote(marker);
    let dir_q = shell_single_quote(&dir_str);
    let file_q = shell_single_quote(&file_str);

    let mut cmd = String::new();
    cmd.push_str(": ");
    cmd.push_str(&marker_q);
    cmd.push_str(
        "; d=\"$(cat)\"; s=\"$(printf '%s' \"$d\" | sed -n 's/.*\"session_id\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p')\"; t=$(( $(date +%s) * 1000 )); mkdir -p ",
    );
    cmd.push_str(&dir_q);
    cmd.push_str(" 2>/dev/null; printf '{\"event\":\"");
    cmd.push_str(event);
    cmd.push_str("\",\"sessionId\":\"%s\",\"ts\":%s}\\n' \"$s\" \"$t\" >> ");
    cmd.push_str(&file_q);
    cmd.push_str(" 2>/dev/null");
    cmd
}

// ---------------------------------------------------------------------------
// 状态查询：hooks_status()
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HookInstallState {
    pub installed: bool,
    pub up_to_date: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HooksStatus {
    pub notification: HookInstallState,
    pub stop: HookInstallState,
}

/// 在 `hooks.<event>` 这个匹配组数组里查找带有 `marker` 标记的那一条 `command`，返回
/// 它当前的完整命令文本（找不到、或路径上任何一层结构不是期望的类型，都返回
/// `None`——这个函数只用于只读的状态查询，从不因为结构异常而报错，宁可"当作未安装"）。
fn find_current_command(hooks_root: &Value, event: &str, marker: &str) -> Option<String> {
    let arr = hooks_root.get(event)?.as_array()?;
    for group in arr {
        let Some(items) = group.get("hooks").and_then(|h| h.as_array()) else { continue };
        for item in items {
            if let Some(cmd) = item.get("command").and_then(|c| c.as_str()) {
                if cmd.contains(marker) {
                    return Some(cmd.to_string());
                }
            }
        }
    }
    None
}

pub fn hooks_status_at(settings_path: &Path, hook_events_path: &Path) -> HooksStatus {
    let hooks_root = std::fs::read_to_string(settings_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("hooks").cloned());

    let Some(hooks_root) = hooks_root else {
        return HooksStatus::default();
    };

    let mut status = HooksStatus::default();
    for kind in ALL_HOOKS {
        let expected = build_hook_command(kind.event_name(), kind.marker(), hook_events_path);
        let state = match find_current_command(&hooks_root, kind.event_name(), kind.marker()) {
            Some(current) => HookInstallState { installed: true, up_to_date: current == expected },
            None => HookInstallState::default(),
        };
        match kind {
            HookKind::Notification => status.notification = state,
            HookKind::Stop => status.stop = state,
        }
    }
    status
}

// ---------------------------------------------------------------------------
// 真实路径解析 + Tauri 命令（薄封装：可测试的逻辑都在上面的 `hooks_status_at` 里）
// ---------------------------------------------------------------------------

struct RealPaths {
    settings_path: PathBuf,
    hook_events_path: PathBuf,
}

/// 与 `status::watcher::start` 里推导 `hook_events_path` 的逻辑保持同一套来源
/// （`dirs::data_dir().join("aTerm")`），两处如果分叉，hook 命令写的文件和状态引擎读的
/// 文件就会对不上——这里特意不做路径规范化（`canonicalize`）：写入 `settings.json` 时
/// 只是把这个路径当一段文本嵌进 shell 命令，不需要解析符号链接（watcher.rs 需要规范化
/// 是因为要拿去和 FSEvents 报告的路径做 `starts_with` 比较，这里没有这个需求）。
fn real_paths() -> Result<RealPaths, String> {
    let home = dirs::home_dir().ok_or_else(|| "找不到用户主目录，无法定位 ~/.claude/settings.json。".to_string())?;
    let settings_path = home.join(".claude").join("settings.json");
    let app_data =
        dirs::data_dir().map(|d| d.join("aTerm")).ok_or_else(|| "找不到 aTerm 的应用数据目录。".to_string())?;
    let hook_events_path = app_data.join("hook-events.jsonl");
    Ok(RealPaths { settings_path, hook_events_path })
}

/// 查询 aTerm 的两个 hook 是否已安装、是否与当前版本生成的命令一致。只读，从不写入；
/// `settings.json` 缺失/不可解析时视为"未安装"而不是报错——这是一个状态查询命令，没有
/// 数据可能被破坏的风险，没必要用 `Result` 把这种情况当错误传给前端。
#[tauri::command]
pub fn hooks_status() -> HooksStatus {
    match real_paths() {
        Ok(p) => hooks_status_at(&p.settings_path, &p.hook_events_path),
        Err(_) => HooksStatus::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    // -----------------------------------------------------------------
    // 生成的 hook 命令字符串，必须能被 status/hooks.rs 的读取器原样解析
    // -----------------------------------------------------------------

    /// 端到端：真的起一个 `/bin/sh` 子进程执行生成的命令（用真实的 Claude Code hook 输入
    /// JSON 样例喂它的 stdin），再把落盘结果交给 `status::hooks::parse_last_events_per_session`
    /// 解析——证明"这个命令写出来的行，就是状态引擎读取器认识的那种行"，不是靠人工比对
    /// 字符串猜的。
    #[test]
    fn emitted_command_matches_reader_exactly() {
        use super::super::engine::HookEventKind;

        let cases = [(HookKind::Notification, HookEventKind::Notification), (HookKind::Stop, HookEventKind::Stop)];
        for (kind, expected_event_kind) in cases {
            // 每个 case 独立的临时文件：避免"后写的事件覆盖先写的"这条读取器规则
            // （见 status/hooks.rs 的 last_event_per_session_wins_by_file_order）掩盖掉
            // 某一个 case 本该失败却被覆盖过去的问题。
            let tmp = tempfile::tempdir().unwrap();
            let hook_events_path = tmp.path().join("aTerm").join("hook-events.jsonl");
            let cmd = build_hook_command(kind.event_name(), kind.marker(), &hook_events_path);

            // 模拟 Claude Code 真实喂给 hook 的 stdin（字段名、取值都对照 STEP 0 核实到的
            // 真实 schema：session_id 是 snake_case）。
            let stdin_json = format!(
                r#"{{"session_id":"11111111-1111-1111-1111-111111111111","transcript_path":"/tmp/x.jsonl","cwd":"/tmp","permission_mode":"default","hook_event_name":"{}"}}"#,
                kind.event_name()
            );

            let mut child = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(&cmd)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("启动 /bin/sh 应成功");
            child.stdin.take().unwrap().write_all(stdin_json.as_bytes()).unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success(), "生成的命令应以 0 退出：stderr={}", String::from_utf8_lossy(&output.stderr));

            let events = crate::status::hooks::read_last_events_per_session(&hook_events_path);
            let event = events.get("11111111-1111-1111-1111-111111111111").expect("应解析出这个 session 的事件");
            assert_eq!(event.signal.kind, expected_event_kind);
        }
    }

    #[test]
    fn build_hook_command_quotes_paths_containing_spaces() {
        let tmp = tempfile::tempdir().unwrap();
        let dir_with_space = tmp.path().join("Application Support").join("aTerm");
        let hook_events_path = dir_with_space.join("hook-events.jsonl");

        let cmd = build_hook_command("Notification", NOTIFICATION_MARKER, &hook_events_path);

        let stdin_json = r#"{"session_id":"s1"}"#;
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&cmd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stdin_json.as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "路径带空格时也应成功执行：stderr={}", String::from_utf8_lossy(&output.stderr));
        assert!(hook_events_path.exists(), "应该在带空格的路径下正确创建文件");
    }
}
