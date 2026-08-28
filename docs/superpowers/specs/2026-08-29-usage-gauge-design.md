# aTerm 用量额度条设计（P2e）

## 1. 目标

在底栏常驻显示 Claude 订阅额度的实时状态：已用百分比、重置时间、以及按当前
消耗速度估算的「还能用多久」。形态取自 bookholder 的横向轨道条（track + fill）。

**默认关闭。** 用户在设置里显式开启后才生效。

## 2. 为什么这个功能需要单独设计

aTerm 至今是一个**纯本地、零网络**的应用：只读 `~/.claude/` 下的文件，不联网、
不碰任何凭据。这个功能会同时打破这两条：

- 需要读取 **Claude Code 的登录凭据**（macOS 钥匙串条目 `Claude Code-credentials`）
- 需要向 **`https://api.anthropic.com/api/oauth/usage`** 发起请求

因此它必须是**可关闭的、默认关闭的、且开启前明确告知用户**的功能，而不是悄悄
获得这两项能力。

## 3. 数据来源与其脆弱性（必须记录在案）

`/api/oauth/usage` **不是公开 API**。它是 Claude Code 内部用于显示用量的通道，
请求头带内部 beta 标记 `anthropic-beta: oauth-2025-04-20`。凭据也不是为第三方
应用签发的。

这意味着：**Anthropic 可以在任何一次更新中改动或移除它，不会有通知、不会有
弃用期。** 钥匙串条目的名称与 JSON 结构同理，属 Claude Code 内部细节。

**由此推出本设计最重要的一条约束：任何一步失败，都必须安静地降级为「不显示」，
绝不报错弹窗、绝不显示过期数字冒充实时。** 功能消失是可接受的；显示错误的额度
不可接受——用户会据此决定还能不能继续干活。

## 4. 数据模型

上游返回的结构（实测样本，取自 bookholder 的 `usage_cache_json`）：

```jsonc
{
  "five_hour":  { "utilization": 17.0, "resets_at": "2026-08-28T23:30:00Z" },
  "seven_day":  { "utilization": 33.0, "resets_at": "2026-09-02T09:00:00Z" },
  "limits": [
    { "kind": "session",       "percent": 17, "resets_at": "...", "scope": null },
    { "kind": "weekly_all",    "percent": 33, "resets_at": "...", "scope": null },
    { "kind": "weekly_scoped", "percent": 31, "resets_at": "...",
      "scope": { "model": { "display_name": "Fable" } } }
  ]
}
```

以 `limits` 数组为准（它同时覆盖了按模型细分的窗口），`five_hour` / `seven_day`
作为兜底。内部类型：

```rust
pub struct UsageWindow {
    pub kind: String,             // session | weekly_all | weekly_scoped
    pub scope_label: Option<String>, // weekly_scoped 的模型显示名，如 "Fable"
    pub percent: f64,             // 0–100
    pub resets_at: Option<String>,// RFC3339
}
```

**未知字段一律忽略，缺字段的窗口整条丢弃**——上游加字段不该让功能崩，上游删
字段应表现为「那条窗口不显示」而非显示 0%。

## 5. 「还能用多久」的估算

沿用 bookholder 的做法，并保留其克制：

1. 每次轮询把 `(ts, kind, percent)` 追加到本地采样文件
2. 取 `lookback` 窗口内最早的一条采样，算斜率 `slope = (now_pct - then_pct) / hours`
3. `eta_hours = (100 - now_pct) / slope`

**两条必须保留的守卫**（否则会给出荒谬的数字）：

- 采样跨度 < 3 分钟 → 不显示（斜率不可信）
- `slope <= 0.05 %/h` → 不显示（几乎没在消耗，外推会得到几百小时）

宁可不显示，也不显示一个瞎猜的续航。

## 6. 采样存储

aTerm 目前没有数据库，**不为此引入 SQLite**。沿用 hooks 事件文件的既有形态：

- 路径：`~/Library/Application Support/aTerm/usage-samples.jsonl`
- 每行 `{"ts":<毫秒>,"kind":"session","percent":17.0}`
- 超过 512KB 时轮转，只保留最后 500 行（估算只关心近期斜率，历史无价值）
- 位于 aTerm 自有数据目录，**不在 `~/.claude/` 之内**，不违反只读约束

## 7. 轮询

- **仅在功能开启时**启动；关闭即停止并清理定时器
- 间隔 120 秒（与 bookholder 一致；上游本身也是分钟级更新）
- 失败不重试、不退避——下一个周期自然会再试，避免失败时反而加大请求频率
- 应用不在前台时不轮询（省电；重新前台时立即取一次）

## 8. 凭据处理

```
security find-generic-password -s "Claude Code-credentials" -w
```

解析出 `claudeAiOauth.accessToken`。**硬性规则：**

- 只在发起请求的那一刻读取，**绝不缓存到磁盘、绝不写进任何日志或错误信息**
- 请求只发往 `api.anthropic.com`，URL 为编译期常量，不接受任何运行时拼接
- 钥匙串被拒绝（用户点「不允许」）是**正常路径**，不是错误：功能安静关闭并在
  设置里说明原因

## 9. 首次开启的告知

用户在设置里打开开关时，**先出现一段说明再触发钥匙串弹窗**：

> 开启后 aTerm 会读取你的 Claude Code 登录凭据，并向 Anthropic 查询额度用量。
> 凭据只在本机使用、不会被保存或发送到其它地方。
> 该接口未公开，Anthropic 更改后此功能可能失效。

用户确认后才执行读取。**不允许弹窗先跳出来再解释。**

## 10. UI

底栏在现有的「模型 · effort · 权限模式」右侧增加一段：

```
[▓▓▓░░░░░░░] 17%  3h12m 后重置
```

- 轨道条 + 填充条，颜色取自主题变量；接近上限时切换到警示色变量
- 默认只显示 **5 小时窗**（`session`）——那是干活时最常撞到的限制
- 悬停展开完整明细（周窗、各模型窗）
- ETA 有值时追加 `· 约 2.1h 用尽`；无值时整段省略，不显示占位

## 11. 降级矩阵

| 情形 | 表现 |
|---|---|
| 功能未开启 | 不显示任何东西 |
| 钥匙串被拒绝 / 条目不存在 | 不显示；设置里说明原因 |
| 网络失败 / 超时 | 保留上一次成功的数据，但**标注为陈旧**（如变灰 + 「n 分钟前」） |
| 返回体结构不认识 | 不显示；设置里说明「接口可能已变更」 |
| 数据超过 10 分钟未更新 | 标注陈旧 |

**绝不把过期数据当实时显示**，这是本设计的底线。

## 12. 新增依赖

需要一个 HTTP 客户端。选 `ureq`（bookholder 同款）：同步、无 async 运行时依赖、
体积小。请求在 `#[tauri::command(async)]` 内发起，不阻塞 macOS 主线程。

## 13. 不做的事

- 不做成本计算、不做历史图表、不做按项目分摊——那些是 bookholder 的职责，
  aTerm 只要一个「还剩多少」的仪表
- 不读取 bookholder 的数据库（用户已决定走自包含路线）
- 不在关闭状态下做任何网络或钥匙串操作
