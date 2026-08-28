//! hooks 安装器（spec §6）：把 aTerm 的 `Notification`/`Stop` 两个 hook 写入/移出用户的
//! `~/.claude/settings.json`。**这是本项目唯一会写 `~/.claude/` 内容的地方**——写入前
//! 备份、只做外科手术式的增删、任何解析失败或结构异常都放弃写入并原样保留原文件。
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
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// 嵌在生成的 shell 命令最前面的一条无副作用语句（POSIX shell 的 `:` 内建命令会原样
/// 丢弃它的参数、什么都不做、返回 0），只是用来在 `settings.json` 里给"这是 aTerm 装的
/// 哪一个 hook"打一个跨版本稳定的标记。之所以不能直接用整条命令字符串做身份判断：
/// spec 要求 `hooks_status()` 能区分"已安装但命令内容是旧版本"，这就意味着命令正文本身
/// 会随 aTerm 版本演进而变化，必须有一个独立于命令正文的稳定锚点。
const NOTIFICATION_MARKER: &str = "aterm-hook:notification:v1";
const STOP_MARKER: &str = "aterm-hook:stop:v1";

/// 每个 hook 的执行超时（秒）。真正的"绝不挂起 Claude Code"保证来自 Claude Code 自己
/// 对 hook 子进程强制执行的这个超时（官方文档字段），不是寄希望于我们的 shell 单行脚本
/// 永远不会卡住——命令本身也已经尽量选用不会阻塞的操作（见 build_hook_command 文档）。
const HOOK_TIMEOUT_SECS: u64 = 5;

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

fn expected_hook_object(event: &str, marker: &str, hook_events_path: &Path) -> Value {
    json!({
        "type": "command",
        "command": build_hook_command(event, marker, hook_events_path),
        "timeout": HOOK_TIMEOUT_SECS,
    })
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
// settings.json 读取/写入的公共部分
// ---------------------------------------------------------------------------

/// 读取并解析 `settings.json`：文件缺失、内容不是合法 JSON、顶层不是 JSON 对象，
/// 三种情况都返回带清晰中文说明的 `Err`，调用方据此直接放弃、不做任何写入——
/// spec §6/§10 的"解析失败或结构异常时放弃写入并提示，绝不覆盖用户配置"在这里是
/// 唯一的把关点，`install_hooks_at`/`uninstall_hooks_at` 都先过这一步再谈后续。
fn load_settings(settings_path: &Path) -> Result<Value, String> {
    let content = std::fs::read_to_string(settings_path).map_err(|_| {
        format!(
            "找不到 {}，请先启动一次 Claude Code 让它生成这个文件，或手动创建后重试；未做任何修改。",
            settings_path.display()
        )
    })?;
    let value: Value = serde_json::from_str(&content).map_err(|e| {
        format!(
            "{} 不是合法的 JSON（{e}），为避免损坏你的配置已放弃写入；文件未被改动。",
            settings_path.display()
        )
    })?;
    if !value.is_object() {
        return Err(format!(
            "{} 的顶层结构不是 JSON 对象，为避免损坏你的配置已放弃写入；文件未被改动。",
            settings_path.display()
        ));
    }
    Ok(value)
}

fn write_settings(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| format!("序列化配置失败：{e}"))?;
    // 写临时文件再 rename：与 `status::hooks::rotate_if_needed` 同一个"绝不让并发读者
    // 看到写了一半的文件"的理由，这里的读者是 Claude Code 自己（它随时可能在会话之间
    // 重新读取 settings.json）。
    let tmp = path.with_extension("json.aterm-write.tmp");
    std::fs::write(&tmp, format!("{text}\n")).map_err(|e| format!("写入临时文件失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换 {} 失败：{e}", path.display()))?;
    Ok(())
}

/// 写入前备份（spec §6 硬性要求）：把当前的 `settings.json` 原样拷贝到 aTerm 自己的
/// 数据目录，文件名带纳秒级时间戳（保证同一进程内连续两次调用也不会撞名，比毫秒级
/// 时间戳更保险；aTerm 数据目录本就在 `~/.claude/` 之外，写这里不违反"`~/.claude/`
/// 只能通过 install/uninstall 写 settings.json 本身"的约束）。
fn backup_settings(settings_path: &Path, backup_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(backup_dir).map_err(|e| format!("创建备份目录 {} 失败：{e}", backup_dir.display()))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let backup_path = backup_dir.join(format!("settings.json.{nanos}.bak"));
    std::fs::copy(settings_path, &backup_path)
        .map_err(|e| format!("备份 {} 失败，已放弃写入：{e}", settings_path.display()))?;
    Ok(backup_path)
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub backup_path: String,
}

