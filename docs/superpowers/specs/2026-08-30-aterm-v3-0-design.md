# aTerm V3.0 设计：修坏掉的四件事

日期：2026-08-30
分期：V3.0（共三期，见文末「V3 全景」）
分支：`feature/v3-0-fixes`

---

## 1. 范围

用户一次性提出 13 条需求，已拆成三期。本文只覆盖 **V3.0**，即四条「现在是错的」：

| # | 症状（用户原话） | 本文小节 |
|---|---|---|
| 8 | 新对话的标签页标题不更新；点侧栏里同一条会话又开一个新标签；右侧对话面板不更新 | §3 |
| 9 | 底部状态栏的当前模型有时不显示 | §3（同根因） |
| 12 | 跑 Claude 的终端里滚轮太快，降到 1.5 倍 | §4 |
| 13 | 文件拖进来没反应（别的终端会把路径拖进去） | §5 |
| 6 | 中文输入法第一个问号/括号要按两次 | §6（探针，非设计） |

V3.1（侧栏/主页交互）与 V3.2（菜单栏、多窗口）不在本文范围。

## 2. 勘察结论

以下**全部已在本机核实**，不是推断：

**2.1 `claude --session-id <uuid>` 可用，且转录文件就叫这个名字。**
实测：`claude --session-id ebd067d4-… -p "hi"` 生成
`~/.claude/projects/<dir>/ebd067d4-….jsonl`。探针产物已清理。
这意味着**不需要**"监听 FSEvents 猜哪个是刚建的会话"这类子系统——起进程前我们自己
决定 uuid 即可，同项目并发开多个新对话也不会互相混淆。

**2.2 第 8、9 条是同一个根因。**
`actions.ts` 的 `newConversation` 用 `inject: 'claude'` 起终端，**不传**
`threadKey`/`dirName`/`rootKey`。下游一切按 `threadKey` 认人的逻辑因此全部落空：

- `focusThread(threadKey)`（`tabs.ts`）匹配不到 → 侧栏再点一次就新开标签；
- 标签标题由 `deriveTabTitle` 取自窗格 `title`，无人更新 → 永远停在「新对话」；
- `ConversationPanel` 无 `dirName`/`rootKey` 可读 → 不加载；
- `StatusBar.tsx` 里 `if (!pane?.dirName || !pane.rootKey) return ''` → 模型段整段消失。

第 9 条的"有时不显示"就是这一条，不是独立缺陷。

**2.3 `rootKey` 会翻一次，所以窗格不能只记 `rootKey`。**
`scan.rs:50` 注释与实现：链键取**首条用户消息 uuid**，缺失时退回自身 `session_id`。
新会话刚建时 `rootKey == session_id`（我们给的那个），用户发出第一句话后
`rootKey` 变成那条消息的 uuid。只记 `rootKey` 的窗格会绑对一瞬间，随即再次失联——
症状与今天完全相同，只是晚几秒发生。

**2.4 标题有回退值，会污染标签标题。**
`scan.rs` 取标题的写法是
`fs.iter().rev().find_map(|fm| fm.meta.title.clone()).unwrap_or_else(|| newest.session_id.chars().take(8).collect())`。
新会话尚无标题时 `ThreadInfo.title` 是 uuid 前 8 位。对账器若无条件采纳，标签会从
「新对话」变成 `ebd067d4`——比不改还糟。

**2.5 滚轮放大器传 1.5 会得到 2 倍。**
`wheel.ts` 的 `createWheelAmplifier` 循环是 `for (let i = 1; i < multiplier; i++)`。
`multiplier = 1.5` 时循环体执行 1 次 → 1 个真实事件 + 1 个合成事件 = 2×，不是 1.5×。
必须改成带余量的累加器。

**2.6 拖文件无反应是 Tauri 拦截所致。**
Tauri 2 的窗口默认 `dragDropEnabled`，原生拖放被 Tauri 接管，webview 里的 HTML5
`drop` 事件根本不触发。正解不是关掉它，而是**用它**——`onDragDropEvent()` 交付的是
真实文件系统路径数组，比 HTML5 DataTransfer 能拿到的更可靠。

