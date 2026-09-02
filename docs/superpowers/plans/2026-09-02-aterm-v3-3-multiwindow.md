# aTerm V3.3 实施计划：多窗口与标签拖出

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把终端标签拖到窗口边界之外并松手，弹出新窗口接管它，其中运行中的 Claude Code
会话不中断、终端历史不丢失。

**Architecture:** PTY 由 Rust 全局持有、输出以 `app.emit` 广播，因此「交接」本质上只是
换一个 webview 来渲染，不涉及进程迁移。旧窗口用 `SerializeAddon` 把滚屏序列化后经定向
事件交给新窗口写回，随后仅移除标签而不 kill PTY。

**Tech Stack:** Tauri 2.11.5（多 WebviewWindow、capability 作用域、`emit_to`）；
React 19 + zustand；`@xterm/addon-serialize@0.14.0`。

**Spec:** `docs/superpowers/specs/2026-09-02-aterm-v3-3-multiwindow-design.md`

## Global Constraints

- **本仓库没有 jest-dom**。禁 `toBeInTheDocument` / `toHaveClass` / `toHaveValue` /
  `toHaveTextContent`，只用 vitest 内置断言。
- **所有颜色取自主题 CSS 变量**，禁硬编码 hex/rgb/hsl/颜色名（28 主题 × 3 模式）。
- **受保护文件**：`src/components/ConversationPanel.tsx`、`src/components/TerminalView.tsx`。
  只有 Task 3 获准改 `TerminalView.tsx`，且改动面严格限定在该任务写明的范围。其余任务
  一律不得触碰这两个文件；若认为必须改，停下来上报。
- **localStorage 键名不得变更**；别名 key 格式 `${dirName}::${rootKey}`（双冒号）不得变更。
- **aTerm 对 `~/.claude` 只读**，唯一例外是 hooks 安装器。
- **测试绝不允许碰真实 `~/.claude`**。
- **不得新增依赖**（`@xterm/addon-serialize@0.14.0` 已在规格提交里加好）。
- **cargo 不在默认 PATH**，每个跑 cargo 的 shell 必须先 `. "$HOME/.cargo/env"`。
- 基线：`npx vitest run` 881 通过 / 64 文件；`cargo test` 127 通过；`npm run build` 干净。
  每个任务结束时三者都必须仍然成立（数量只增不减）。
- **测试纪律**：每条断言单独做变异验证，不许整个 `it` 块合并跑就宣称验证过；凡「改值后
  断言新值」的测试，初始值必须与目标值不同；变异要贴实际红色输出。本项目已三次栽在
  死断言上。

---

### Task 1: ACL 作用域 + 新窗口创建命令

**Files:**
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/lib.rs` 的 `#[cfg(test)]`

**Interfaces:**
- Produces: Rust 命令 `create_term_window(x: f64, y: f64) -> Result<String, String>`，
  返回新窗口 label；label 生成规则 `term-<uuid>`。

- [ ] **Step 1: 改 capability 作用域**

`src-tauri/capabilities/default.json` 现在是 `"windows": ["main"]`。新窗口 label 不是
`main`，会一个权限都拿不到。改为同时覆盖 `main` 与 `term-*`。

改完请**确认 Tauri 的 capability `windows` 字段确实支持通配**——查
`src-tauri/gen/schemas/desktop-schema.json` 里该字段的说明，把你查到的依据写进报告。
若不支持通配，改用其它可行方式（例如为新窗口单独加一个 capability 文件），并说明理由。

- [ ] **Step 2: 写失败的 Rust 测试**

label 生成规则要能单测。把它提成纯函数再测（本仓库先例：`reveal.rs` 的
`validate_reveal_dir`、`lib.rs` 的 `settings_insertion_index`）：

```rust
#[test]
fn term_window_label_has_expected_shape() {
    let a = new_term_window_label();
    let b = new_term_window_label();
    assert!(a.starts_with("term-"));
    assert_ne!(a, b, "两次生成的 label 不能相同，否则第二个窗口会撞上第一个");
}
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /Users/hou.astro/aTerm/src-tauri && . "$HOME/.cargo/env" && cargo test
```
预期：编译失败，找不到 `new_term_window_label`。

- [ ] **Step 4: 实现**

- `new_term_window_label()` 纯函数，生成 `term-<uuid>`。
- `create_term_window(app, x, y)` 命令：用 `tauri::WebviewWindowBuilder` 新建窗口，
  URL 与主窗口相同，位置取传入的屏幕坐标，尺寸沿用 `tauri.conf.json` 里主窗口的宽高。
  成功返回 label，失败返回 `Err(String)`。
- 注册进 `generate_handler!`。
- **失败即降级**：创建失败只返回 `Err`，绝不 panic。

**注意**：`x`/`y` 是物理像素还是 CSS 像素、以及 Retina 下的换算，本项目在
`store/layout.ts` 的面板窗口联动里踩过（`PhysicalPosition` vs CSS 像素）。请先读那段
既有代码确认换算方向，并在注释里写清你用的是哪种坐标。

- [ ] **Step 5: 跑测试 + `cargo test` 全量 + `npm run build`**

