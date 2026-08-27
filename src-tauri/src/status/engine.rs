//! 状态判定：spec §4 的五条规则，按优先级从高到低、先命中先定。
//!
//! 刻意实现为纯函数（`infer_status`），不读取系统时钟、不碰文件系统、不依赖任何
//! 全局状态——所有输入都以参数显式传入（含 `now_ms`，规则 3 需要判断"最近
//! ACTIVE_WINDOW 内"就必须有一个参照时刻；不用 `SystemTime::now()` 是为了让这个
//! 核心判定函数可被穷举测试，不必依赖真实时钟）。上层（`watcher.rs`）负责收集这些
//! 输入（读取尾部时间戳、hook 事件、进程存活）并调用这个函数。

use serde::Serialize;

/// hook 命令只关心这两种事件（spec §4/§5）；其余事件类型在 `hooks.rs` 解析阶段就
/// 被跳过，不会传到这里。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEventKind {
    Notification,
    Stop,
}

/// 该会话最近一条 hook 事件（若有）及其发生时刻（毫秒）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HookSignal {
    pub kind: HookEventKind,
    pub ts_ms: i64,
}

/// 三种状态，沿用总设计 §4；序列化为 camelCase 供前端消费。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Running,
    AwaitingInput,
    Done,
}

/// 规则 3 的"最近"窗口：默认 5 秒（spec §4）。
pub const ACTIVE_WINDOW_MS: i64 = 5_000;

