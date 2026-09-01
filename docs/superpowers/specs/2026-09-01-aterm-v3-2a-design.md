# aTerm V3.2a 设计：设置面板 + macOS 菜单栏

日期：2026-09-01
分支基线：`main` @ `1b013ce`

## 1. 背景与目标

侧栏底部现在堆着两个常驻控件——`HooksControl`（hooks 安装器）和 `ThemeSwitcher`
（主题选择器）。两者都是低频操作却长期占据视觉空间，且主题选择器展开后是一个
28 行的弹出面板，在侧栏这个窄容器里很局促。

本次把这两个控件从侧栏移走，改为：

- **侧栏底部只留一个齿轮按钮**，点开一个应用内设置浮层；
- 主题选择器、hooks 安装器、以及此前没有 UI 入口的滚动速度、隐藏项目/移除会话
  的管理，全部收进这个设置浮层；
- **macOS 菜单栏**新增「设置… ⌘,」入口与「主题模式」三项，让常用切换不必先开浮层。

### 明确不做（本规格范围外）

- **主题列表不进原生菜单栏**。Tauri 2 的 `CheckMenuItem` 不支持图标、`IconMenuItem`
  不支持勾选态（已核验 `@tauri-apps/api/menu/checkMenuItem.d.ts` 与
  `iconMenuItem.d.ts`，二者互斥），28 个主题若进菜单只能二选一地丢掉色块预览或丢掉
  原生勾选。经用户拍板：完整选择器（含色块）留在设置浮层，菜单栏只放模式三项。
- **hooks 不进原生菜单栏**。hooks 安装有「安装中…」与错误文本两种状态，原生菜单项
  无处承载错误信息。经用户拍板：留在设置浮层。
- 多窗口 / 标签拖出成窗口 —— 那是 V3.2b，另立规格。

## 2. 全局约束

以下每一条都对本规格的所有任务生效。

- **本仓库没有 jest-dom。** 只用 vitest 内置断言。禁止 `toBeInTheDocument`、
  `toHaveClass`、`toHaveValue`、`toHaveTextContent`。
- **所有颜色必须取自主题 CSS 变量**，禁止硬编码 hex / rgb / hsl / 颜色名。
  应用有 28 个主题 × 3 种模式，硬编码颜色会在其中某些组合下不可读。
  当前可用变量（见 `src/themes/derive.ts`）：`--color-bg`、`--color-panel`、
  `--color-elevated`、`--color-border`、`--color-text`、`--color-text-dim`、
  `--color-text-faint`、`--color-accent`、`--color-accent-text`、`--color-on-accent`、
  `--color-term-bg`、`--color-status-*`、`--color-tab-close-hover-*`。
- **受保护文件**：`src/components/ConversationPanel.tsx`、
  `src/components/TerminalView.tsx`。本规格不需要改动它们；若某任务认为必须改，
  停下来上报，不要自行改。
- **localStorage 键名一律不得变更。** 涉及本规格的既有键：
  `aterm.overview.names`（别名）、`aterm.library.hiddenProjects`、
  `aterm.library.removedSessions`、`aterm-wheel-multiplier`、主题相关键。
  别名的 key 格式 `${dirName}::${rootKey}`（双冒号）同样不得变更——改任何一个都会
  静默作废用户已保存的数据。
- **aTerm 对 `~/.claude` 只读**，唯一例外是 hooks 安装器（用户明确点击时）。
- **测试绝不允许碰真实的 `~/.claude`**，一律用 tempfile 或 mock。
- 测试：`npx vitest run`（基线 795 通过 / 57 文件）、`cargo test`（基线 115 通过）。
  构建：`npm run build`。

## 3. 设置浮层

### 3.1 形态与交互

应用内第一个自实现的模态浮层——退出确认走的是 Tauri 原生对话框，代码库里没有
现成的模态组件可抄，因此本节的细节需要完整实现，不能假定已有基础设施。

- 覆盖整个窗口的遮罩 + 居中的面板。
- 三种关闭方式都必须可用：`Esc` 键、点击遮罩区域、面板右上角关闭按钮。
  点击面板**内部**不得关闭。
- 打开时焦点移入面板；关闭时焦点还给触发它的元素（齿轮按钮）。
- 面板内容超出高度时自身滚动，遮罩不滚动。
- 遮罩颜色**必须新增一个派生 CSS 变量**（如 `--color-scrim`），在
  `src/themes/derive.ts` 里按主题的 bg 推导，不得硬编码 `rgba(0,0,0,.5)` 之类。

### 3.2 分区与内容

面板分四个分区，顺序如下：

**① 外观**
- 主题模式三选一，标签沿用 `ThemeSwitcher.tsx` 现有的 `MODE_LABEL`，逐字不变：
  `default` → 「默认」、`dual` → 「双主题跟随系统」、`single` → 「手动选定」。
