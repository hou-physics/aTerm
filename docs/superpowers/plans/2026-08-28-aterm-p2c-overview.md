# aTerm P2c 总览方块页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一屏可拖拽的方块实时呈现某个项目下所有 Claude 会话的状态、进度与关键元信息。

**Architecture:** Rust 侧在既有的头尾 bounded 解析中顺带提取徽章数据（模型、上下文 tokens、预览行、effort、权限模式），并新增一个**独立的、带增量缓存的 sub-agent 计数模块**——它是唯一需要整读文件的路径，因此不参与首屏、只在后台补齐徽章。前端新增 `overview` 标签种类、一个纯函数布局模块、方块组件与常驻底部状态栏；方块位置与重命名持久化在 localStorage，沿用主题 store 既有写法。

**Tech Stack:** Rust（serde / chrono / tempfile）、React 19 + zustand、vitest + @testing-library/react、cargo test

**Spec:** `docs/superpowers/specs/2026-08-24-aterm-design.md`（§5.2 总览页、§5.3 方块规格、§12 分期表 P2 行）

## Global Constraints

- `~/.claude/` **全程只读**；本期不新增任何写入 `~/.claude/` 的代码（唯一已存在的例外是 hooks 安装器）。
- **不整读 transcript**：头 ≤ 40 行 / 256KB，尾 ≤ 64KB。唯一例外是 Task 3 的 sub-agent 计数，它带增量缓存、在后台执行，且**不得**被放进首屏路径。
- **绝不按 `"tool_use"` 子串过滤行**。实测该过滤会丢失约 5%（24k 字符）真实正文。
- 测试**不得触碰真实 `~/.claude`**，一律使用 tempfile 临时目录。
- 上下文徽章**显示绝对值**（如 `上下文 107k`），**不显示百分比**：上下文窗口大小无法从 transcript 还原（记录中 `message.model` 为 `claude-opus-5`，不含 `[1m]` 后缀；`context_management` 与 `quotaLimits` 均不含窗口大小），猜测的百分比会误导。
- 所有颜色取自主题 CSS 变量，**不硬编码色值**。
- **本仓库未安装 jest-dom**：断言一律用 `expect(x).toBeTruthy()` / `expect(x).toBeNull()` / `expect(el?.classList.contains('c')).toBe(true)`，不要用 `toBeInTheDocument` / `toHaveClass` / `toHaveValue`（Task 6 实测：计划原稿用了这些匹配器，实现者必须重写）。
- 状态 store 条目的时间字段名是 `updatedAtMs`，不是 `updatedMs`。
- 复用既有实现，不重造：`src/time.ts` 的 `formatRelative`、`src/components/StatusDot.tsx`（已含转圈动画与 `prefers-reduced-motion` 处理）。
- 拖拽类状态沿用项目既有的两动作范式：拖拽过程中 `setX` 只改内存，`pointerup` 时 `commitX` 才持久化；读取持久值的路径上做钳制。
- 子代理模型：**不得使用 fable**。

## 已确认的 transcript 字段（实测，勿凭记忆改写）

| 字段 | 位置 | 实测值示例 |
|---|---|---|
| 模型 | `message.model` | `claude-opus-5`、`claude-fable-5`、`<synthetic>` |
| 上下文用量 | `message.usage` 中 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` | `2 + 13844 + 26369` |
| effort | **顶层** `effort` | `xhigh`、`max` |
| 权限模式 | **顶层** `permissionMode` | 字符串 |
| sub-agent 调用 | `message.content[]` 中 `type=="tool_use"` 且 `name` 为 `Agent`（本版本）或 `Task`（旧版本） | 本项目样本 86 次 |

⚠️ `<synthetic>` 是合成记录，**取模型时必须跳过**，否则会把 `<synthetic>` 当成模型名显示。

---

### Task 1: 解析器提取徽章数据

**Files:**
- Modify: `src-tauri/src/sessions/parser.rs`（`ParsedMeta` 结构体与 `parse_meta`）
- Test: `src-tauri/src/sessions/parser.rs` 的 `#[cfg(test)]` 模块

**Interfaces:**
- Consumes: 既有的 `read_head_lines` / `read_tail_lines`（签名不变）
- Produces:

```rust
pub struct ParsedMeta {
    pub first_user_uuid: Option<String>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub last_ts_ms: Option<i64>,
    // 本任务新增：
    pub model: Option<String>,           // 末条非 <synthetic> assistant 记录的 message.model
    pub context_tokens: Option<u64>,     // 同一条记录的 input + cache_creation + cache_read
    pub preview: Option<String>,         // 末条 assistant 文本块，空白折叠后截断到 80 字符
    pub effort: Option<String>,          // 末条带 effort 的记录
    pub permission_mode: Option<String>, // 末条带 permissionMode 的记录
}
```

- [ ] **Step 1: 写失败测试**

加到 `parser.rs` 的测试模块：

```rust
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test sessions::parser`
Expected: FAIL — `no field 'model' on type 'ParsedMeta'`

- [ ] **Step 3: 实现**

在 `ParsedMeta` 上加入五个字段（默认 `None`），并在 `parse_meta` 中**倒序**遍历 `tail`，对每个字段"第一个命中即定、已定则不再覆盖"：

```rust
/// 从一条 assistant 记录的 usage 中求出该轮送入模型的上下文总量。
/// 只累加"入向"三项：output_tokens 是产出，不占用下一轮上下文预算。
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

const PREVIEW_MAX_CHARS: usize = 80;
/// 合成记录的模型占位符，不是真实模型名。
const SYNTHETIC_MODEL: &str = "<synthetic>";
```

在倒序循环体内：