/// 在一个 `hooks.<event>` 数组里就地更新/插入 marker 对应的那一条 hook：
/// - 找到已有的（带 marker 的）命令：原地替换成最新的期望内容（"更新而不重复追加"）
/// - 顺带清理任何多余的重复项（历史遗留 bug 或手工编辑造成的多份同 marker 条目），
///   保证幂等——不管调用前是 0 条还是意外有多条，调用后都精确收敛到 1 条
/// - 都没有：在数组末尾追加一个新的匹配组
///
/// 结构异常（`hooks.<event>` 存在但不是数组）直接返回 `Err`，不做任何修改——由调用方
/// （`install_hooks_at`）保证这个 `Err` 会让整个安装流程在触碰磁盘之前就中止。
fn upsert_hook(hooks_obj: &mut Map<String, Value>, kind: HookKind, hook_events_path: &Path) -> Result<(), String> {
    let event = kind.event_name();
    let marker = kind.marker();
    let expected = expected_hook_object(event, marker, hook_events_path);

    let entry = hooks_obj.entry(event.to_string()).or_insert_with(|| Value::Array(Vec::new()));
    let arr = match entry {
        Value::Array(a) => a,
        _ => {
            return Err(format!(
                "settings.json 的 hooks.{event} 字段不是预期的数组结构，为避免损坏你的配置已放弃写入；文件未被改动。"
            ))
        }
    };

    let mut already_updated = false;
    let mut i = 0;
    while i < arr.len() {
        let mut drop_group = false;
        if let Some(group_obj) = arr[i].as_object_mut() {
            if let Some(items) = group_obj.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                let mut j = 0;
                while j < items.len() {
                    let is_ours =
                        items[j].get("command").and_then(|c| c.as_str()).map(|c| c.contains(marker)).unwrap_or(false);
                    if is_ours {
                        if !already_updated {
                            items[j] = expected.clone();
                            already_updated = true;
                            j += 1;
                        } else {
                            // 多余的重复项：直接移除，不保留。
                            items.remove(j);
                        }
                    } else {
                        j += 1;
                    }
                }
                if items.is_empty() {
                    drop_group = true;
                }
            }
        }
        if drop_group {
            arr.remove(i);
        } else {
            i += 1;
        }
    }

    if !already_updated {
        arr.push(json!({ "hooks": [expected] }));
    }
    Ok(())
}

/// 安装/更新 aTerm 的 `Notification`/`Stop` 两个 hook（spec §6）。
///
/// 路径全部由调用方注入（不在函数内部访问 `dirs::home_dir()`），是唯一让这个函数能被
/// 单元测试安全覆盖的原因——测试传入 `tempfile::tempdir()` 里的路径，永远不会碰真实的
/// `~/.claude`；只有 `install_hooks()`（`#[tauri::command]`）这一层薄封装会用真实路径调用它。
pub fn install_hooks_at(settings_path: &Path, backup_dir: &Path, hook_events_path: &Path) -> Result<InstallOutcome, String> {
    let mut value = load_settings(settings_path)?;
    {
        // `load_settings` 已经确认顶层是对象，这里的 `unwrap` 不会失败。
        let root = value.as_object_mut().expect("load_settings 已确认顶层是对象");
        let hooks_val = root.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
        let hooks_obj = match hooks_val {
            Value::Object(m) => m,
            _ => {
                return Err(
                    "settings.json 的 hooks 字段不是预期的对象结构，为避免损坏你的配置已放弃写入；文件未被改动。"
                        .to_string(),
                )
            }
        };
        for kind in ALL_HOOKS {
            upsert_hook(hooks_obj, kind, hook_events_path)?;
        }
    }

    // 所有校验与内存中的修改都已成功才走到这里——磁盘上的文件到此刻为止还完全没被
    // 碰过；任何一步失败都已经在上面 `?` 处直接返回，文件保持原样。
    let backup_path = backup_settings(settings_path, backup_dir)?;
    write_settings(settings_path, &value)?;
    Ok(InstallOutcome { backup_path: backup_path.to_string_lossy().to_string() })
}