**2.7 中文输入法问题在 xterm 层，不在 webview 层。**
用户实测：只有终端里会，主页搜索框（普通 React `<input>`）正常。
xterm 6.0 的 `CompositionHelper`（去混淆）：

```js
compositionend() { this._finalizeComposition(true) }

_finalizeComposition(sending) {
  this._isComposing = false
  if (sending) {
    this._isSendingComposition = true
    setTimeout(() => { if (this._isSendingComposition) { /* 真正发送 */ } }, 0)
  }
}

keydown(e) {
  if (this._isComposing || this._isSendingComposition) {
    if (e.keyCode === 20 || e.keyCode === 229) return false
    if (e.keyCode === 16 || e.keyCode === 17 || e.keyCode === 18) return false
    this._finalizeComposition(false)          // ← 把待发送那次翻成 false，永久丢失
  }
  return e.keyCode !== 229 || (this._handleAnyTextareaChanges(), false)
}
```

发送被推迟一个宏任务并由 `_isSendingComposition` 守卫；任何不在白名单
（20/229/16/17/18）内的 keydown 落进这个窗口，就会取消那次发送。下一次按键的
`_handleAnyTextareaChanges()` 再把 textarea 里攒着的内容一并冲出——**与用户描述的
"第一个要按两次、紧跟着的第二个一下就出来"逐字吻合**。

但"到底是谁在那个窗口里插了一脚"读压缩代码定不了案，且 jsdom 完全不实现 IME
合成事件。因此第 6 条在本期是**探针**，不是设计（见 §6）。

## 3. 新对话身份（修第 8、9 条）

### 3.1 原则

**窗格记 `sessionId`（我们自己生成、永不变），`rootKey` 每次刷新反查得出。**

`sessionId` 是唯一稳定的身份；`rootKey`、`title`、`dirName` 全是随转录增长而变的
派生量，一律不由前端持有真相，只做缓存。

### 3.2 后端改动（`src-tauri/src/sessions/scan.rs`）

`ThreadInfo` 增加两个字段：

```rust
/// 本链上所有 jsonl 文件的 session id，按与 file_count 相同的顺序（时间升序）。
/// 前端的窗格对账靠它把"我起进程时指定的那个 session id"映射回当前的 root_key。
pub session_ids: Vec<String>,
/// 本链是否已经有真实标题。false 表示 `title` 字段是 session_id 前 8 位的回退值
/// （见 scan_projects 里 title 的 unwrap_or_else），前端据此决定要不要采纳它。
pub titled: bool,
```

实现（`scan_projects` 内，`fs` 已按时间升序排好）：

```rust
let title_opt = fs.iter().rev().find_map(|fm| fm.meta.title.clone());
let titled = title_opt.is_some();
let title = title_opt.unwrap_or_else(|| newest.session_id.chars().take(8).collect());
let session_ids = fs.iter().map(|fm| fm.session_id.clone()).collect();
```

不新增任何文件读取——`fs` 里的 `session_id` 是 `group_chain_files` 早就填好的。

**为什么给 `titled` 而不让前端嗅探字符串**：前端若写
`thread.title === thread.resumeSessionId.slice(0, 8)` 来识别回退值，就在两个语言里
各留了一份同样的规则，Rust 那边一改回退格式，前端会静默失效。一个 bool 没有漂移面。

`ipc.ts` 的 `ThreadInfo` 同步加 `sessionIds: string[]` 与 `titled: boolean`
（serde `rename_all = "camelCase"` 已配置，字段名自动对齐）。

### 3.3 前端改动

**(a) `Pane` 类型（`store/tabs.ts`）新增 `sessionId?: string`**

语义：这个窗格里跑的 `claude` 进程被指定使用的 session id。只有我们自己用
`--session-id` 起的新对话才有；`--resume` 起的窗格不设它（它一开始就知道
`rootKey`，无需对账）。