- [ ] **Step 6: 跑 ACL guard**

`npx vitest run src/aclGuard.test.ts src/__tests__/tauriAcl.test.ts` —— 确认改 capability
之后没有引入未授权调用。

- [ ] **Step 7: 提交**

---

### Task 2: 拖出判定

**Files:**
- Create: `src/tabTearOut.ts`（纯逻辑）
- Modify: `src/components/TabBar.tsx`
- Test: `src/__tests__/tabTearOut.test.ts`、既有 TabBar 测试

**Interfaces:**
- Produces: `shouldTearOut(point, windowRect, tabCount): boolean` 纯函数。

- [ ] **Step 1: 先读既有拖拽实现**

`src/components/TabBar.tsx` 的 pointerdown/move/up + `setPointerCapture`，以及
`src/dragSafetyNet.ts`、`src/paneDrop.ts`。**你要加的是一个分支，不是另起一套拖拽。**

特别注意 `dragSafetyNet.ts` 顶部那段注释（为什么必须用 `setTimeout(fn, 0)` 而不是
`queueMicrotask`）——你的改动不得破坏它的前提。

- [ ] **Step 2: 写失败的测试**

```ts
import { describe, expect, it } from 'vitest'
import { shouldTearOut } from '../tabTearOut'

const RECT = { width: 1200, height: 780 }

describe('shouldTearOut', () => {
  it('落点在窗口内：不拖出', () => {
    expect(shouldTearOut({ x: 600, y: 400 }, RECT, 3)).toBe(false)
  })
  it('落点在窗口左侧之外：拖出', () => {
    expect(shouldTearOut({ x: -30, y: 400 }, RECT, 3)).toBe(true)
  })
  it('落点在窗口下方之外：拖出', () => {
    expect(shouldTearOut({ x: 600, y: 900 }, RECT, 3)).toBe(true)
  })
  it('只剩一个标签时永不拖出（等于把窗口整体搬走，没有意义）', () => {
    expect(shouldTearOut({ x: -30, y: 400 }, RECT, 1)).toBe(false)
  })
  it('边界上算窗口内', () => {
    expect(shouldTearOut({ x: 0, y: 0 }, RECT, 3)).toBe(false)
    expect(shouldTearOut({ x: 1200, y: 780 }, RECT, 3)).toBe(false)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

- [ ] **Step 4: 实现纯函数**

- [ ] **Step 5: 接进 TabBar**

拖拽过程中用 `shouldTearOut` 判定并给出「将拖出」的视觉提示；提示样式必须用主题 CSS
变量，风格与既有落点提示一致（先看 `DropIndicator.tsx` 怎么做的）。

`pointerup` 时若判定为拖出，**本任务先只打一条 `console.info` 占位**，实际交接由 Task 3/4
接手；落点回到窗口内则完全走既有逻辑。

- [ ] **Step 6: 跑全量确认既有拖拽测试一条不红**

既有的 TabBar / PaneDetach 拖拽测试是这次改动最可能误伤的地方，全部必须仍绿。

- [ ] **Step 7: 提交**

---

### Task 3: 滚屏序列化（需改受保护文件 TerminalView）

**Files:**
- Modify: `src/components/TerminalView.tsx`（**受保护文件，本任务获准改动，范围见下**）
- Create: `src/termSerialize.ts`
- Test: `src/__tests__/termSerialize.test.ts`

**Interfaces:**
- Produces: `registerSerializer(ptyId, fn)` / `serializeTerm(ptyId): string | null`

**对 `TerminalView.tsx` 的获准改动面（超出即为违规，须先上报）：**

1. `import { SerializeAddon } from '@xterm/addon-serialize'`
2. 在既有 addon 加载处（`FitAddon`/`WebglAddon` 旁边）多加载一个 `SerializeAddon`
3. 在既有的 `registerPaste(ptyId, …)` 调用旁，增加一行
   `registerSerializer(ptyId, () => serializeAddon.serialize())`
4. 在既有的清理函数里增加对应的注销调用

**不得**改动该文件的其它任何逻辑。`src/terminalPaste.ts` 的 `registerPaste`/`pasteTo`
是现成范例，`termSerialize.ts` 照它的模块级 Map 写法来。

- [ ] **Step 1: 读 `src/terminalPaste.ts`，照其写法建 `termSerialize.ts`**

- [ ] **Step 2: 写失败的测试**

覆盖：注册后能取到序列化结果；未注册的 ptyId 返回 `null`；注销后返回 `null`。
**「注册后取到的值」必须与「未注册时的返回值」不同**，否则是恒真断言。

- [ ] **Step 3: 跑测试确认失败**

- [ ] **Step 4: 实现 `termSerialize.ts`**

- [ ] **Step 5: 改 TerminalView（严格按上面四条）**

- [ ] **Step 6: 跑全量 + `npm run build`**

- [ ] **Step 7: 提交**

---

### Task 4: 交接握手与新窗口接管

**Files:**
- Create: `src/windowHandoff.ts`
- Modify: `src/components/TabBar.tsx`（把 Task 2 的占位换成真实调用）
- Modify: `src/App.tsx`（新窗口启动时的接管入口）
- Test: `src/__tests__/windowHandoff.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `create_term_window`、Task 3 的 `serializeTerm`
- Produces: `tearOutTab(tabId, screenPoint)`；接管载荷类型定义