// ---------------------------------------------------------------------------
// 卸载
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallOutcome {
    pub backup_path: String,
    /// 是否真的移除了点什么（两个 hook 都没装过时也会走一遍备份+回写流程，但这个字段
    /// 会是 `false`，供前端判断"其实本来就没装"）。
    pub removed: bool,
}

/// 从一个 `hooks.<event>` 数组里移除带 marker 的那一条 hook，并剪掉因此变空的容器：
/// 命令被移除后其所在匹配组的 `hooks` 数组若变空，整个匹配组一并移除；调用方
/// （`uninstall_hooks_at`）还会在两个事件都处理完后检查 `hooks` 对象本身是否也已经
/// 变空，变空则连 `hooks` 这个 key 一起删掉——不留下任何"我们创建过但现在完全空了"
/// 的容器。结构异常（`hooks.<event>` 存在但不是数组）同样直接 `Err`，不做任何修改。
fn remove_hook(hooks_obj: &mut Map<String, Value>, kind: HookKind) -> Result<bool, String> {
    let event = kind.event_name();
    let marker = kind.marker();
    let Some(entry) = hooks_obj.get_mut(event) else { return Ok(false) };
    let arr = match entry {
        Value::Array(a) => a,
        _ => {
            return Err(format!(
                "settings.json 的 hooks.{event} 字段不是预期的数组结构，为避免损坏你的配置已放弃写入；文件未被改动。"
            ))
        }
    };

    let mut removed = false;
    let mut i = 0;
    while i < arr.len() {
        let mut drop_group = false;
        if let Some(group_obj) = arr[i].as_object_mut() {
            if let Some(items) = group_obj.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                let before = items.len();
                items.retain(|item| {
                    let is_ours =
                        item.get("command").and_then(|c| c.as_str()).map(|c| c.contains(marker)).unwrap_or(false);
                    !is_ours
                });
                if items.len() != before {
                    removed = true;
                }
                if items.is_empty() {
                    drop_group = true;
                }
            }
        }
        if drop_group {
            arr.remove(i);
        } else {
            i += 1;
        }
    }

    if arr.is_empty() {
        hooks_obj.remove(event);
    }
    Ok(removed)
}

pub fn uninstall_hooks_at(settings_path: &Path, backup_dir: &Path) -> Result<UninstallOutcome, String> {
    let mut value = load_settings(settings_path)?;
    let mut removed_any = false;
    {
        let root = value.as_object_mut().expect("load_settings 已确认顶层是对象");
        if let Some(hooks_val) = root.get_mut("hooks") {
            let hooks_obj = match hooks_val {
                Value::Object(m) => m,
                _ => {
                    return Err(
                        "settings.json 的 hooks 字段不是预期的对象结构，为避免损坏你的配置已放弃写入；文件未被改动。"
                            .to_string(),
                    )
                }
            };
            for kind in ALL_HOOKS {
                if remove_hook(hooks_obj, kind)? {
                    removed_any = true;
                }
            }
            if hooks_obj.is_empty() {
                root.remove("hooks");
            }
        }
    }

    let backup_path = backup_settings(settings_path, backup_dir)?;
    write_settings(settings_path, &value)?;
    Ok(UninstallOutcome { backup_path: backup_path.to_string_lossy().to_string(), removed: removed_any })
}

// ---------------------------------------------------------------------------
// 真实路径解析 + Tauri 命令（薄封装：所有可测试的逻辑都在上面的 `_at` 函数里）
// ---------------------------------------------------------------------------