**(b) `newConversation`（`actions.ts`）**

```ts
export const newConversation = (cwd: string) => {
  const sessionId = crypto.randomUUID()
  return useTabs.getState().openTerminal({
    title: '新对话',
    cwd,
    inject: `claude --session-id ${sessionId}`,
    sessionId,
  })
}
```

`openTerminal` 与 `startPaneTerminal` 的入参对象各加一个可选 `sessionId`，透传到
`Pane`。两处签名必须一起改——窗格选择器（`PanePicker`）里的「新对话」入口走的是
后者。

**(c) 对账器（新文件 `src/paneReconcile.ts`，纯函数 + 一个 store action）**

纯函数，可单测、不碰 store：

```ts
export type PaneIdentity = { dirName: string; rootKey: string; threadKey: string; title?: string }

/** 在 projects 里按 sessionId 找到它当前所属的链，算出该窗格此刻应有的身份。
 *  找不到（转录尚未落盘、或用户在窗格里退出 claude 后跑了别的命令）返回 null，
 *  调用方保持窗格原样，不清空已有身份。 */
export function resolvePaneIdentity(projects: ProjectInfo[], sessionId: string): PaneIdentity | null
```

规则：

1. 遍历 `projects` → `threads`，命中 `thread.sessionIds.includes(sessionId)` 的第一条；
2. `threadKey = `${project.dirName}:${thread.rootKey}``（与 `actions.ts` 的
   `resumeThread` **逐字相同**的拼法，不写第二套）；
3. `title` 仅在 `thread.titled === true` 时给出；否则字段缺省，调用方保留窗格原标题
   （即「新对话」）。

store action：

```ts
reconcilePanes(projects: ProjectInfo[]): void
```

对每个 `sessionId` 非空的窗格调用 `resolvePaneIdentity`，把结果写回 `dirName` /
`rootKey` / `threadKey` /（有条件的）`title`，并对受影响的标签重算
`deriveTabTitle`。身份未变时**返回同一个 `tabs` 引用**（no-op，不产生新对象），与
本文件既有惯例一致（`moveArrayItem`、`movePanesToTab` 拖到自己标签时都是这样）。

**(d) 调用点（`App.tsx`）**

`refresh()` 之后调 `reconcilePanes`。`useSessions.refresh` 有三个触发点（挂载、
window focus、`statusVersion` 变化时的节流刷新），全部都要覆盖——最省事且不会漏的
接法是包一层：

```ts
const refreshAndReconcile = useCallback(async () => {
  await refresh()
  useTabs.getState().reconcilePanes(useSessions.getState().projects)
}, [refresh])
```

三处触发点统一改调它。**不要**在 `useSessions.refresh` 内部调用 `tabs` store——那
会让 sessions 依赖 tabs，把一个纯数据 store 拖进 UI 状态的耦合里。

### 3.4 这一处对账修好的四个症状

| 症状 | 修好的机制 |
|---|---|
| 标签标题不更新 | `reconcilePanes` 回填 `title` → `deriveTabTitle` 重算 |
| 侧栏点击又开新标签 | 回填 `threadKey` → `focusThread` 命中 |
| 右侧对话面板不更新 | 回填 `dirName`/`rootKey` → `ConversationPanel` 有数据可读 |
| 底栏模型不显示 | 同上 → `StatusBar` 的 `!pane.dirName \|\| !pane.rootKey` 早退不再命中 |

### 3.5 边界情形

- **转录尚未落盘**：`resolvePaneIdentity` 返回 null，窗格保持「新对话」，下一轮刷新
  再试。没有超时、没有重试计数——刷新本来就是周期性的。
- **uuid 撞上已有会话**：`claude --session-id` 会去 resume 那个会话。v4 uuid 碰撞
  概率 2^-122，不做防御性检查（做了反而要处理"检查完到 spawn 之间又被占用"的窗口，
  纯属自造复杂度）。
