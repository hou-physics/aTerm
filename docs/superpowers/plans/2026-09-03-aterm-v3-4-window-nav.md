# aTerm V3.4 实施计划：新建窗口菜单项 + 标签拖到任意窗口

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 菜单栏 File > 新建窗口（⌘N）；标签可拖到任意其它窗口的标签栏，空壳窗口自动关闭。

**Architecture:** 两项都是 V3.3 基础设施的复用。新建窗口直接调 `create_term_window`；
拖到已存在窗口复用交接协议的尾巴（序列化 → emitTo → 等 ack → 移除），只是跳过建窗与
等 ready。新增的只有一个 Rust 命中测试命令、主窗口加入交接接收方、以及空壳自动关闭。

**Spec:** `docs/superpowers/specs/2026-09-03-aterm-v3-4-window-nav-design.md`

## Global Constraints

- 全部见仓库根 `CLAUDE.md`（硬约束、测试纪律、既有坑）。
- **受保护文件** `ConversationPanel.tsx` / `TerminalView.tsx` **本计划任何任务都不得改动**。
- **⌘Q 那一整套不得破坏**：`replace_quit_menu_item` 长注释、`QuitReplaced` 令牌顺序不变式。
  `cargo build` 若因令牌报错说明顺序弄反了。
- **跨窗口事件两头防护**（V3.3 Ruling 8/15/17）：发送端 `emit_to` 且载荷带目标 label；
  接收端 `listen(…, {target})` 且 handler 校验载荷。**测试替身的 label 不得与断言的 target
  相同**（Ruling 14 的恒真教训）。
- **cargo 不在默认 PATH**，先 `. "$HOME/.cargo/env"`。
- 基线：前端 **1045 / 72 文件**；Rust **148**；`npm run build` 干净；既有拖拽 91 条全绿。
  只增不减。

---

### Task 1: File > 新建窗口（⌘N）

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Test: `lib.rs` 的 `#[cfg(test)]`

- [ ] **Step 1: 读 `setup_macos_menu` 与 `insert_settings_menu_item`**

「设置…」是插进 App 子菜单的先例；主题菜单用 `top_items.iter().find_map(...)` 按标题找
子菜单。**File 子菜单用后一种方式找**（按 `.text()` 匹配 "File"），不要靠下标。

- [ ] **Step 2: 写失败的 Rust 测试**

- 计算插入位置的纯函数：File 子菜单只有 Close Window 时，「新建窗口」+ 分隔线插在它之前
- 插入后 Close Window 仍在、且 App 子菜单末位仍是 `QUIT_MENU_ITEM_ID`

- [ ] **Step 3: 实现**

- 常量 `NEW_WINDOW_MENU_ITEM_ID`，加速键 `Command+N`
- `on_menu_event` 命中时：取聚焦窗口位置（沿用 Task 6 的 `focused_window_label` 路径）
  +30/+30 逻辑像素级联；取不到用主窗口；再取不到用默认位置。然后调
  `create_term_window` 的内部实现（不要重复建窗逻辑）。
- 放在 `setup_macos_menu` 内、`replace_quit_menu_item` 之后，与「设置…」同段。
- 失败即降级：找不到 File 子菜单打警告继续启动。

- [ ] **Step 4: `cargo test` + `npm run build`，变异：把插入位置写错、令牌两行对调**

- [ ] **Step 5: 提交**

---

### Task 2: 命中测试命令 `window_at_point`

**Files:**
- Modify: `src-tauri/src/lib.rs`、`src/ipc.ts`
- Test: `lib.rs` 的 `#[cfg(test)]`、`src/__tests__/ipc*.test.ts`

**Interfaces:**
- Produces: Rust 命令 `window_at_point(x, y, exclude) -> Result<Option<WindowHit>, String>`；
  前端 `ipc.ts` 的 `windowAtPoint(x, y, exclude)` 包装。

- [ ] **Step 1: 包含判定提成纯函数**