struct RealPaths {
    settings_path: PathBuf,
    backup_dir: PathBuf,
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
    let backup_dir = app_data.join("settings-backups");
    let hook_events_path = app_data.join("hook-events.jsonl");
    Ok(RealPaths { settings_path, backup_dir, hook_events_path })
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

/// 安装/更新 aTerm 的两个 hook。**只应在用户显式点击"安装"之后被前端调用**——本函数
/// （以及它调用的 `install_hooks_at`）不会被应用启动流程或任何其它命令隐式触发。
#[tauri::command]
pub fn install_hooks() -> Result<InstallOutcome, String> {
    let p = real_paths()?;
    install_hooks_at(&p.settings_path, &p.backup_dir, &p.hook_events_path)
}

/// 卸载 aTerm 安装的两个 hook，只应在用户显式点击"卸载"之后被前端调用。
#[tauri::command]
pub fn uninstall_hooks() -> Result<UninstallOutcome, String> {
    let p = real_paths()?;
    uninstall_hooks_at(&p.settings_path, &p.backup_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    struct Fixture {
        _tmp: tempfile::TempDir,
        settings_path: PathBuf,
        backup_dir: PathBuf,
        hook_events_path: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let settings_path = tmp.path().join("settings.json");
        let backup_dir = tmp.path().join("aTerm").join("settings-backups");
        let hook_events_path = tmp.path().join("aTerm").join("hook-events.jsonl");
        Fixture { _tmp: tmp, settings_path, backup_dir, hook_events_path }
    }

    fn write_settings_fixture(f: &Fixture, content: &str) {
        std::fs::write(&f.settings_path, content).unwrap();
    }

    fn read_settings(f: &Fixture) -> Value {
        let text = std::fs::read_to_string(&f.settings_path).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    // -----------------------------------------------------------------
    // 全新安装
    // -----------------------------------------------------------------

    #[test]
    fn fresh_install_adds_both_hooks_when_no_hooks_key_exists() {
        let f = fixture();
        write_settings_fixture(&f, r#"{"model":"claude-fable-5","theme":"light"}"#);

        let outcome = install_hooks_at(&f.settings_path, &f.backup_dir, &f.hook_events_path).unwrap();
        assert!(Path::new(&outcome.backup_path).exists());

        let v = read_settings(&f);
        assert_eq!(v["model"], "claude-fable-5", "无关的既有 key 必须原样保留");
        assert_eq!(v["theme"], "light");

        for event in ["Notification", "Stop"] {
            let arr = v["hooks"][event].as_array().expect("应生成数组");
            assert_eq!(arr.len(), 1, "应恰好一个匹配组");
            let items = arr[0]["hooks"].as_array().unwrap();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0]["type"], "command");
            let cmd = items[0]["command"].as_str().unwrap();
            assert!(cmd.contains(&f.hook_events_path.to_string_lossy().to_string()));
            assert!(!arr[0].as_object().unwrap().contains_key("matcher"), "Notification/Stop 不应带 matcher 字段");
        }

        let status = hooks_status_at(&f.settings_path, &f.hook_events_path);
        assert_eq!(status.notification, HookInstallState { installed: true, up_to_date: true });
        assert_eq!(status.stop, HookInstallState { installed: true, up_to_date: true });
    }

    // -----------------------------------------------------------------
    // 已有其它工具的 hooks：必须原样保留
    // -----------------------------------------------------------------

    #[test]
    fn install_preserves_unrelated_existing_hooks() {
        let f = fixture();
        write_settings_fixture(
            &f,
            r#"{
                "hooks": {
                    "PreToolUse": [
                        { "matcher": "Bash", "hooks": [ { "type": "command", "command": "some-other-tool --check" } ] }
                    ],
                    "Stop": [
                        { "hooks": [ { "type": "command", "command": "echo other-stop-hook" } ] }
                    ]
                }
            }"#,
        );

        install_hooks_at(&f.settings_path, &f.backup_dir, &f.hook_events_path).unwrap();
        let v = read_settings(&f);

        // 无关的 PreToolUse 原样保留。
        let pre = &v["hooks"]["PreToolUse"];
        assert_eq!(pre[0]["matcher"], "Bash");
        assert_eq!(pre[0]["hooks"][0]["command"], "some-other-tool --check");

        // 别人的 Stop hook 也在，且是独立的一条（不同的匹配组）。
        let stop_arr = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop_arr.len(), 2, "别人的 Stop 匹配组 + aTerm 自己新增的匹配组");
        let has_other = stop_arr.iter().any(|g| {
            g["hooks"].as_array().unwrap().iter().any(|h| h["command"] == "echo other-stop-hook")
        });
        assert!(has_other, "别人的 Stop hook 必须还在");
        let has_ours =
            stop_arr.iter().any(|g| g["hooks"].as_array().unwrap().iter().any(|h| {
                h["command"].as_str().map(|c| c.contains(STOP_MARKER)).unwrap_or(false)
            }));
        assert!(has_ours, "aTerm 自己的 Stop hook 必须被加上");

        // Notification 之前不存在，应该被新建。
        assert!(v["hooks"]["Notification"].as_array().unwrap().len() == 1);
    }