- **用户在窗格里退出 claude 后跑别的命令**：`sessionId` 变陈旧，对账器继续指向那条
  已结束的会话。与今天 `--resume` 窗格的行为一致，不作特殊处理。
- **老版本 `claude` 不认 `--session-id`**：进程会自己报错并显示在终端里，用户看得见。
  不做版本探测（多一次启动开销去防一个本机已确认不存在的问题）。

### 3.6 测试夹具的连带改动（别低估）

`sessionIds` 与 `titled` 是**必填**字段，不是可选。理由：后端永远会给出它们；写成
可选就得在对账器里处理一个生产中不存在的 `undefined` 分支，是把契约的模糊转嫁给
调用方。

代价是实测的：全仓库有 **22 处 `ThreadInfo` 字面量，分布在 10 个测试文件**里，其中
只有 `OverviewPage.test.tsx` 和 `StatusBar.test.tsx` 有本地 `thread()` 助手，其余
8 个文件是裸字面量。加必填字段会让它们**全部编译失败**。

处置：在 `src/__tests__/factories.ts` 里加

```ts
export function makeThread(overrides: Partial<ThreadInfo> = {}): ThreadInfo
```

并把这 22 处字面量迁移过去。这不是顺手重构——它是本次改动的直接后果，而且做完之后
**下一个 `ThreadInfo` 字段只需要改一行**，不用再动 10 个文件。`factories.ts` 顶部
那段"只服务新增用例、不回头改旧字面量"的注释需要同步更新：那条约定的前提是"旧字面量
不受影响"，现在不成立了。

迁移是机械的，且有类型检查兜底；但它是一个独立任务，不要和对账器逻辑混在一个提交里
——否则真正的逻辑改动会淹没在 22 处夹具改动的 diff 里，评审看不出重点。

## 4. 滚轮倍率（修第 12 条）

**范围**：仅「跑 Claude 的终端」这一条路径，即 `ALT_WHEEL_MOUSE_MULTIPLIER`
（Claude TUI 自己接管鼠标上报时走的分支）。用户已确认另两个旋钮
（`scrollSensitivity = 5` 的普通回滚、右侧面板的 DOM 滚动）**不动**。

**值**：3 → 1.5。

**实现**：`createWheelAmplifier` 改为带余量的累加器——

```ts
export function createWheelAmplifier(multiplier: number): (target: EventTarget, ev: WheelEvent) => void {
  let synthesizing = false
  let carry = 0          // 未满一个事件的余量，跨事件累加
  return (target, ev) => {
    if (synthesizing) return
    carry += multiplier - 1
    const extra = Math.floor(carry)
    carry -= extra
    if (extra <= 0) return
    synthesizing = true
    try {
      for (let i = 0; i < extra; i++) { /* 补发合成事件，字段同现有实现 */ }
    } finally { synthesizing = false }
  }
}
```

`multiplier = 1.5` 时补发数在 0 和 1 之间交替，长期均值 1.5×。整数倍率行为与今天
完全一致（`carry` 恒为 0）。这与 `wheelDeltaToLines` 已有的 `remainder` 是同一手法。

**持久化**：值移入 `store/layout.ts`（`wheelMultiplier`，`localStorage` 键
`aterm-wheel-multiplier`，默认 1.5，钳制到 [1, 6]），读取模式沿用
`readPersistedFontSize` 那一套「`v !== null` 显式区分未存过与存过假值」。
`TerminalView` 从 store 取值。

**滑块 UI 本期不做**——当前没有设置面板可以放（只有侧栏左下角的主题浮层），
而 V3.2 要把主题/hooks 都搬进 macOS 菜单栏，届时一并建立设置入口。值先进 store
是为了让那时的滑块是纯 UI 增量，不用回头改逻辑。

**受保护文件**：`TerminalView.tsx` 在保护清单里，本项改动已获用户明确许可
（2026-08-30）。改动面仅限：常量替换为 store 订阅。