```rust
if meta.effort.is_none() {
    meta.effort = v.get("effort").and_then(|x| x.as_str()).map(str::to_string);
}
if meta.permission_mode.is_none() {
    meta.permission_mode = v.get("permissionMode").and_then(|x| x.as_str()).map(str::to_string);
}
if v.get("type").and_then(|t| t.as_str()) == Some("assistant") {
    if let Some(msg) = v.get("message") {
        let model = msg.get("model").and_then(|m| m.as_str());
        if model != Some(SYNTHETIC_MODEL) {
            if meta.model.is_none() {
                meta.model = model.map(str::to_string);
            }
            if meta.context_tokens.is_none() {
                meta.context_tokens = msg.get("usage").and_then(context_tokens_of);
            }
            if meta.preview.is_none() {
                meta.preview = msg.get("content").and_then(preview_of);
            }
        }
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test sessions::parser`
Expected: PASS，且既有的标题/cwd/uuid 测试全部不受影响。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/sessions/parser.rs
git commit -m "feat(core): 解析器提取模型、上下文用量、预览行、effort 与权限模式"
```

---

### Task 2: ThreadInfo 携带徽章数据

**Files:**
- Modify: `src-tauri/src/sessions/scan.rs`（`ThreadInfo` 结构体与组装处）
- Test: `src-tauri/src/sessions/scan.rs` 的 `#[cfg(test)]` 模块

**Interfaces:**
- Consumes: Task 1 的 `ParsedMeta.{model, context_tokens, preview, effort, permission_mode}`
- Produces: `ThreadInfo` 新增同名字段，serde 以 camelCase 出到前端：`model`、`contextTokens`、`preview`、`effort`、`permissionMode`

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn thread_info_carries_badge_fields() {
    let dir = tempfile::tempdir().unwrap();
    let proj = dir.path().join("-tmp-demo");
    std::fs::create_dir_all(&proj).unwrap();
    let line = format!(
        r#"{{"type":"assistant","effort":"max","permissionMode":"plan","timestamp":"2026-08-28T00:00:00Z","message":{{"role":"assistant","model":"claude-opus-5","content":[{{"type":"text","text":"预览文本"}}],"usage":{{"input_tokens":1,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":4}}}}}}"#
    );
    std::fs::write(proj.join("s1.jsonl"), format!("{line}\n")).unwrap();

    let projects = scan_projects_at(dir.path()).unwrap();
    let t = &projects[0].threads[0];
    assert_eq!(t.model.as_deref(), Some("claude-opus-5"));
    assert_eq!(t.context_tokens, Some(6));
    assert_eq!(t.preview.as_deref(), Some("预览文本"));
    assert_eq!(t.effort.as_deref(), Some("max"));
    assert_eq!(t.permission_mode.as_deref(), Some("plan"));
}
```

> 若 `scan.rs` 中扫描入口函数名不是 `scan_projects_at`，改用该文件既有的、接受根目录参数的测试入口；**不要**新增读取真实 `~/.claude` 的路径。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test sessions::scan`
Expected: FAIL — `no field 'model' on type 'ThreadInfo'`

- [ ] **Step 3: 实现**

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub root_key: String,
    pub resume_session_id: String,
    pub title: String,
    pub cwd: String,
    pub last_activity_ms: i64,
    pub file_count: u32,
    // 本任务新增（均可缺省：老会话或异常记录取不到时为 null）
    pub model: Option<String>,
    pub context_tokens: Option<u64>,
    pub preview: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
}
```

在组装 `ThreadInfo` 处，从**链上最后一个文件**的 `ParsedMeta` 取这五个字段（与 `last_activity_ms` 同一来源，保证"徽章与时间描述同一时刻"）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test sessions::`
Expected: PASS

- [ ] **Step 5: 前端类型同步**

在 `src/ipc.ts`（或声明 `ThreadInfo` 的 TS 文件）的对应 interface 上补齐：

```ts
model?: string | null
contextTokens?: number | null
preview?: string | null
effort?: string | null
permissionMode?: string | null
```

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/sessions/scan.rs src/ipc.ts
git commit -m "feat(core): ThreadInfo 携带模型、上下文用量、预览与 effort 字段"
```

---

### Task 3: sub-agent 计数（整读一次 + 增量缓存）

**Files:**
- Create: `src-tauri/src/sessions/subagents.rs`
- Modify: `src-tauri/src/sessions/mod.rs`（`pub mod subagents;`）、`src-tauri/src/lib.rs`（注册命令）
- Test: `src-tauri/src/sessions/subagents.rs` 的 `#[cfg(test)]` 模块

**Interfaces:**
- Produces:
  - `pub fn count_agent_calls(text: &str) -> u32` — 纯函数，统计一段 JSONL 文本里的 sub-agent 调用数
  - `#[tauri::command(async)] pub async fn count_subagents(dir_name: String, root_key: String, state: State<'_, SubagentCache>) -> Result<u32, String>`
  - `pub struct SubagentCache(Mutex<HashMap<PathBuf, CacheEntry>>)`，`CacheEntry { parsed_bytes: u64, mtime_ms: i64, count: u32 }`

> **为什么这个模块可以整读文件**：徽章要的是"这个会话总共派了几个 sub-agent"，而 86 次调用散落在 3490 行里，头尾窗口必然数不全。因此本模块整读**一次**，随后按 `parsed_bytes` 只解析新追加的部分。它**不在首屏路径上**——前端先用 Task 2 的 bounded 数据把方块画出来，再异步补这枚徽章（Task 11）。

- [ ] **Step 1: 写失败测试**

```rust
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test sessions::subagents`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```rust
//! sub-agent 计数（spec §5.3 的 ⑂n 徽章）。
//!
//! 与本 crate 其余读取路径不同，这里**整读**文件：徽章语义是"该会话总共派了几个
//! sub-agent"，而调用散落全文，头尾窗口数不全。代价用两点抵消：
//! 1. 结果按 (文件, 大小, mtime) 缓存，只有新追加的字节会被再解析；
//! 2. 该命令不在首屏路径上，由前端在方块渲染完成后异步调用。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
```

`count_file_cached(path, cache)`：读元数据取 `len` 与 `mtime`；命中缓存且 `len >= parsed_bytes` 时，只从 `parsed_bytes` 处 `seek` 读到 EOF，**按 `\n` 重同步后**再 `count_agent_calls`，加到旧计数上；`len < parsed_bytes`（截断）或未命中则整读重算。写回缓存。

> ⚠️ 读取增量段时必须与 `read_tail_lines` 采取同样的做法：**读原始字节并在 `\n` 处重同步**，绝不 `read_to_string` 定长切片——否则中文内容会在多字节边界处静默丢数据（本项目曾出过这个真实事故）。