- [ ] **Step 1: 定义握手协议与载荷类型**

按规格 §4.2 的六步。事件名与载荷字段先在报告里列清楚，后续任务与真机验收都要对照。

载荷至少含：`ptyId`、`sessionId`、`title`、`cwd`、`scrollback`、`cols`、`rows`。

- [ ] **Step 2: 写失败的测试**

必须覆盖（每条单独变异验证）：

- 完整成功路径：走完六步后，旧窗口的标签被移除、且**没有调用 `ptyKill`**
- 新窗口就绪超时：标签**仍在**旧窗口，且已请求关闭新窗口
- 接管确认超时：同上
- `create_term_window` 返回 `Err`：标签仍在，且**没有**创建窗口的残留

**「标签仍在」这类断言必须断言真实 store 状态**，不能只断言某个 mock 没被调用过——
本项目出过恒真断言的事故。

- [ ] **Step 3: 跑测试确认失败**

- [ ] **Step 4: 实现握手**

超时时长自己定一个合理值并在注释里说明依据。失败路径必须给用户可见提示（复用
`store/hint.ts` 的既有轻提示，先读它的用法）。

- [ ] **Step 5: 新窗口侧的接管**

新窗口启动后 emit 就绪事件；收到载荷后建标签与窗格、写入 `scrollback`、`attachPty`、
回 ack。**新窗口如何知道自己是「被拖出创建的」而不是主窗口**——用 label 前缀判断，
或由 Rust 在创建时告知，你选一种并说明理由。

- [ ] **Step 6: 跑全量 + `npm run build`**

- [ ] **Step 7: 提交**

---

### Task 5: 关窗只杀自己的 PTY + 跨窗口存活计数

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/closeRequest.ts`
- Test: Rust `#[cfg(test)]` + `src/__tests__/closeRequest.test.ts`

- [ ] **Step 1: 读既有关闭流程**

`lib.rs` 的 `on_window_event` / `emit_close_requested` / `confirm_exit`，以及
`src/closeRequest.ts` 全文。**⌘Q 的确认框是本项目重点保护的行为**（见
`replace_quit_menu_item` 上方长注释与 `QuitReplaced` 见证令牌），不得破坏。

- [ ] **Step 2: 写失败的测试**

- Rust：存活 PTY 计数命令返回值正确（用 `PtyManager` 造几个再数）
- 前端：`buildExitConfirmMessage` 在跨窗口计数下的文案正确（初始值与目标值必须不同）

- [ ] **Step 3: 跑测试确认失败**

- [ ] **Step 4: 实现**

- Rust 新增命令返回存活 PTY 总数，注册进 `generate_handler!`
- `closeRequest.ts` 改用它，不再遍历本窗口标签
- `lib.rs:438` 那句 `if window.label() != "main" { return }` 改为按窗口分别处理：
  **主窗口关闭 = 应用退出（保持现有确认流程）**；**非主窗口关闭 = 只关那一个窗口**，
  并只终止它自己持有的 PTY

- [ ] **Step 5: `cargo test` + `npx vitest run` + `npm run build`**

- [ ] **Step 6: 提交**

---

### Task 6: 菜单事件定向 + 主题跨窗口同步

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/menuEvents.ts`、`src/store/theme.ts`
- Test: 对应测试文件

- [ ] **Step 1: 菜单事件改定向**

`emit_open_settings` 与 `menu-theme-mode` 现在是 `app.emit` 广播，多窗口下点一次
「设置…」所有窗口都会弹。改为 `emit_to` 当前聚焦的窗口（`app.get_focused_window()`
之类；先查 tauri 2.11.5 的实际 API 名再写）。取不到聚焦窗口时降级为广播，并打警告。

- [ ] **Step 2: 主题跨窗口同步**

在一个窗口改主题后广播一个事件，其它窗口收到后重新应用主题。
**注意**：收到广播的窗口重新应用后**不得再次广播**，否则会形成循环。请写测试固化这一点。

- [ ] **Step 3: 每条都写测试并变异验证**

- [ ] **Step 4: `cargo test` + `npx vitest run` + `npm run build`**

- [ ] **Step 5: 提交**

---

## 真机验收（全部任务完成后，由控制者交付用户执行）

单元测试对跨窗口行为毫无信号，以下必须真机确认：

1. **新窗口里的功能真的能用**（ACL 作用域）——在新窗口里开终端、切主题、开设置，
   任何一项失灵都说明 capability 没覆盖到
2. 拖出后原会话继续运行、终端历史完整、颜色正确
3. 拖出失败时标签留在原窗口（可断网或人为制造失败）
4. ⌘Q 在多窗口下的确认框计数正确
5. 关掉一个非主窗口，其它窗口的会话不受影响
6. 点「设置…」只在当前聚焦窗口弹出
7. 在一个窗口改主题，其它窗口同步且不闪烁（无广播循环）
8. 只剩一个标签时拖出不触发