输入：点（逻辑屏幕坐标）、窗口列表 `[(label, 逻辑矩形)]`、exclude。输出：第一个包含该点
且 label ≠ exclude 的窗口及本地坐标。**先写测试**：命中/未命中/边界/排除自身/多窗口取第一个。

- [ ] **Step 2: 命令实现**

遍历 `app.webview_windows()`，对每个窗口 `outer_position()` / `outer_size()` /
`scale_factor()` 转逻辑像素，喂给纯函数。任一窗口读取失败**跳过该窗口**而非整体失败。
注册进 `generate_handler!`。

**坐标契约与 `create_term_window` 一致**（逻辑像素，调用方不做 DPR 换算），在命令注释里
写明并引用它的考据。

- [ ] **Step 3: `ipc.ts` 加包装，照现有命令的写法**

- [ ] **Step 4: `cargo test` + `npx vitest run` + ACL guard**（自定义命令不需 ACL 条目，
  但要跑一遍确认没顺带引入别的）

- [ ] **Step 5: 提交**

---

### Task 3: 三路分流 + 所有窗口监听交接 + 空壳自动关闭

**Files:**
- Modify: `src/windowHandoff.ts`、`src/components/TabBar.tsx`、`src/tabTearOut.ts`
- Test: `src/__tests__/windowHandoff.test.ts`、`TabBar.test.tsx`、`tabTearOut.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `windowAtPoint`。
- Produces: `handoffTabToWindow(tabId, targetLabel)`；`TABBAR_DROP_ZONE_PX` 常量。

- [ ] **Step 1: 抽共享尾巴**

`tearOutTab` 现在是：建窗 → 等 ready → 序列化 → emitTo → 等 ack → 移除。把「序列化 →
emitTo → 等 ack → 移除」抽成 `handoffToLabel(tabId, label, opts)`，`tearOutTab` 与新的
`handoffTabToWindow` 都调它。**V3.3 Ruling 5 的时序不变**：发送那一刻才序列化、才重新取
标签。交接锁（`handoffInFlight`）与其在每条路径的释放**原样保留**。

- [ ] **Step 2: 写失败的测试（每条断言真实 store 状态）**

- 命中其它窗口标签栏 → 交接给它，标签从本窗口移除，**未调 `create_term_window`**
- 命中其它窗口但 `local_y >= TABBAR_DROP_ZONE_PX` → 取消，标签仍在，未建窗、未交接
- 未命中 → 走既有建窗路径（既有测试必须仍绿）
- `tabCount <= 1` 时拖到其它窗口标签栏 → **仍然交接**（守卫只拦建窗路）
- 交接超时 → 标签仍在，**未调 `destroy_term_window`**（目标不是本次建的）
- `term-*` 交接出最后一个终端标签 → ack 之后调 `destroy_term_window(自己)`；
  变异：把 destroy 提到 ack 之前，必须转红
- 主窗口交接出最后一个终端标签 → **不** destroy
- 主窗口现在能收到交接（替身 label 用 `'main'` 以外的值验证 target 限定仍在——
  见 Global Constraints）

- [ ] **Step 3: 实现**

- `windowHandoffReady`：监听器对所有窗口注册；就绪广播仍只 `term-*` 发。
- `TabBar.tsx` 的 pointerup：出界时先 `windowAtPoint(e.screenX, e.screenY, 本窗口 label)`，
  按 §5.2 三路分流。`shouldTearOut` 的 40px 余量与 `tabCount` 守卫只作用于第 4 路。
- 目标窗口 `handleHandoff`：追加到末尾并激活（现有逻辑若已如此则不改）。
- 空壳关闭：`removeTabKeepingPty` 之后检查本窗口是否还有 `kind === 'term'` 的标签，
  没有且本窗口是 `term-*` → `destroyTermWindow(自己)`。

- [ ] **Step 4: 全量 + 既有拖拽 91 条连跑 3 次**

- [ ] **Step 5: 提交**

---

## 真机验收（全部完成后交付用户）

见规格 §7 的 7 条。