`count_subagents` 命令：由 `dir_name`/`root_key` 定位链上所有文件，逐个 `count_file_cached` 求和。**必须标 `#[tauri::command(async)]`**——Tauri 命令默认跑在 macOS 主线程上，整读大文件会卡住 UI（本项目已在 `pty_write` / `list_projects` 上踩过这个坑）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test sessions::subagents && cargo check`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/sessions/subagents.rs src-tauri/src/sessions/mod.rs src-tauri/src/lib.rs
git commit -m "feat(core): sub-agent 计数模块（整读一次 + 按追加增量重算）"
```

---

### Task 4: 总览 store（排序快照 / 位置 / 重命名）

**Files:**
- Create: `src/store/overview.ts`
- Test: `src/__tests__/overviewStore.test.ts`

**Interfaces:**
- Produces:
  - `blockKey(dirName: string, rootKey: string): string` → `` `${dirName}::${rootKey}` ``
  - `useOverviewStore`，state：`order: Record<string, string[]>`（按 dirName 存 blockKey 顺序快照）、`positions: Record<string, {x: number; y: number}>`、`names: Record<string, string>`
  - actions：`captureOrder(dirName, threads)`、`setPosition(key, pos)`（仅内存）、`commitPosition(key, pos)`（持久化）、`rename(key, name)`、`clearName(key)`

- [ ] **Step 1: 写失败测试**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { blockKey, useOverviewStore } from '../store/overview'

const t = (rootKey: string, ms: number) => ({ rootKey, lastActivityMs: ms })

beforeEach(() => {
  localStorage.clear()
  useOverviewStore.setState({ order: {}, positions: {}, names: {} })
})

describe('排序快照（spec §5.2：打开时按最后活动时间新→旧，打开期间不重排）', () => {
  it('首次捕获按时间新→旧', () => {
    useOverviewStore.getState().captureOrder('proj', [t('a', 100), t('b', 300), t('c', 200)])
    expect(useOverviewStore.getState().order.proj).toEqual([
      blockKey('proj', 'b'), blockKey('proj', 'c'), blockKey('proj', 'a'),
    ])
  })

  it('已有快照时不因时间变化而重排', () => {
    const s = useOverviewStore.getState()
    s.captureOrder('proj', [t('a', 100), t('b', 300)])
    const before = useOverviewStore.getState().order.proj
    s.captureOrder('proj', [t('a', 999_999), t('b', 300)]) // a 变成最新
    expect(useOverviewStore.getState().order.proj).toEqual(before)
  })

  it('新出现的会话追加到快照末尾，不打乱既有顺序', () => {
    const s = useOverviewStore.getState()
    s.captureOrder('proj', [t('a', 100), t('b', 300)])
    s.captureOrder('proj', [t('a', 100), t('b', 300), t('新', 50)])
    expect(useOverviewStore.getState().order.proj).toEqual([
      blockKey('proj', 'b'), blockKey('proj', 'a'), blockKey('proj', '新'),
    ])
  })

  it('消失的会话从快照中移除', () => {
    const s = useOverviewStore.getState()
    s.captureOrder('proj', [t('a', 100), t('b', 300)])
    s.captureOrder('proj', [t('b', 300)])
    expect(useOverviewStore.getState().order.proj).toEqual([blockKey('proj', 'b')])
  })
})

describe('位置：拖拽中只改内存，落手才持久化（沿用项目既有两动作范式）', () => {
  it('setPosition 不写 localStorage', () => {
    useOverviewStore.getState().setPosition('k', { x: 10, y: 20 })
    expect(useOverviewStore.getState().positions.k).toEqual({ x: 10, y: 20 })
    expect(localStorage.getItem('aterm.overview.positions')).toBeNull()
  })

  it('commitPosition 写入 localStorage', () => {
    useOverviewStore.getState().commitPosition('k', { x: 10, y: 20 })
    expect(JSON.parse(localStorage.getItem('aterm.overview.positions')!)).toEqual({ k: { x: 10, y: 20 } })
  })
})

describe('重命名', () => {
  it('rename 持久化，clearName 恢复默认标题', () => {
    const s = useOverviewStore.getState()
    s.rename('k', '我的重构任务')
    expect(JSON.parse(localStorage.getItem('aterm.overview.names')!)).toEqual({ k: '我的重构任务' })
    s.clearName('k')
    expect(useOverviewStore.getState().names.k).toBeUndefined()
  })

  it('空白名字视为清除，不留下空标题的方块', () => {
    const s = useOverviewStore.getState()
    s.rename('k', '   ')
    expect(useOverviewStore.getState().names.k).toBeUndefined()
  })
})