## 5. 文件拖放（修第 13 条）

**接法**：`@tauri-apps/api/webview` 的 `getCurrentWebview().onDragDropEvent()`。
窗口配置**不改**——保持 Tauri 接管原生拖放正是拿到真实路径的前提。

事件是可辨识联合，**四种形态各自带的字段不同**（已对照
`node_modules/@tauri-apps/api/webview.d.ts`，api 版本 2.11.1）：

```ts
| { type: 'enter';  paths: string[]; position: PhysicalPosition }
| { type: 'over';                    position: PhysicalPosition }   // 无 paths
| { type: 'drop';   paths: string[]; position: PhysicalPosition }
| { type: 'leave' }                                                 // 连 position 都没有
```

写代码时必须按 `type` 收窄后再取字段——`over` 上没有 `paths`，`leave` 上没有
`position`，当成统一形状会在运行时拿到 `undefined`。

**坐标单位（关键）**：`position` 是 `PhysicalPosition`，即**物理像素**；而
`getPaneSlotRects` 返回的是 `getBoundingClientRect()` 的 **CSS 像素**。Retina 上
`devicePixelRatio = 2`，两者直接比对会整体偏一倍——而在外接的非 Retina 显示器上又
恰好正确，是最难查的那类缺陷。必须先换算：

```ts
const { x, y } = position.toLogical(window.devicePixelRatio)
```

（`getCurrentWindow().scaleFactor()` 是权威来源但返回 Promise；在 macOS 上其值与
`window.devicePixelRatio` 相同，取后者可以同步完成、不引入一次 IPC。）

**落点**：用换算后的坐标对窗格矩形做命中测试，复用 `paneDropDom.ts` 现成的
`getPaneSlotRects(tab)`。落在哪个窗格就写进哪个窗格的 PTY，**不是**写进当前聚焦
窗格——分屏下用户明确瞄准了某一个。命中不到任何窗格（主页标签、总览标签、标签栏、
状态栏）则整个忽略，不做任何事。

**写入内容**：shell 转义后的路径，多个文件以空格分隔，末尾补一个空格（便于用户接着
打字）。转义抽成纯函数：

```ts
/** 单引号包裹；内部的 ' 用 '\'' 断开重接。这是 POSIX shell 里唯一无需枚举元字符的
 *  安全写法——单引号内除 ' 本身外一切字符都是字面量。 */
export function shellQuote(path: string): string
export function formatDroppedPaths(paths: string[]): string   // join(' ') + 尾随空格
```

**反馈**：`over` 时给目标窗格加 `.pane-drop-target` class（颜色一律取主题变量，
不写死任何色值）；`leave`/`drop` 清除。

**不做**：拖到主页搜索框、拖到对话面板、拖文件夹的特殊处理（文件夹路径同样是路径，
原样写入即可）、拖入时自动 `cd`。

## 6. 中文输入法（第 6 条）：探针，不是设计

**为什么不在本文给修法**：§2.7 已定位到嫌疑机制，但"谁取消了那次发送"必须在真机上
观察。jsdom 不实现 `compositionstart/update/end`，任何在测试里写出来的"复现"都是
自说自话——这正是本项目反复吃过亏的那类假测试。

**做法**：在 `TerminalView` 挂一段**临时**仪表（合入前删除），记录

- 每个 `keydown` 的 `keyCode` / `key` / `isComposing`；
- `compositionstart` / `compositionupdate` / `compositionend` 的时刻与 `data`；
- 每次 `term.onData` 实际发出的内容。

由用户在真机上打一个 `？` 和一个 `（`，把日志回传，据此定位。

**时间盒**：一轮探针 + 一轮修复尝试。若结论是 xterm 上游缺陷且绕不过去，**如实报告
并从 V3.0 移出**，不硬凑一个把别的输入路径搞坏的 workaround。

**判定标准**：修复必须由用户在真机上验收（打第一个问号一次出字），不接受任何
自动化测试作为通过依据。

## 7. 测试策略