    // -----------------------------------------------------------------
    // 幂等：装两次不重复
    // -----------------------------------------------------------------

    #[test]
    fn installing_twice_is_idempotent_no_duplicates() {
        let f = fixture();
        write_settings_fixture(&f, r#"{"foo":"bar"}"#);

        install_hooks_at(&f.settings_path, &f.backup_dir, &f.hook_events_path).unwrap();
        install_hooks_at(&f.settings_path, &f.backup_dir, &f.hook_events_path).unwrap();

        let v = read_settings(&f);
        for event in ["Notification", "Stop"] {
            let arr = v["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "两次安装后仍应只有一个匹配组");
            assert_eq!(arr[0]["hooks"].as_array().unwrap().len(), 1, "两次安装后仍应只有一条 hook 命令");
        }
    }

    #[test]
    fn install_updates_stale_command_in_place_without_duplicating() {
        let f = fixture();
        // 手工构造一个"旧版本" aTerm 曾经装过的 hook（命令正文不同，但带着同一个 marker）。
        let stale_cmd = format!(": '{NOTIFICATION_MARKER}'; echo old-version-command");
        write_settings_fixture(
            &f,
            &format!(
                r#"{{"hooks":{{"Notification":[{{"hooks":[{{"type":"command","command":"{stale_cmd}"}}]}}]}}}}"#
            ),
        );

        let status_before = hooks_status_at(&f.settings_path, &f.hook_events_path);
        assert_eq!(status_before.notification, HookInstallState { installed: true, up_to_date: false });

        install_hooks_at(&f.settings_path, &f.backup_dir, &f.hook_events_path).unwrap();

        let v = read_settings(&f);
        let arr = v["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "更新旧命令不应产生第二个匹配组");
        assert_eq!(arr[0]["hooks"].as_array().unwrap().len(), 1);
        let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(!cmd.contains("old-version-command"), "旧命令正文应被替换");

        let status_after = hooks_status_at(&f.settings_path, &f.hook_events_path);
        assert_eq!(status_after.notification, HookInstallState { installed: true, up_to_date: true });
    }

    // -----------------------------------------------------------------
    // 卸载
    // -----------------------------------------------------------------

    #[test]
    fn uninstall_removes_ours_and_leaves_others_intact() {
        let f = fixture();
        write_settings_fixture(
            &f,
            r#"{
                "hooks": {
                    "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "keep-me" } ] } ],
                    "Stop": [ { "hooks": [ { "type": "command", "command": "echo other-stop-hook" } ] } ]
                }
            }"#,
        );
        install_hooks_at(&f.settings_path, &f.backup_dir, &f.hook_events_path).unwrap();

        let outcome = uninstall_hooks_at(&f.settings_path, &f.backup_dir).unwrap();
        assert!(outcome.removed);

        let v = read_settings(&f);
        // 无关配置原样保留。
        assert_eq!(v["hooks"]["PreToolUse"][0]["hooks"][0]["command"], "keep-me");
        let stop_arr = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop_arr.len(), 1, "aTerm 的匹配组应被移除，只剩别人的那一组");
        assert_eq!(stop_arr[0]["hooks"][0]["command"], "echo other-stop-hook");

        // Notification 是 aTerm 独占新建的，卸载后整个 key 应该被剪掉。
        assert!(v["hooks"].get("Notification").is_none(), "空容器应被剪掉");

        let status = hooks_status_at(&f.settings_path, &f.hook_events_path);
        assert_eq!(status.notification, HookInstallState::default());
        assert_eq!(status.stop, HookInstallState::default());
    }

    #[test]
    fn uninstall_prunes_hooks_key_entirely_when_nothing_else_remains() {
        let f = fixture();
        write_settings_fixture(&f, r#"{"other":"value"}"#);
        install_hooks_at(&f.settings_path, &f.backup_dir, &f.hook_events_path).unwrap();
        uninstall_hooks_at(&f.settings_path, &f.backup_dir).unwrap();

        let v = read_settings(&f);
        assert_eq!(v["other"], "value");
        assert!(v.as_object().unwrap().get("hooks").is_none(), "hooks 这个 key 本身也应该被剪掉");
    }

    #[test]
    fn uninstall_when_nothing_installed_is_a_harmless_noop() {
        let f = fixture();
        write_settings_fixture(&f, r#"{"other":"value"}"#);
        let outcome = uninstall_hooks_at(&f.settings_path, &f.backup_dir).unwrap();
        assert!(!outcome.removed);
        let v = read_settings(&f);
        assert_eq!(v["other"], "value");
    }

    // -----------------------------------------------------------------
    // 失败安全：解析失败 / 结构异常一律中止，且文件字节级不变
    // -----------------------------------------------------------------

    #[test]
    fn unparseable_settings_json_aborts_and_leaves_file_byte_identical() {
        let f = fixture();
        let original = "{ this is not valid json ";
        write_settings_fixture(&f, original);

        let err = install_hooks_at(&f.settings_path, &f.backup_dir, &f.hook_events_path).unwrap_err();
        assert!(!err.is_empty());
        let after = std::fs::read_to_string(&f.settings_path).unwrap();
        assert_eq!(after, original, "解析失败时文件必须字节级保持原样");
        assert!(!f.backup_dir.exists(), "从未成功到需要备份的那一步，不应该创建备份目录");
    }

    #[test]
    fn top_level_non_object_aborts_and_leaves_file_byte_identical() {
        let f = fixture();
        let original = r#"["not", "an", "object"]"#;
        write_settings_fixture(&f, original);

        let err = install_hooks_at(&f.settings_path, &f.backup_dir, &f.hook_events_path).unwrap_err();
        assert!(!err.is_empty());
        let after = std::fs::read_to_string(&f.settings_path).unwrap();
        assert_eq!(after, original);
    }

    #[test]
    fn hooks_field_wrong_shape_aborts_and_leaves_file_byte_identical() {
        let f = fixture();
        let original = r#"{"hooks":"not-an-object"}"#;
        write_settings_fixture(&f, original);

        let err = install_hooks_at(&f.settings_path, &f.backup_dir, &f.hook_events_path).unwrap_err();
        assert!(!err.is_empty());
        let after = std::fs::read_to_string(&f.settings_path).unwrap();
        assert_eq!(after, original);
    }

    #[test]
    fn hooks_event_field_wrong_shape_aborts_and_leaves_file_byte_identical() {
        let f = fixture();
        let original = r#"{"hooks":{"Notification":"not-an-array"}}"#;
        write_settings_fixture(&f, original);

        let err = install_hooks_at(&f.settings_path, &f.backup_dir, &f.hook_events_path).unwrap_err();
        assert!(!err.is_empty());
        let after = std::fs::read_to_string(&f.settings_path).unwrap();
        assert_eq!(after, original);

        // 卸载同样要中止，同样不改文件。
        let err2 = uninstall_hooks_at(&f.settings_path, &f.backup_dir).unwrap_err();
        assert!(!err2.is_empty());
        let after2 = std::fs::read_to_string(&f.settings_path).unwrap();
        assert_eq!(after2, original);
    }

    #[test]
    fn missing_settings_file_returns_clear_error_and_creates_nothing() {
        let f = fixture();
        // 故意不写 settings_path 本身。

        let err = install_hooks_at(&f.settings_path, &f.backup_dir, &f.hook_events_path).unwrap_err();
        assert!(!err.is_empty());
        assert!(!f.settings_path.exists(), "不应该凭空创建 settings.json");
        assert!(!f.backup_dir.exists(), "不应该创建备份目录");

        let status = hooks_status_at(&f.settings_path, &f.hook_events_path);
        assert_eq!(status, HooksStatus::default(), "settings.json 缺失时状态查询应视为未安装，而不是报错");
    }

    // -----------------------------------------------------------------
    // 备份确实先于修改发生
    // -----------------------------------------------------------------

    #[test]
    fn backup_is_written_before_modification_and_contains_original_content() {
        let f = fixture();
        let original = r#"{"model":"claude-fable-5"}"#;
        write_settings_fixture(&f, original);

        let outcome = install_hooks_at(&f.settings_path, &f.backup_dir, &f.hook_events_path).unwrap();
        let backup_content = std::fs::read_to_string(&outcome.backup_path).unwrap();
        assert_eq!(backup_content, original, "备份必须是修改前的原始内容");

        let live_content = std::fs::read_to_string(&f.settings_path).unwrap();
        assert_ne!(live_content, original, "备份之后才应该发生真正的修改");
    }

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