describe('持久化读回的健壮性', () => {
  it('localStorage 内容损坏时回退为空，不抛异常', async () => {
    localStorage.setItem('aterm.overview.positions', '{ 这不是 JSON')
    vi.resetModules()
    const fresh = await import('../store/overview')
    expect(fresh.useOverviewStore.getState().positions).toEqual({})
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/overviewStore.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

按 `src/store/theme.ts` 的既有写法：模块加载时从 localStorage 读一次（`try/catch` 包住，坏数据回退为默认值），写入集中在一个 `persist` 辅助函数里。`captureOrder` 的规则：已有快照则**保留既有顺序**，只做「移除已消失的 key」+「新 key 按时间新→旧追加到末尾」；无快照则整体按 `lastActivityMs` 降序建立。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/__tests__/overviewStore.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/store/overview.ts src/__tests__/overviewStore.test.ts
git commit -m "feat(ui): 总览页 store —— 排序快照、方块位置与重命名持久化"
```

---

### Task 5: 布局纯函数模块

**Files:**
- Create: `src/overviewLayout.ts`
- Test: `src/__tests__/overviewLayout.test.ts`

**Interfaces:**
- Produces：`BLOCK_WIDTH_PX = 260`、`BLOCK_HEIGHT_PX = 116`、`BLOCK_GAP_PX = 16`、`columnsForWidth(w: number): number`、`gridSlot(index: number, columns: number): {x: number; y: number}`、`clampPosition(pos, containerWidth): {x, y}`、`canvasHeight(count, columns, positions): number`

> 为什么单独成文件：jsdom 没有布局引擎，所有几何计算必须从组件里抽成纯函数才测得了。本项目已有 `paneGeometry.ts` / `paneLayout.ts` 两个先例，沿用同一模式。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import {
  BLOCK_GAP_PX, BLOCK_HEIGHT_PX, BLOCK_WIDTH_PX,
  canvasHeight, clampPosition, columnsForWidth, gridSlot,
} from '../overviewLayout'

describe('columnsForWidth', () => {
  it('按方块宽与间距算列数', () => {
    expect(columnsForWidth(BLOCK_WIDTH_PX)).toBe(1)
    expect(columnsForWidth(BLOCK_WIDTH_PX * 2 + BLOCK_GAP_PX)).toBe(2)
    expect(columnsForWidth(BLOCK_WIDTH_PX * 3 + BLOCK_GAP_PX * 2)).toBe(3)
  })
  it('窗口再窄也至少一列，不返回 0 导致除零', () => {
    expect(columnsForWidth(10)).toBe(1)
    expect(columnsForWidth(0)).toBe(1)
  })
})

describe('gridSlot', () => {
  it('按行优先排布', () => {
    expect(gridSlot(0, 3)).toEqual({ x: 0, y: 0 })
    expect(gridSlot(2, 3)).toEqual({ x: (BLOCK_WIDTH_PX + BLOCK_GAP_PX) * 2, y: 0 })
    expect(gridSlot(3, 3)).toEqual({ x: 0, y: BLOCK_HEIGHT_PX + BLOCK_GAP_PX })
  })
})

describe('clampPosition —— 读取持久化位置的路径上必须钳制', () => {
  it('负坐标拉回原点', () => {
    expect(clampPosition({ x: -50, y: -30 }, 1000)).toEqual({ x: 0, y: 0 })
  })
  it('超出右边界的方块拉回可见区（否则换小屏后方块永久失踪）', () => {
    const w = 600
    expect(clampPosition({ x: 5000, y: 40 }, w)).toEqual({ x: w - BLOCK_WIDTH_PX, y: 40 })
  })
  it('容器比方块还窄时不产生负的 x', () => {
    expect(clampPosition({ x: 999, y: 0 }, 100)).toEqual({ x: 0, y: 0 })
  })
})

describe('canvasHeight', () => {
  it('无自定义位置时按网格行数算高', () => {
    expect(canvasHeight(4, 3, {})).toBe((BLOCK_HEIGHT_PX + BLOCK_GAP_PX) * 2)
  })
  it('有方块被拖到很下面时画布跟着变高', () => {
    expect(canvasHeight(1, 3, { k: { x: 0, y: 900 } })).toBe(900 + BLOCK_HEIGHT_PX + BLOCK_GAP_PX)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/overviewLayout.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
export const BLOCK_WIDTH_PX = 260
export const BLOCK_HEIGHT_PX = 116
export const BLOCK_GAP_PX = 16

export function columnsForWidth(containerWidth: number): number {
  const per = BLOCK_WIDTH_PX + BLOCK_GAP_PX
  return Math.max(1, Math.floor((containerWidth + BLOCK_GAP_PX) / per))
}

export function gridSlot(index: number, columns: number) {
  const col = index % columns
  const row = Math.floor(index / columns)
  return { x: col * (BLOCK_WIDTH_PX + BLOCK_GAP_PX), y: row * (BLOCK_HEIGHT_PX + BLOCK_GAP_PX) }
}

export function clampPosition(pos: { x: number; y: number }, containerWidth: number) {
  const maxX = Math.max(0, containerWidth - BLOCK_WIDTH_PX)
  return { x: Math.min(Math.max(0, pos.x), maxX), y: Math.max(0, pos.y) }
}
```

`canvasHeight` 取「网格自然高度」与「所有自定义位置里最大的 y + 方块高 + 间距」两者的较大值。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/__tests__/overviewLayout.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/overviewLayout.ts src/__tests__/overviewLayout.test.ts
git commit -m "feat(ui): 总览页布局纯函数（列数、网格槽位、位置钳制、画布高度）"
```

---

### Task 6: 方块组件

**Files:**
- Create: `src/components/SessionBlock.tsx`、`src/modelNames.ts`
- Modify: `src/App.css`（方块样式与状态着色）
- Test: `src/__tests__/SessionBlock.test.tsx`、`src/__tests__/modelNames.test.ts`

**Interfaces:**
- Consumes: `ThreadInfo`（Task 2）、`useThreadStatus`（既有）、`formatRelative`（`src/time.ts`，既有）、`StatusDot`（既有）
- Produces:
  - `shortModelName(id: string | null | undefined): string | undefined` —— `claude-opus-5` → `Opus 5`
  - `formatContextTokens(n: number | null | undefined): string | undefined` —— `106797` → `107k`
  - `<SessionBlock thread={...} dirName={...} subagentCount={...} onOpen={...} />`——**状态不经 prop 传入**，组件内部调 `useThreadStatus(dirName, thread.rootKey)` 自行求得

- [ ] **Step 1: 写失败测试（纯函数部分）**

```ts
import { describe, expect, it } from 'vitest'
import { formatContextTokens, shortModelName } from '../modelNames'

describe('shortModelName', () => {
  it('把模型 id 缩写成人读的短名', () => {
    expect(shortModelName('claude-opus-5')).toBe('Opus 5')
    expect(shortModelName('claude-sonnet-5')).toBe('Sonnet 5')
    expect(shortModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(shortModelName('opus')).toBe('Opus')
  })
  it('认不出的 id 原样返回，不显示空白', () => {
    expect(shortModelName('some-future-model')).toBe('some-future-model')
  })
  it('缺失时返回 undefined，由调用方决定不渲染该徽章', () => {
    expect(shortModelName(null)).toBeUndefined()
    expect(shortModelName(undefined)).toBeUndefined()
  })
})

describe('formatContextTokens —— 显示绝对值，不显示百分比', () => {
  it('千位以上用 k', () => {
    expect(formatContextTokens(106_797)).toBe('107k')
    expect(formatContextTokens(1_500)).toBe('2k')
  })
  it('不足 1000 显示原值', () => {
    expect(formatContextTokens(840)).toBe('840')
  })
  it('缺失返回 undefined', () => {
    expect(formatContextTokens(null)).toBeUndefined()
  })
})
```

- [ ] **Step 2: 写失败测试（组件部分）**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SessionBlock } from '../components/SessionBlock'
import { threadStatusKey, useStatusStore } from '../store/status'

const thread = {
  rootKey: 'r1', resumeSessionId: 's1', title: '重构解析器', cwd: '/tmp/demo',
  lastActivityMs: Date.now() - 5 * 60_000, fileCount: 1,
  model: 'claude-opus-5', contextTokens: 106_797, preview: '正在核查解析器字段',
  effort: 'xhigh', permissionMode: 'acceptEdits',
}

describe('SessionBlock（spec §5.3）', () => {
  it('渲染标题、预览行与三枚常驻徽章', () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    expect(screen.getByText('重构解析器')).toBeTruthy()
    expect(screen.getByText('正在核查解析器字段')).toBeTruthy()
    expect(screen.getByText('Opus 5')).toBeTruthy()
    expect(screen.getByText('5 分钟前')).toBeTruthy()
    expect(screen.getByText('上下文 107k')).toBeTruthy()
  })

  it('sub-agent 数为 0 时不显示 ⑂ 徽章（spec：有才显示）', () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    expect(screen.queryByText(/⑂/)).toBeNull()
  })

  it('sub-agent 数大于 0 时显示 ⑂n', () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={86} onOpen={() => {}} />)
    expect(screen.getByText('⑂ 86')).toBeTruthy()
  })

  it('缺失的字段不渲染空徽章', () => {
    const bare = { ...thread, model: null, contextTokens: null, preview: null }
    render(<SessionBlock thread={bare} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    expect(screen.queryByText(/上下文/)).toBeNull()
  })

  it('整块带上状态类名，供 CSS 着色（spec §5.3：底色与边框随状态）', () => {
    // 状态由组件自己经 useThreadStatus 求得，不作为 prop 传入：SessionBlock 本身
    // 就是「每项一个组件」，正是 Sidebar.tsx:246 那条 Rules of Hooks 注释的解法。
    useStatusStore.setState({
      statuses: new Map([[threadStatusKey('proj', 'r1'), { status: 'running', updatedAtMs: Date.now() }]]),
    })
    const { container } = render(
      <SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />
    )
    expect(container.querySelector('.session-block')?.classList.contains('session-block-running')).toBe(true)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/__tests__/SessionBlock.test.tsx src/__tests__/modelNames.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 4: 实现**

`modelNames.ts` 用一张前缀表做映射，未命中原样返回。`SessionBlock.tsx` 结构：

```tsx
<div className={`session-block session-block-${status ?? 'unknown'}`} onDoubleClick={onOpen}>
  <div className="session-block-head">
    <StatusDot status={status} />
    <span className="session-block-title">{displayTitle}</span>
  </div>
  {preview && <div className="session-block-preview">{preview}</div>}
  <div className="session-block-badges">
    {model && <span className="badge">{model}</span>}
    {subagentCount > 0 && <span className="badge">⑂ {subagentCount}</span>}
    <span className="badge">{formatRelative(thread.lastActivityMs)}</span>
    {ctx && <span className="badge">上下文 {ctx}</span>}
  </div>
</div>
```

`App.css` 中为三种状态各定义底色与边框，**全部取自主题变量**（如 `color-mix(in srgb, var(--status-running) 12%, var(--bg))`），不写死色值。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/__tests__/SessionBlock.test.tsx src/__tests__/modelNames.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/components/SessionBlock.tsx src/modelNames.ts src/App.css src/__tests__/SessionBlock.test.tsx src/__tests__/modelNames.test.ts
git commit -m "feat(ui): 会话方块组件（状态着色、预览行与四枚徽章）"
```

---

### Task 7: 总览页网格与拖拽

**Files:**
- Create: `src/components/OverviewPage.tsx`
- Modify: `src/App.css`
- Test: `src/__tests__/OverviewPage.test.tsx`

**Interfaces:**
- Consumes: Task 4 store、Task 5 布局函数、Task 6 方块组件
- Produces: `<OverviewPage dirName={...} />`

- [ ] **Step 1: 写失败测试**

```tsx
describe('OverviewPage', () => {
  it('按快照顺序渲染方块（新→旧）', async () => { /* 断言 DOM 顺序与 order 一致 */ })

  it('拖拽过程中不写 localStorage，落手才写', async () => {
    // pointerdown → pointermove 超过阈值 → 断言 localStorage 仍为空
    // pointerup → 断言位置已持久化
  })

  it('超过 4px 阈值才算拖拽，轻点不移动方块', async () => { /* ... */ })

  it('容器变窄后，持久化的越界位置被钳制回可见区', async () => { /* ... */ })
})
```

> 具体断言按 `src/__tests__/PaneDetach.test.tsx` 里既有的指针事件模拟写法照搬（同一套 `pointerdown/pointermove/pointerup` 辅助函数），保持全项目一致。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/OverviewPage.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

绝对定位画布：无自定义位置的方块用 `gridSlot(orderIndex, columns)`，有则用 `clampPosition(saved, containerWidth)`。拖拽走项目既有范式：`pointerdown` 记起点但**不** `preventDefault`（否则吞掉后续 click，本项目踩过）、超过 4px 阈值才进入拖拽、`pointermove` 调 `setPosition`、`pointerup` 调 `commitPosition`。容器宽度用 `ResizeObserver` 取。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/__tests__/OverviewPage.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/OverviewPage.tsx src/App.css src/__tests__/OverviewPage.test.tsx
git commit -m "feat(ui): 总览方块网格与自由拖拽排布"
```

---

### Task 8: overview 标签种类接入

**Files:**
- Modify: `src/store/tabs.ts`（`Tab.kind` 加 `'overview'`、新增 `hasPanes` 与 `openOverview`）、`src/components/TabBar.tsx`、`src/App.tsx`
- Test: `src/__tests__/tabs.test.ts`（扩充）

**Interfaces:**
- Produces:
  - `Tab.kind: 'home' | 'term' | 'overview'`
  - `export function hasPanes(tab: Tab): boolean` —— `'term'` 为 `true`，`'home'` 与 `'overview'` 为 `false`
  - `openOverview(dirName: string, projectName: string): void` —— 已存在则聚焦，不新建

> **本任务最大的风险**：`tabs.ts` 目前有多处以 `kind === 'home'` 作为「这个标签没有窗格」的判断（例如第 152 行 `if (!tab || tab.kind === 'home') return`）。新增第三种 kind 后，凡是这个语义的分支都必须改用 `hasPanes(tab)`，否则总览标签会被当成终端标签参与 split view，产生空窗格。**实现前先执行 `grep -n "kind === 'home'\|kind !== 'home'" src/store/tabs.ts src/components/*.tsx` 把所有出现处列全，逐一判断该处问的是「是不是主页」还是「有没有窗格」**——只有后者改成 `hasPanes`。把这份清单写进你的报告。

- [ ] **Step 1: 写失败测试**

追加到 `src/__tests__/tabs.test.ts`：

```ts
describe('overview 标签种类（spec §5.2）', () => {
  it('打开总览页创建 kind=overview 的标签，标题为「▦ 项目名·总览」，且无窗格', () => {
    useTabs.getState().openOverview('-Users-hou-astro-aTerm', 'aTerm')
    const ov = useTabs.getState().tabs.find((t) => t.kind === 'overview')!
    expect(ov).toBeDefined()
    expect(ov.title).toBe('▦ aTerm·总览')
    expect(ov.panes).toEqual([])
    expect(useTabs.getState().activeId).toBe(ov.id)
  })

  it('同一项目重复打开只聚焦已有总览标签，不新建', () => {
    useTabs.getState().openOverview('-dir-a', 'A')
    const firstId = useTabs.getState().tabs.find((t) => t.kind === 'overview')!.id
    useTabs.setState({ activeId: 'home' })
    useTabs.getState().openOverview('-dir-a', 'A')
    expect(useTabs.getState().tabs.filter((t) => t.kind === 'overview')).toHaveLength(1)
    expect(useTabs.getState().activeId).toBe(firstId)
  })

  it('不同项目各有自己的总览标签', () => {
    useTabs.getState().openOverview('-dir-a', 'A')
    useTabs.getState().openOverview('-dir-b', 'B')
    expect(useTabs.getState().tabs.filter((t) => t.kind === 'overview')).toHaveLength(2)
  })
})

describe('hasPanes —— 取代散落各处的 kind === "home" 判断', () => {
  it('终端标签有窗格', () => {
    expect(hasPanes(makeTermTab('t1', [makePane('p1')]))).toBe(true)
  })

  it('主页标签没有窗格', () => {
    expect(hasPanes(HOME_TAB)).toBe(false)
  })

  it('总览标签没有窗格——这是本任务的核心不变量', () => {
    useTabs.getState().openOverview('-dir-a', 'A')
    const ov = useTabs.getState().tabs.find((t) => t.kind === 'overview')!
    expect(hasPanes(ov)).toBe(false)
  })
})
```

同时把 import 行补上 `hasPanes`：

```ts
import { buildPaneCloseConfirmMessage, buildTabCloseConfirmMessage, hasPanes, moveArrayItem, reorderInsertIndex, useTabs } from '../store/tabs'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/tabs.test.ts`
Expected: FAIL —— `openOverview is not a function` / `hasPanes` 未导出

- [ ] **Step 3: 实现**

```ts
export type Tab = {
  id: string
  kind: 'home' | 'term' | 'overview'
  title: string
  panes: Pane[]
  activePaneId?: string
  paneWidths?: number[]
  dirName?: string // overview 标签记住自己是哪个项目的
}

/** 该标签是否承载窗格。主页与总览页都不承载——凡是问「有没有窗格」的分支都该用它，
 *  而不是继续拿 kind === 'home' 当代理判断。 */
export function hasPanes(tab: Tab): boolean {
  return tab.kind === 'term'
}
```

`openOverview` 先按 `kind === 'overview' && dirName === dirName` 查找；找到则只设 `activeId`，否则追加一个新标签并激活。

`TabBar.tsx` 渲染总览标签时复用既有标签样式；`App.tsx` 在 `kind === 'overview'` 时渲染 `<OverviewPage dirName={tab.dirName!} />`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run` （全套——本任务动了 split view 的核心 store，必须跑全）
Expected: PASS，既有 split view 测试全部不受影响。

- [ ] **Step 5: 提交**

```bash
git add src/store/tabs.ts src/components/TabBar.tsx src/App.tsx src/__tests__/tabs.test.ts
git commit -m "feat(ui): 新增 overview 标签种类，并以 hasPanes 取代 kind==='home' 的窗格判断"
```

---

### Task 9: 方块重命名

**Files:**
- Modify: `src/components/SessionBlock.tsx`
- Test: `src/__tests__/SessionBlock.test.tsx`（扩充）

**Interfaces:**
- Consumes: Task 4 的 `rename(key, name)` / `clearName(key)`、`blockKey(dirName, rootKey)`

- [ ] **Step 1: 写失败测试**

```tsx
describe('方块重命名（spec §5.2 右键菜单的「重命名」，本期以双击标题实现）', () => {
  beforeEach(() => {
    useOverviewStore.setState({ order: {}, positions: {}, names: {} })
  })

  it('双击标题进入编辑态', async () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    await userEvent.dblClick(screen.getByText('重构解析器'))
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('重构解析器')
  })

  it('Enter 提交重命名并持久化', async () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    await userEvent.dblClick(screen.getByText('重构解析器'))
    await userEvent.clear(screen.getByRole('textbox'))
    await userEvent.type(screen.getByRole('textbox'), '我的重构任务{Enter}')
    expect(screen.getByText('我的重构任务')).toBeTruthy()
    expect(useOverviewStore.getState().names[blockKey('proj', 'r1')]).toBe('我的重构任务')
  })

  it('Esc 取消，保留原标题且不写入 store', async () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    await userEvent.dblClick(screen.getByText('重构解析器'))
    await userEvent.type(screen.getByRole('textbox'), '不该被保存{Escape}')
    expect(screen.getByText('重构解析器')).toBeTruthy()
    expect(useOverviewStore.getState().names[blockKey('proj', 'r1')]).toBeUndefined()
  })

  it('失焦视为提交', async () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    await userEvent.dblClick(screen.getByText('重构解析器'))
    await userEvent.clear(screen.getByRole('textbox'))
    await userEvent.type(screen.getByRole('textbox'), '失焦提交')
    await userEvent.tab()
    expect(useOverviewStore.getState().names[blockKey('proj', 'r1')]).toBe('失焦提交')
  })

  it('输入全空白视为清除自定义名，回退到默认标题', async () => {
    useOverviewStore.getState().rename(blockKey('proj', 'r1'), '旧名字')
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={0} onOpen={() => {}} />)
    await userEvent.dblClick(screen.getByText('旧名字'))
    await userEvent.clear(screen.getByRole('textbox'))
    await userEvent.type(screen.getByRole('textbox'), '   {Enter}')
    expect(screen.getByText('重构解析器')).toBeTruthy()
    expect(useOverviewStore.getState().names[blockKey('proj', 'r1')]).toBeUndefined()
  })

  it('重命名后徽章与状态点仍在，不因进出编辑态而丢失', async () => {
    render(<SessionBlock thread={thread} dirName="proj" subagentCount={3} onOpen={() => {}} />)
    await userEvent.dblClick(screen.getByText('重构解析器'))
    await userEvent.type(screen.getByRole('textbox'), '{Enter}')
    expect(screen.getByText('⑂ 3')).toBeTruthy()
    expect(screen.getByText('Opus 5')).toBeTruthy()
  })
})
```

> ⚠️ 双击标题既是「进入编辑态」也是 Task 6 里 `onDoubleClick` 的「打开会话」。**两者冲突**：实现时把打开动作移到方块空白区域的双击，标题的双击只进入编辑态，并在标题元素上 `stopPropagation`。为此需在 Task 6 的测试里补一条「双击标题不触发 onOpen」。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/SessionBlock.test.tsx`
Expected: FAIL —— 双击后没有 textbox

- [ ] **Step 3: 实现**

组件内 `const [editing, setEditing] = useState(false)`；编辑态渲染受控 `<input>`，`onKeyDown` 分派 Enter/Escape，`onBlur` 提交。提交时 `value.trim()` 为空则调 `clearName`，否则调 `rename`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/__tests__/SessionBlock.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/SessionBlock.tsx src/__tests__/SessionBlock.test.tsx
git commit -m "feat(ui): 总览方块支持重命名（空白则回退默认标题）"
```

---

### Task 10: 底部常驻状态栏

**Files:**
- Create: `src/components/StatusBar.tsx`
- Modify: `src/App.tsx`、`src/App.css`
- Test: `src/__tests__/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `useTabs`（当前活动标签）、Task 2 的 `ThreadInfo.{model, effort, permissionMode}`、`useStatusStore`
- Produces: `<StatusBar />`；`export function buildSessionStatusText(t: {model?, effort?, permissionMode?}): string`；`export function buildOverviewStatusText(counts: {total: number; running: number; awaiting: number}): string`

> 把两段文案抽成纯函数，是因为「缺失字段不留空段」这条最容易出错，而它在纯函数上一目了然、也测得干净。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { buildOverviewStatusText, buildSessionStatusText } from '../components/StatusBar'

describe('buildSessionStatusText（spec §5.2：会话标签显示模型 · effort · 权限模式）', () => {
  it('三项齐全时以 · 连接', () => {
    expect(buildSessionStatusText({ model: 'claude-opus-5', effort: 'xhigh', permissionMode: 'acceptEdits' }))
      .toBe('Opus 5 · xhigh · acceptEdits')
  })

  it('缺失的段直接略去，不留下「· ·」这样的空段', () => {
    expect(buildSessionStatusText({ model: 'claude-opus-5', effort: null, permissionMode: 'plan' }))
      .toBe('Opus 5 · plan')
  })

  it('三项全缺时返回空串，由调用方决定不渲染', () => {
    expect(buildSessionStatusText({})).toBe('')
  })
})

describe('buildOverviewStatusText（总览/主页显示会话统计）', () => {
  it('统计三个数字', () => {
    expect(buildOverviewStatusText({ total: 12, running: 2, awaiting: 1 }))
      .toBe('12 个会话 · 2 运行中 · 1 等待回答')
  })

  it('运行中与等待均为 0 时只显示总数，不堆砌 0', () => {
    expect(buildOverviewStatusText({ total: 5, running: 0, awaiting: 0 })).toBe('5 个会话')
  })
})
```

组件层：

```tsx
describe('StatusBar 随标签切换而变化', () => {
  it('活动标签是会话时显示该会话的模型与 effort', () => {
    // 构造一个 term 标签，其活动窗格指向某 thread；断言文案出现
  })

  it('活动标签是总览页时显示会话统计', () => {
    // 打桩 useStatusStore 的 statuses；断言「n 个会话 · n 运行中」出现
  })

  it('活动标签是主页时同样显示会话统计', () => { /* 同上 */ })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/StatusBar.test.tsx`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

纯函数用「收集非空段再 `join(' · ')`」实现，天然满足「不留空段」。组件按 `useTabs` 的活动标签 `kind` 分派。样式在 `App.css` 里以主题变量着色，高度固定，不参与终端测量容器（**切勿把状态栏放进 FitAddon 测量的元素内**——本项目曾因把间距放进测量容器而裁掉终端底部一行）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/__tests__/StatusBar.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/StatusBar.tsx src/App.tsx src/App.css src/__tests__/StatusBar.test.tsx
git commit -m "feat(ui): 底部常驻状态栏（会话显示模型·effort·权限模式，总览显示统计）"
```

---

### Task 11: sub-agent 徽章异步补齐

**Files:**
- Modify: `src/components/OverviewPage.tsx`、`src/ipc.ts`
- Test: `src/__tests__/OverviewPage.test.tsx`（扩充）

**Interfaces:**
- Consumes: Task 3 的 `count_subagents` 命令
- Produces: `src/ipc.ts` 中 `countSubagents(dirName: string, rootKey: string): Promise<number>`

- [ ] **Step 1: 写失败测试**

```tsx
describe('sub-agent 徽章异步补齐（不阻塞首屏）', () => {
  it('方块先渲染，⑂ 徽章随后出现', async () => {
    let resolveCount: (n: number) => void = () => {}
    vi.mocked(ipc.countSubagents).mockReturnValue(new Promise((r) => { resolveCount = r }))
    render(<OverviewPage dirName="proj" />)
    // 首屏：方块已在，徽章未到
    expect(await screen.findByText('重构解析器')).toBeTruthy()
    expect(screen.queryByText(/⑂/)).toBeNull()
    // 计数返回后徽章出现
    resolveCount(7)
    expect(await screen.findByText('⑂ 7')).toBeTruthy()
  })

  it('计数失败时静默略过该徽章，其它方块不受影响', async () => {
    vi.mocked(ipc.countSubagents).mockRejectedValue(new Error('读文件失败'))
    render(<OverviewPage dirName="proj" />)
    expect(await screen.findByText('重构解析器')).toBeTruthy()
    expect(screen.queryByText(/⑂/)).toBeNull()
  })

  it('组件卸载后到达的响应不写 state（沿用 ConversationPanel 的陈旧响应守卫）', async () => {
    let resolveCount: (n: number) => void = () => {}
    vi.mocked(ipc.countSubagents).mockReturnValue(new Promise((r) => { resolveCount = r }))
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<OverviewPage dirName="proj" />)
    unmount()
    resolveCount(3)
    await Promise.resolve()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('并发受限：会话很多时不一次性发起全部请求', async () => {
    // 构造 20 个 thread；断言首轮同时在飞的调用数不超过 4
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/OverviewPage.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

方块渲染完成后，用一个并发上限为 4 的简单队列逐个调 `countSubagents`，结果写入 `Map<blockKey, number>` 本地 state。用 `requestIdRef`（照搬 `ConversationPanel.tsx` 的写法）丢弃卸载后或 `dirName` 已切换时到达的响应。失败的单个请求 `catch` 后略过，不影响其它。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/__tests__/OverviewPage.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/OverviewPage.tsx src/ipc.ts src/__tests__/OverviewPage.test.tsx
git commit -m "feat(ui): 总览页异步补齐 sub-agent 徽章，不阻塞首屏"
```

---

### Task 12: 总览页入口

**Files:**
- Modify: `src/components/HomePage.tsx`（项目卡片上增加「▦ 总览」入口）
- Test: `src/__tests__/HomePage.test.tsx`（或既有的主页测试文件）

**Interfaces:**
- Consumes: Task 8 的 `openOverview(dirName, projectName)`

> **为什么需要这个任务**：Task 1–11 建好了总览页的全部能力，但**没有任何一处 UI 调用 `openOverview`**——功能存在却无法抵达。这是计划本身的缺口（Task 8 的审查独立确认：它不在 Task 8 的声明范围内，也未被 9–11 中任何一个认领）。spec §5.2 写明总览标签「常驻」，隐含它必须可达。

- [ ] **Step 1: 写失败测试**

```tsx
it('项目卡片上的「总览」按钮打开该项目的总览标签', async () => {
  render(<HomePage />)
  await userEvent.click(await screen.findByRole('button', { name: /总览/ }))
  const ov = useTabs.getState().tabs.find((t) => t.kind === 'overview')
  expect(ov).toBeTruthy()
  expect(ov?.dirName).toBe('-Users-hou-astro-aTerm')
})

it('点击总览按钮不会同时触发展开卡片（事件不冒泡到卡片头）', async () => {
  render(<HomePage />)
  await userEvent.click(await screen.findByRole('button', { name: /总览/ }))
  // 卡片仍处于收起状态：其会话列表未出现
  expect(screen.queryByText('重构解析器')).toBeNull()
})
```

- [ ] **Step 2–5:** 确认失败 → 在 `ProjectCard` 头部加一个按钮，`onClick` 中 `e.stopPropagation()` 后调 `openOverview(p.dirName, basename(p.cwd))` → 确认通过 → 提交

```bash
git commit -m "feat(ui): 主页项目卡片增加总览页入口"
```

---

## 完成标准（对应 spec §12 P2 行验收）

- [ ] 打开总览页：方块按最后活动时间新→旧排列，打开期间不因状态刷新而重排
- [ ] 三种状态的底色、边框、转圈/脉冲/实心点表现正确，且切换主题后仍协调
- [ ] 拖动方块位置持久化，重启 app 后仍在原处；窗口变窄后方块不会跑到可视区外
- [ ] 重命名持久化；清空名字回退默认标题
- [ ] 四枚徽章正确：模型短名、⑂n（仅有时显示）、相对时间、`上下文 107k`
- [ ] 底部状态栏随标签切换而变化
- [ ] 总览页可从主页项目卡片打开（功能可抵达，而非仅存在）
- [ ] `npx vitest run` 全绿、`npm run build` 零错误、`cargo test` 全绿、`cargo check` 干净
- [ ] 全程未向 `~/.claude/` 写入任何内容

## 已知风险

1. **`kind === 'home'` 的分支遗漏**（Task 8）——`tabs.ts` 是 split view 的核心且测试密集，新增第三种 kind 若漏改某个分支，会产生"总览标签被拆分成窗格"的怪状。实现时应先 `grep -n "kind ===" src/store/tabs.ts` 列全再逐条判断。
2. **首屏性能**——总览页会同时渲染一个项目下的全部会话方块。若某项目会话数很多（>100），需要观察首屏耗时；本期不做虚拟滚动，但若实测超过 200ms 应记入 BACKLOG。
3. **jsdom 测不到的部分**——方块拖拽的真实指针行为、CSS 状态着色的实际观感、`ResizeObserver` 的真实回调时机，均需在真机上人工确认。本项目已有多次"测试全绿但真机有 bug"的先例（滚动条内联样式、事件顺序、CSS 裁切），不可仅凭测试通过就判定完成。