沿用既有约束：

- **本仓库没有 jest-dom**。断言一律用 `toBeTruthy()` / `toBeNull()` /
  `classList.contains()`，禁止 `toBeInTheDocument` / `toHaveClass` / `toHaveValue`。
- **Rust 测试绝不碰真实 `~/.claude`**，一律 `tempfile`。
- 每个测试必须能回答「**它会因为什么而失败**」。断言不出错误行为的测试不算测试。

分项：

| 对象 | 测法 |
|---|---|
| `resolvePaneIdentity` | 纯函数单测：命中链中间的文件、`titled: false` 时不给 title、找不到返回 null、跨项目同名 rootKey 不误match |
| `reconcilePanes` | store 单测：回填四个字段、标签标题重算、身份未变时 `tabs` 引用不变 |
| `session_ids` / `titled` | Rust 单测（tempfile 造两文件链）：顺序与时间升序一致；无标题时 `titled == false` 且 `title` 是前 8 位 |
| `createWheelAmplifier` | 纯函数单测：1.5 倍在 10 次调用后补发总数为 5；整数倍率行为与改动前逐次相同 |
| `shellQuote` / `formatDroppedPaths` | 纯函数单测：含空格、含单引号、含中文的路径 |
| 拖放命中测试 | 纯函数单测（矩形 + 坐标 → paneId），不测 Tauri 事件本身。**必须有一个 `devicePixelRatio = 2` 的用例**——这是本节唯一会在 Retina 上错、在普通屏上对的失效模式 |
| IME | **无自动化测试**，见 §6 |

## 8. 明确不做

- 不建"探测新会话"的 FSEvents 子系统（`--session-id` 使其失去存在理由）；
- 不改 `rootKey` 的分组语义（会波及 `conversation.rs` 的链拼接，风险远大于收益）；
- 不做滚轮速度滑块 UI（等 V3.2 的设置入口）；
- 不做 uuid 碰撞防御；
- 不做 `claude` 版本探测。

## 9. 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| `--session-id` 在交互模式下行为与 `-p` 不同 | §3 全盘失效 | 实现第一步就在真机交互模式下验一次，失败则整节回退到 FSEvents 方案并重新评估 |
| 对账器每次 refresh 遍历全部 threads | 会话极多时的开销 | 每 15s 一次、只对 `sessionId` 非空的窗格（通常 0–3 个）执行；量级远低于 `refresh()` 本身的文件读取 |
| `TerminalView.tsx` 是受保护文件 | 改坏终端 | 改动面严格限定为「常量 → store 订阅」一处；已获用户明确许可 |
| IME 可能是 xterm 上游缺陷 | 第 6 条做不出来 | 已在 §6 写明时间盒与"如实报告并移出"的退出条件 |
| 拖放坐标原点未必是视口左上角 | 命中测试整体偏移一个标题栏高度 | Tauri 只承诺 `position` 是物理像素，未在类型里说明原点。实现第一步先打一条日志，把换算后的坐标与某个已知窗格的 `getBoundingClientRect()` 对照一次；若存在固定偏移，减掉它并写进注释。**不要靠肉眼觉得"差不多能用"就过**——偏移量恰好接近标题栏高度时，拖到窗格上半部仍会命中，只有下边缘露馅 |

## V3 全景

| 期 | 主题 | 条目 |
|---|---|---|
| **V3.0**（本文） | 修坏掉的 | 8+9 新对话身份、6 输入法、12 滚轮、13 拖文件 |
| V3.1 | 调交互 | 1 面板按钮位置与默认展开、4 最近会话容量、5+7 右键菜单/别名/隐藏/移除、10 ＋ 菜单、11 双击打开 |
| V3.2 | 系统集成 | 3 主题与 hooks 进菜单栏、2 多窗口 |

期间无反向依赖，逐期验收。V3.2 的顺序（先菜单栏后多窗口）是有意的：菜单项一旦建好，
多窗口天然共享它们；反过来会改两遍。
