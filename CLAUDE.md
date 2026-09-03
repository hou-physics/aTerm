# aTerm

为 Claude Code 工作流定制的 macOS 终端。Tauri 2 + React 19 + TypeScript + Vite +
zustand + xterm.js 6。

## 命令

```bash
npx vitest run                 # 前端测试
cd src-tauri && cargo test     # Rust 测试（先 source 环境，见下）
npm run build                  # tsc + vite build
npm run tauri build            # 打包 .app / .dmg
```

**cargo 不在默认 PATH**。每个要跑 cargo 的 shell 必须先：

```bash
. "$HOME/.cargo/env"
```

不做这一步会误以为"机器上没有 Rust 工具链"——已经发生过不止一次。

## 硬约束

违反以下任何一条都是严重问题，不是风格偏好。

**本仓库没有 jest-dom。** 只用 vitest 内置断言。禁止 `toBeInTheDocument`、
`toHaveClass`、`toHaveValue`、`toHaveTextContent`——它们会让测试文件整个跑不起来。

**所有 UI 颜色必须取自主题 CSS 变量**，禁止硬编码 hex / rgb / hsl / 颜色名。
应用有 28 个主题 × 3 种模式，硬编码颜色必然在某些组合下不可读。可用变量见
`src/themes/derive.ts`。两处例外：`derive.ts` 本身是颜色推导层，用
`'#000000'`/`'#ffffff'` 作混色端点是既有惯例；主题色块预览用的 `theme.bg` /
`theme.fg` / `theme.ansi[i]` 是数据不是样式。

**受保护文件**：`src/components/ConversationPanel.tsx`、
`src/components/TerminalView.tsx`。改动前须获得用户明确批准，且改动面要严格限定在
批准范围内。

**localStorage 键名一律不得变更**：`aterm.overview.names`（别名）、
`aterm.library.hiddenProjects`、`aterm.library.removedSessions`、
`aterm-wheel-multiplier`、主题相关键。别名 key 格式 `${dirName}::${rootKey}`
（**双冒号**）同样不得变更——改任何一个都会静默作废用户已保存的数据。

**aTerm 对 `~/.claude` 只读**，唯一例外是 hooks 安装器（用户明确点击时）。

**测试绝不允许碰真实的 `~/.claude`**，一律用 tempfile 或 mock。

## 测试纪律

本项目已多次栽在"测试全绿但什么都没验到"上，以下不是建议：

**每条断言单独做变异验证。** 不许整个 `it` 块合并跑一次就宣称"确认过会失败"——
出过一条有效断言掩盖另一条死断言的事故。

**凡"改值后断言新值"的测试，初始值必须与目标值不同。** 出过 `beforeEach` 设
`catppuccin-latte`、点击 Catppuccin Latte、断言等于 `catppuccin-latte` 的恒真测试，
即使把 onClick 换成空函数也照样全绿。

**`queryByText` 用的是精确匹配。** `queryByText('Hooks：')` 永远返回 null，因为真实
渲染是 `"Hooks：未安装"` 这样的拼接文本——写断言字符串前先看实际渲染出来的文本。

**动手前先 grep 同类的既有实现。** 本仓库对"点外面关闭浮层"已有一套写法
（`ContextMenu.tsx` + `TabBar.tsx`，`pointerdown` + `contains()` + `setTimeout(0)`
延迟注册），凭空另写一套 `click` + `stopPropagation` 会漏掉"面板内按下、拖到遮罩上
松开"这种情形——合成 click 的 target 是最近公共祖先。

## 容易踩的既有坑

**`dragSafetyNet.ts` 的 `setTimeout(fn, 0)` 不能换成 `queryMicrotask`**——文件顶部
有长注释解释原委，曾经用过微任务并踩坑改回。

**模拟一次原生 pointerup 时，捕获与冒泡阶段必须在同一个 `act()` 里。** 拆成两个
`await act(...)` 会引入真实浏览器不存在的宏任务边界，与 `dragSafetyNet` 的
`setTimeout(0)` 形成竞态，表现为约 8~12% 的低频 flaky。`TabBar.test.tsx` 相关用例
上方有详细注释。

**单元测试对 ACL 与打包行为毫无信号。** `core:window:allow-set-size` 未授权曾导致
面板窗口联动在打包版里完全失效，而当时 748 个测试全绿。凡涉及 ACL、原生菜单、多
窗口的改动，必须真机验收。`src/aclGuard.ts` 是为此建的守卫，改动后记得跑。

**Tauri 自定义命令不需要 ACL 条目**。经 `generate_handler!` 注册的命令不受
capability 的 `windows`/`permissions` 门禁（本仓库无 app ACL manifest）。受约束的只有
`core:*` / `dialog:*` 等插件命令。

**macOS 的 ⌘Q 拦截靠替换菜单项实现**。`muda` 的默认 Quit 项直接绑 AppKit 的
`terminate:`，不经过 tao 事件循环，`RunEvent::ExitRequested` 拦不住。`lib.rs` 里
`replace_quit_menu_item` 上方有完整考据，并用见证令牌类型把"必须先替换再插入其它菜单
项"这条顺序不变式变成了编译期约束。

## 开发流程

规格写在 `docs/superpowers/specs/`，实施计划写在 `docs/superpowers/plans/`。
多任务的实现走 superpowers 的 subagent-driven-development，执行账本在
`.superpowers/sdd/<plan-name>/progress.md`（该目录被 gitignore）。

派生 subagent 时**不要使用 fable 模型**。