- 主题选择器：把 `ThemeSwitcher.tsx` 里的 `ThemeRow` / `ThemeList` 及其色块预览
  （bg、fg、ansi[1]、ansi[2]、ansi[4]）原样迁入，行为不变：
  - `dual` 模式显示「亮色」「暗色」两个列表；
  - `single` 模式显示单个全量列表；
  - `default` 模式不显示列表（该模式固定用 `DEFAULT_THEME`，见 `theme.ts:143`）。
- 迁入后浮层里有了模式切换，菜单栏里也有——两者操作同一个 store，天然同步。

**② 终端**
- 滚动速度滑块，绑定 `useLayout` 的 `wheelMultiplier` / `setWheelMultiplier`。
- 取值范围与默认值必须用 `layout.ts` 里已有的常量，不得另写字面量：
  `WHEEL_MULTIPLIER_DEFAULT = 1.5`、最小 `1`、最大 `6`（`WHEEL_MULTIPLIER_MIN` /
  `WHEEL_MULTIPLIER_MAX` 目前未导出，需要导出后引用）。步长 `0.5`。
- 滑块旁显示当前数值。
- `setWheelMultiplier` 已自带 clamp 与持久化，不要在 UI 层重复实现。

**③ 项目与会话**
- 「隐藏的项目」列表：来自 `useLibrary` 的 `hiddenProjects`（键是 `dirName`），
  每项一个「取消隐藏」按钮，调用 `unhideProject(dirName)`。
- 「已移除的会话」列表：来自 `removedSessions`（键是 `${dirName}::${rootKey}`），
  每项一个「恢复」按钮，调用 `restoreSession(key)`。
- 两个列表为空时各自显示一句说明，不要显示空框。
- 会话项展示名优先用别名（`useLibrary.aliases` 里同 key 的值），没有别名时展示
  原始 key——不要在这里重新实现 `displayTitle`，那需要 thread 对象，此处没有。

**④ Hooks**
- 把 `HooksInstall.tsx` 里的 `HooksControl` 整体迁入，行为、文案、状态标签
  （未安装 / 待更新 / 已安装）全部不变。
- 主页顶部的 `HooksPromptBar` **保持原样不动**，它不在本次迁移范围内。

### 3.3 状态

新增 `src/store/settings.ts`，只管浮层的开关：

```ts
type SettingsState = {
  open: boolean
  openSettings(): void
  closeSettings(): void
}
```

不要塞进 `src/store/layout.ts`——那个文件已经承载了面板宽度、折叠、窗口尺寸联动、
滚轮倍率等多项职责，继续堆积会让它更难读。

浮层开关状态**不持久化**：重启应用后设置浮层应当是关闭的。

## 4. macOS 菜单栏

### 4.1 为什么在 Rust 侧做

`@tauri-apps/api/menu` 可用，理论上能从前端构建菜单。但本次菜单只有 4 个项，
在 Rust 侧扩展已有代码更划算，主要理由按重要性排序：

1. **不冒冲掉自定义 ⌘Q 项的风险。** 前端若调 `Menu.setAsAppMenu()` 整体替换菜单，
   `replace_quit_menu_item` 精心做出来的自定义 Quit 项就没了——那个项是为了拦截
   ⌘Q 弹确认框而存在的，背景见 `src-tauri/src/lib.rs` 中该函数上方的长注释。
2. **不扩大 ACL 面。** `core:menu` 是独立模块，有 44 条权限
   （已核验 `src-tauri/gen/schemas/acl-manifests.json`）。走 JS API 需要逐条审查并
   授权其中若干条；走 Rust 侧则完全不碰 ACL——应用自定义命令经 `generate_handler!`
   注册后直接可调用，不需要 ACL 条目。

### 4.2 默认菜单的实际结构（已核验）

读 `tauri-2.11.5/src/menu/menu.rs` 的 `Menu::default`（本机 crate 源码）确认，
macOS 下：

- 顶层顺序：**App / Edit / View / Window / Help**；
- App 子菜单顺序：**About / 分隔线 / Services / 分隔线 / Hide / HideOthers /
  分隔线 / Quit** —— 与 `replace_quit_menu_item` 注释里写的完全一致。

实现时仍需在运行时打印一次实际结构做二次确认，不要仅凭本节。

### 4.3 菜单项

**App 菜单（第一个顶层菜单）**：在 About 之后插入「设置…」，快捷键 `Command+,`。
按 macOS 惯例，其前后各有一条分隔线。

**新增顶层「主题」菜单**：三个 `CheckMenuItem`，标签与 `MODE_LABEL` 逐字一致
（「默认」「双主题跟随系统」「手动选定」），任意时刻恰好一个处于勾选态。

位置：**追加到顶层菜单末尾**（`menu.append`）。理由是 `replace_quit_menu_item` 靠
`top_items.first()` 找 App 菜单，追加到末尾永远不会扰动这个假设；顶层菜单之间的
先后只是观感问题，不值得为此引入下标计算。

### 4.4 与既有 ⌘Q 改造的关系（关键风险）

`replace_quit_menu_item` 用 `items.len() - 1` 定位 Quit 项，并在注释里写明它依赖
默认菜单的固定顺序（About / 分隔线 / Services / 分隔线 / Hide / HideOthers /
分隔线 / Quit）。往 App 菜单里插入新项会改变项数。