/// spec §4 五条规则的纯函数实现，按顺序先命中先定：
///
/// 1. 最近一条 hook 事件是 `Notification` 且晚于最后一次 jsonl 追加 → `AwaitingInput`
/// 2. 最近一条 hook 事件是 `Stop` 且晚于最后一次 jsonl 追加 → `Done`
/// 3. jsonl 在最近 `ACTIVE_WINDOW_MS` 内有追加 → `Running`
/// 4. 有存活进程但超过 `ACTIVE_WINDOW_MS` 无追加 → `AwaitingInput`（启发式回退）
/// 5. 无存活进程（或存活性未知）→ `Done`
///
/// 参数：
/// - `last_hook`：该会话最近一条 hook 事件，`None` 表示未安装 hooks 或从未收到过
/// - `last_append_ms`：最后一次 jsonl 追加的时间戳（毫秒），`None` 表示没有可用的转录
/// - `process_alive`：`Some(true)`/`Some(false)` 为确定的存活性；`None` 表示无法判定
///   （`~/.claude/sessions/*.json` 缺失、该会话不在其中、或解析失败）——按 spec §4/§10
///   的降级要求，`None` 不触发规则 4 的"存活"分支，而是直接落到规则 5，与"解析失败时
///   退回‘有追加即运行中’"的降级精神一致：规则 3 已经处理了"有追加"的情况，这里不用
///   未知的存活性去冒充"确定存活"从而误判为"等你回答"
/// - `now_ms`：参照时刻（毫秒），用于规则 3 的"最近"判断
pub fn infer_status(
    last_hook: Option<HookSignal>,
    last_append_ms: Option<i64>,
    process_alive: Option<bool>,
    now_ms: i64,
) -> Status {
    // 规则 1/2：hook 事件是否晚于最后一次追加。追加时间缺失时，hook 事件视为必然
    // 更晚（没有更晚的追加可比较）。
    let hook_is_after_append = |hook_ts: i64| match last_append_ms {
        Some(append_ts) => hook_ts > append_ts,
        None => true,
    };

    if let Some(hook) = last_hook {
        match hook.kind {
            HookEventKind::Notification if hook_is_after_append(hook.ts_ms) => {
                return Status::AwaitingInput;
            }
            HookEventKind::Stop if hook_is_after_append(hook.ts_ms) => {
                return Status::Done;
            }
            _ => {}
        }
    }

    // 规则 3：last_append_ms 落在 [now_ms - ACTIVE_WINDOW_MS, now_ms] 内。用普通减法
    // 而非 saturating 运算——时钟回拨/未来时间戳（skew）时 elapsed 会是负数，
    // 显式排除在窗口外而不是靠饱和运算悄悄纳入，行为更可推理。
    if let Some(append_ts) = last_append_ms {
        let elapsed = now_ms - append_ts;
        if (0..=ACTIVE_WINDOW_MS).contains(&elapsed) {
            return Status::Running;
        }
    }

    // 规则 4/5：只有明确存活（Some(true)）才走"等你回答"回退；不确定或明确已死都
    // 落到"已完成"。
    if process_alive == Some(true) {
        return Status::AwaitingInput;
    }
    Status::Done
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000_000;

    fn sig(kind: HookEventKind, ts_ms: i64) -> HookSignal {
        HookSignal { kind, ts_ms }
    }

    // ---- 规则 1：Notification 晚于追加 → AwaitingInput

    #[test]
    fn rule1_notification_after_append_is_awaiting_input() {
        let status = infer_status(
            Some(sig(HookEventKind::Notification, NOW - 100)),
            Some(NOW - 200),
            Some(true),
            NOW,
        );
        assert_eq!(status, Status::AwaitingInput);
    }

    #[test]
    fn rule1_notification_with_no_prior_append_is_awaiting_input() {
        // 没有任何追加时间可比较：hook 事件视为必然更晚。
        let status = infer_status(Some(sig(HookEventKind::Notification, NOW - 100)), None, None, NOW);
        assert_eq!(status, Status::AwaitingInput);
    }

    // ---- 规则 2：Stop 晚于追加 → Done

    #[test]
    fn rule2_stop_after_append_is_done() {
        let status = infer_status(
            Some(sig(HookEventKind::Stop, NOW - 100)),
            Some(NOW - 200),
            Some(true),
            NOW,
        );
        assert_eq!(status, Status::Done);
    }

    // ---- 优先级冲突：hook 事件早于最后一次追加时，规则 1/2 都不应命中，落到规则 3。

    #[test]
    fn hook_older_than_append_falls_through_to_recency_rule() {
        // Notification 比追加更早：不该判"等你回答"，追加又在窗口内 → Running。
        let status = infer_status(
            Some(sig(HookEventKind::Notification, NOW - 10_000)),
            Some(NOW - 100), // 落在 ACTIVE_WINDOW 内
            Some(true),
            NOW,
        );
        assert_eq!(status, Status::Running, "过期的 hook 事件不能压过更晚的真实追加");
    }

    #[test]
    fn stale_stop_falls_through_when_append_is_recent() {
        let status = infer_status(
            Some(sig(HookEventKind::Stop, NOW - 10_000)),
            Some(NOW - 50),
            Some(true),
            NOW,
        );
        assert_eq!(status, Status::Running);
    }

    #[test]
    fn hook_exactly_equal_to_append_ts_does_not_win() {
        // "晚于"是严格大于；hook_ts == append_ts 时不算"晚于"，不应命中规则 1/2。
        let status = infer_status(Some(sig(HookEventKind::Stop, NOW - 100)), Some(NOW - 100), Some(true), NOW);
        assert_eq!(status, Status::Running, "hook 与追加同一时刻时应视为追加更新（未越过 append）");
    }

    // ---- 规则 3：最近 ACTIVE_WINDOW 内有追加 → Running

    #[test]
    fn rule3_recent_append_is_running() {
        let status = infer_status(None, Some(NOW - ACTIVE_WINDOW_MS + 1), None, NOW);
        assert_eq!(status, Status::Running);
    }

    #[test]
    fn rule3_window_boundary_is_inclusive() {
        // 恰好等于窗口边界（elapsed == ACTIVE_WINDOW_MS）仍算"最近"。
        let status = infer_status(None, Some(NOW - ACTIVE_WINDOW_MS), None, NOW);
        assert_eq!(status, Status::Running);
    }

    #[test]
    fn rule3_just_past_window_does_not_match() {
        let status = infer_status(None, Some(NOW - ACTIVE_WINDOW_MS - 1), Some(true), NOW);
        assert_eq!(status, Status::AwaitingInput, "刚超出窗口应落到规则 4，而不是规则 3");
    }

    #[test]
    fn rule3_future_timestamp_from_clock_skew_does_not_match() {
        // 追加时间戳在 now 之后（时钟回拨等异常情况）：不应被当成"最近"。
        let status = infer_status(None, Some(NOW + 5_000), Some(true), NOW);
        assert_eq!(status, Status::AwaitingInput);
    }

    // ---- 规则 4：存活但超窗口无追加 → AwaitingInput（启发式回退）

    #[test]
    fn rule4_alive_but_stale_is_awaiting_input() {
        let status = infer_status(None, Some(NOW - ACTIVE_WINDOW_MS - 1), Some(true), NOW);
        assert_eq!(status, Status::AwaitingInput);
    }

    #[test]
    fn rule4_alive_with_no_append_at_all_is_awaiting_input() {
        let status = infer_status(None, None, Some(true), NOW);
        assert_eq!(status, Status::AwaitingInput);
    }

    // ---- 规则 5：无存活进程 → Done

    #[test]
    fn rule5_dead_process_is_done() {
        let status = infer_status(None, Some(NOW - ACTIVE_WINDOW_MS - 1), Some(false), NOW);
        assert_eq!(status, Status::Done);
    }

    #[test]
    fn rule5_no_signals_at_all_is_done() {
        let status = infer_status(None, None, None, NOW);
        assert_eq!(status, Status::Done);
    }

    // ---- 降级路径：进程存活性未知（sessions/*.json 缺失或解析失败）时，不冒充
    // "确定存活"去判"等你回答"；退回"有追加即运行中"（规则 3 覆盖），否则 Done。

    #[test]
    fn unknown_liveness_with_recent_append_still_running() {
        let status = infer_status(None, Some(NOW - 100), None, NOW);
        assert_eq!(status, Status::Running);
    }

    #[test]
    fn unknown_liveness_with_stale_append_degrades_to_done_not_awaiting_input() {
        let status = infer_status(None, Some(NOW - ACTIVE_WINDOW_MS - 1), None, NOW);
        assert_eq!(
            status,
            Status::Done,
            "存活性未知时不能像规则 4 那样判‘等你回答’，必须降级为 Done"
        );
    }

    // ---- 未安装 hooks（last_hook 恒为 None）时只用规则 3/4/5，行为仍应正确。

    #[test]
    fn no_hooks_installed_still_infers_from_recency_and_liveness() {
        assert_eq!(infer_status(None, Some(NOW - 10), None, NOW), Status::Running);
        assert_eq!(infer_status(None, Some(NOW - ACTIVE_WINDOW_MS - 1), Some(true), NOW), Status::AwaitingInput);
        assert_eq!(infer_status(None, Some(NOW - ACTIVE_WINDOW_MS - 1), Some(false), NOW), Status::Done);
    }
}