**要求：**

1. `replace_quit_menu_item` **必须先执行**，插入「设置…」在其之后——保持那段已经
   过真机验证的代码看到的菜单结构与今天完全一致。
2. 插入位置必须在 Quit **之前**，使 Quit 仍是最后一项。
3. 必须新增 Rust 测试，断言插入之后 App 子菜单的最后一项仍是自定义 Quit 项
   （id == `QUIT_MENU_ITEM_ID`）。
4. **必须实测**：打包构建后真机验证 ⌘Q 仍然弹确认框、⌘, 仍然打开设置浮层。
   这一条不可用单元测试替代——本项目有过「748 个测试全绿、打包后功能完全没有」
   的先例（`core:window:allow-set-size` 未授权导致面板窗口联动失效）。
5. 沿用现有的失败即降级策略：菜单构建若返回 `Err`，打印警告后继续启动，
   绝不 panic。应用能打开比菜单项齐全重要。

### 4.5 状态同步

前端是主题模式的唯一真相来源（持久化在 localStorage）。同步是双向的：

**Rust → 前端**：点击菜单项时 `emit` 事件，沿用现有 `app-close-requested` 的广播
模式。两个事件：

- `menu-open-settings`：无 payload，前端调用 `openSettings()`。
- `menu-theme-mode`：payload 是模式字符串（`"default"` / `"dual"` / `"single"`），
  前端调用 `setMode(payload)`。

**前端 → Rust**：新增命令同步勾选态。

```rust
#[tauri::command]
fn set_theme_mode_checked(app: AppHandle, mode: String) -> Result<(), String>
```

必须**显式设置全部三项**的 checked 状态（恰好一个 true），不能只设一项：
macOS 点击 `CheckMenuItem` 时系统会自行切换其勾选态，不重置其余两项就会出现
多个勾选。

调用时机：应用启动、前端 store 就绪后调用一次；此后每次 `setMode` 之后再调用。

**应用自定义命令不需要 ACL 条目**（`generate_handler!` 注册的命令直接可调用），
但改动落地后仍需跑一遍仓库里的 ACL guard，确认没有引入未授权的 `core:*` 调用。

## 5. 侧栏改动

`src/components/Sidebar.tsx`：

- 删除 `<HooksControl />` 与 `<ThemeSwitcher />` 两处渲染及其 import。
- 底部改为一个齿轮按钮，点击调用 `openSettings()`。按钮需有可访问名称
  （如 `aria-label="设置"`）。
- `ThemeSwitcher.tsx` 与 `HooksInstall.tsx` 里被迁走的部分：`HooksPromptBar` 仍在
  `HomePage` 使用，必须保留；`ThemeSwitcher` 组件本身若已无任何使用者则删除，
  但其内部的 `ThemeRow` / `ThemeList` / `MODE_LABEL` / `LIGHT_THEMES` /
  `DARK_THEMES` / `PREVIEW_ANSI_INDEXES` 需要迁入设置浮层继续使用。
  **迁移前先 grep 确认使用者**，不要凭印象删。

## 6. 测试要求

前端（vitest + React Testing Library，无 jest-dom）：

- 浮层开关：齿轮按钮点击后打开；`Esc`、点遮罩、点关闭按钮三种方式各自能关；
  点面板内部不关。
- 滚动速度滑块：改变值后 `useLayout.getState().wheelMultiplier` 确实变化，
  且超出范围的输入被 clamp 到 `[1, 6]`。
- 隐藏项目/移除会话：列表渲染正确；点「取消隐藏」后 `useLibrary` 里对应项消失；
  空列表时显示说明文案。
- 主题选择：在 `dual` 模式下选择亮色主题，`useTheme.getState().lightThemeId` 变化。
- 侧栏：不再渲染主题选择器与 hooks 控件；齿轮按钮存在且有可访问名称。
- **断言真实 store 状态，不要只断言某个 mock 被调用过。**

Rust（cargo test）：

- App 子菜单在插入「设置…」之后，最后一项仍是 id 为 `QUIT_MENU_ITEM_ID` 的项。
- 「主题」菜单三项的 id 与预期一致。
- `set_theme_mode_checked` 对三个非法/合法输入的行为：合法模式恰好勾选一项；
  非法字符串返回 Err 且不改变任何勾选态。

## 7. 风险清单

| 风险 | 应对 |
|---|---|
| 插入菜单项破坏 `replace_quit_menu_item` 的下标假设 | §4.4：先替换后插入 + Rust 测试 + 真机验收 |
| 单元测试全绿但打包后菜单/浮层不工作 | §4.4 第 4 条：强制真机验收，有先例 |
| `CheckMenuItem` 被系统自动切换导致多项勾选 | §4.5：每次显式设置全部三项 |
| 遮罩颜色硬编码导致某些主题下不可读 | §3.1：新增派生 CSS 变量 |
| 迁移时误删仍在使用的导出 | §5：迁移前先 grep 确认使用者 |
