# aTerm V3.1a 设计：列表与菜单

日期：2026-08-30
分期：V3.1a（V3.1 的前一半，见文末「V3 全景」）
分支：`feature/v3-1a-lists-menus`
基线：`main` @ `e49537f`（V3.0 已合并）；前端 653 测试 / 43 文件，Rust 112 测试

---

## 1. 范围

用户 13 条需求里属于「侧栏 / 主页 / 标签栏三个列表面」的部分，加两笔 V3.0 终审留下的账：

| # | 来源 | 内容 |
|---|---|---|
| 4 | 原始 13 条 | 最近会话条目太少，下方空间未利用 |
| 5 | 原始 13 条 | 右键菜单：项目→进入文件夹；会话→改名、定位文件夹；项目→隐藏（可撤回） |
| 7 | 原始 13 条 | 最近会话右键移除，下次再用时自动出现 |
| 10 | 原始 13 条 | `＋` 按钮改成多选项（终端 / 项目 / 项目内新对话 / 选某条会话） |
| 11 | 原始 13 条 | 最近会话双击才打开，防误触 |
| C | V3.0 终审 | `resumeThread` 也传 `sessionId`，让 `--resume` 窗格也能自愈 |
| D | V3.0 终审 | 列表仍直接渲染 `t.title`，未命名会话显示 uuid 前 8 位 |

**不在本文范围**：V3.1b（面板按钮位置、拖图片变附件、分屏窗格交换——都涉及受保护文件或拖放）、V3.2（菜单栏、多窗口）。

**本文不修改任何受保护文件**（`ConversationPanel.tsx`、`TerminalView.tsx`）。

## 2. 勘察结论

以下全部已在本机核实：

**2.1 第 4 条不需要动布局。**
`App.css:53` 已经是 `.sidebar-list { flex: 1; min-height: 0; overflow-y: auto; }`——侧栏列表本就填满剩余高度并滚动，主题/hooks 那排通过 flex 自然钉在底部。"下方空间没被利用"完全是 `Sidebar.tsx:37` 的 `.slice(0, 12)` 造成的。**去掉这个上限即可，无需任何 CSS 改动。**

**2.2 第 10 条要的东西已经存在，只是接错了地方。**
`PanePicker.tsx` 当前提供：搜索框、「最近会话」（点击直接 resume）、「全部项目」（可展开看该项目全部会话）、「新终端」、「新对话」。这正是第 10 条描述的界面。它只被接在 ⌘D 产生的空窗格上。
`＋` 按钮（`TabBar.tsx:392`）现在是 `onClick={() => void newTerminal()}`，直接开空 shell。

**2.3 别名已存在，但只服务总览页，且键格式与 `threadKey` 不同。**
`store/overview.ts` 有 `names: Record<string, string>`，持久化在 `localStorage` 的 `aterm.overview.names`，键由 `blockKey(dirName, rootKey)` 生成，格式是 `${dirName}::${rootKey}`（**双冒号**）。
而 `actions.ts` / `paneReconcile.ts` 的 `threadKey` 是 `${dirName}:${rootKey}`（**单冒号**）。
两者不可混用。

**2.4 `useHint` 目前只能显示一句话。**
`store/hint.ts`：`show(msg: string)`，2200ms 后自动清空，无动作、不可点。撤销提示需要扩展它。

**2.5 仓库目前没有任何「打开外部程序」的能力。**
`src-tauri` 的全部命令都是 PTY、会话读取、hooks 安装。「在访达中显示」是新增的一类能力。

## 3. 新 store：`src/store/library.ts`

一份 store，三份持久化数据，服务侧栏、主页、总览三个列表面。

```ts
type LibraryState = {
  /** 会话别名。键格式见 §3.1。 */
  aliases: Record<string, string>
  /** 主页上被隐藏的项目，按 dirName。 */
  hiddenProjects: Record<string, true>
  /** 从「最近会话」移除的会话 → 移除时刻的毫秒时间戳。 */
  removedSessions: Record<string, number>

  rename(key: string, name: string): void      // 空白视为清除
  clearAlias(key: string): void
  hideProject(dirName: string): void
  unhideProject(dirName: string): void
  removeSession(key: string): void             // 记下 Date.now()
  restoreSession(key: string): void
}
```

### 3.1 键格式：**沿用总览页现有的 `${dirName}::${rootKey}`，不换成 `threadKey`**

理由：用户已经改过的会话名存在 `aterm.overview.names` 里、键是双冒号格式。改成单冒号会让**这些名字一次性全部作废**（键对不上，读出来是空）。别名从总览「提升」为全局是**搬家，不是重建**。

因此：
- `library.ts` 直接复用 `overview.ts` 已导出的 `blockKey(dirName, rootKey)`；
- 别名的 `localStorage` 键**保持** `aterm.overview.names` 不变（键名带 `overview` 只是历史包袱，改名同样会丢数据）；
- 新增的两份数据用新键：`aterm.library.hiddenProjects`、`aterm.library.removedSessions`。

`overview.ts` 里的 `names` / `rename` / `clearName` 迁出到 `library.ts`，总览页改为从 `library` 读——**同一份数据、同一个存储位置**，只是持有者换了。`overview.ts` 保留 `order` / `positions` 及 `blockKey`。

### 3.2 派生查询（纯函数，不放进 store）

放在 `src/sessionList.ts`（与 store 分开，便于单测）。**不要**叫 `src/library.ts`——那与
`src/store/library.ts` 只差一层目录，import 时极易看错；本仓库的惯例本就是纯函数放
`src/*.ts`（`paneReconcile.ts` / `fileDrop.ts` / `wheel.ts`）、store 放 `src/store/*.ts`，
但两者不应重名。`groupRecentByDate`（§5）也放这个文件。

```ts
/** 列表里该显示的标题。优先级：用户别名 > 真实标题 > 「新对话」。
 *  最后一档解决 V3.0 终审留下的 D：thread.titled 为 false 时 thread.title 是
 *  session_id 前 8 位的回退值，直接渲染会让列表里出现一串 uuid。 */
export function displayTitle(
  thread: { rootKey: string; title: string; titled: boolean },
  dirName: string,
  aliases: Record<string, string>,
): string

/** 该会话此刻是否应从「最近会话」中隐去。移除后又有新活动就自动回归——
 *  这实现了用户要求的「下次再用它的时候默认可以出现」，不需要任何额外 UI。 */
export function isSessionRemoved(
  removedAtMs: number | undefined,
  lastActivityMs: number,
): boolean   // removedAtMs !== undefined && lastActivityMs <= removedAtMs
```

## 4. 共享选择器：`src/components/SessionPicker.tsx`

把 `PanePicker.tsx` 的**选择界面**原样抽出，动作参数化：

```ts
type Pick =
  | { kind: 'shell' }
  | { kind: 'newConversation'; project: ProjectInfo }
  | { kind: 'resume'; project: ProjectInfo; thread: ThreadInfo }

export function SessionPicker({ onPick }: { onPick: (p: Pick) => void })
```

两个消费者：

- `PanePicker.tsx` —— 保留自身文件与定位逻辑，内部渲染 `<SessionPicker>`，`onPick` 走 `startPaneTerminal`（填充这个空窗格）；
- `TabBar.tsx` 的 `＋` —— 弹出一个浮层，渲染同一个 `<SessionPicker>`，`onPick` 走 `openTerminal` / `newConversation` / `resumeThread`（新建标签）。

**这是本设计里唯一的"新 UI"**，而它其实是既有 UI 的第二个入口。不写多级下拉菜单：项目/会话一多就不可用，且要新造一套子菜单机制。

`＋` 的浮层用既有的 `ContextMenu.tsx` 那套 portal 定位手法（它已被标签右键菜单与窗格标题栏复用两次），不引入第三套浮层机制。

**⌘T 保持原样，仍然直接新建一个空终端标签，不弹选择器。** 两者分工：⌘T 是「我就要一个 shell」的
快捷路径，`＋` 是「我要挑一下」的浏览路径。把 ⌘T 也改成弹浮层会让最常用的快捷键多一次交互。

## 5. 侧栏（`Sidebar.tsx`）

**容量**：删掉 `.slice(0, 12)`。列表本就填满高度并滚动（§2.1）。

**日期分组**：按 `lastActivityMs` 分「今天 / 昨天 / 更早」三组，组标题复用既有的 `.section-label` 样式。分组是纯函数：

```ts
export function groupRecentByDate<T extends { lastActivityMs: number }>(
  items: T[], now: number,
): { label: '今天' | '昨天' | '更早'; items: T[] }[]   // 空组不产出
```

**单击选中、双击打开**：单击只设选中态，双击才 `resumeThread`。

选中态是 `Sidebar` 组件内部的 `useState<string | null>`（存 `blockKey`），**不进 store、不持久化**
——它是一次性的视觉焦点，不是需要跨组件或跨会话共享的状态。高亮用一个 class，颜色取主题变量。

与既有拖拽的关系：`Sidebar.tsx` 的条目已经是拖拽源（拖进窗格区）。拖拽阈值判定（`DRAG_THRESHOLD_PX`）与"是否算一次点击"的既有逻辑**不动**；双击判定加在其上——一次真正的拖拽之后不应触发打开（既有的 `suppressClickRef` 已经在做这件事）。

**右键菜单**（复用 `ContextMenu.tsx`）：

| 项 | 动作 |
|---|---|
| 重命名 | 就地编辑该行标题，回车提交、Esc 取消、空白视为清除别名 |
| 在访达中显示 | `revealInFinder(project.cwd)` |
| 从列表移除 | `removeSession(key)` |

## 6. 主页（`HomePage.tsx`）

**项目卡片右键菜单**：

| 项 | 动作 |
|---|---|
| 在访达中显示 | `revealInFinder(p.cwd)` |
| 隐藏项目 | `hideProject(p.dirName)` + 可撤销轻提示 |

**隐藏过滤**：`hiddenProjects` 里的项目不出现在主页卡片列表。**搜索结果不过滤**——用户明确搜某个东西时把它藏起来只会让人以为坏了。

**撤销**：`useHint` 扩展为可带一个动作：

```ts
show(msg: string, action?: { label: string; onClick: () => void }): void
```

隐藏时 `show('已隐藏 <项目名>', { label: '撤销', onClick: () => unhideProject(dirName) })`。

**永久管理入口留到 V3.2 的设置面板**（用户明确选择：不在主页底部常驻）。这意味着**本期内，轻提示消失后就无法在应用内取消隐藏**——这是已知且被接受的取舍，撤销提示是唯一的安全阀。V3.2 必须补上管理入口。

## 7. 新 Rust 命令：`reveal_in_finder`

```rust
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String>
```

- 先 `Path::new(&path)`，要求 `is_dir()` 为真——不存在或不是目录直接返回错误，不调用任何外部程序；
- `std::process::Command::new("open").arg(&path).spawn()`，**路径作为独立参数，不经 shell、不做任何字符串拼接**；
- 失败时返回用户可读的中文错误，由调用方走 `useHint` 显示。

放在新文件 `src-tauri/src/reveal.rs`，在 `lib.rs` 的 `invoke_handler` 注册。

**为什么校验 `is_dir` 而不只是 `exists`**：本命令的两个调用点传的都是项目 cwd，语义就是「打开这个文件夹」。收窄到目录既符合语义，也把「拿它去打开任意文件」这条路关上。

## 8. 两处小改

**C（终审留账）**：`actions.ts` 的 `resumeThread` 增加 `sessionId: t.resumeSessionId`。该 id 必在这条链的 `sessionIds` 里，因此 `--resume` 起的窗格此后也能被 `reconcilePanes` 对账——修掉「被 resume 的链此前无用户消息时，发第一句话后 rootKey 翻转、该窗格永久失联」这个缺口。

**D（终审留账）**：侧栏、主页、总览三处列表的标题渲染改走 `displayTitle`（§3.2）。

## 9. 测试策略

沿用既有约束：

- **本仓库没有 jest-dom**。断言只用 `toBe()` / `toBeTruthy()` / `toBeNull()` / `classList.contains()`。
- **测试绝不碰真实 `~/.claude`**；Rust 一律 `tempfile`。
- **颜色一律取主题 CSS 变量**，禁止硬编码色值。
- 每个测试必须能回答「它会因为什么而失败」。

| 对象 | 测法 |
|---|---|
| `displayTitle` | 纯函数：别名优先 / 无别名用真实标题 / `titled:false` 时给「新对话」而非 uuid 前 8 位 |
| `isSessionRemoved` | 纯函数：未移除 / 移除后无新活动（隐去）/ 移除后有新活动（回归）/ 边界 `lastActivityMs === removedAtMs` |
| `groupRecentByDate` | 纯函数：三组齐全 / 空组不产出 / 跨午夜边界 / 全部同一天 |
| `library` store | 迁移后仍能读到旧的 `aterm.overview.names` 数据（**这条最重要**：键格式一改就会静默丢名字）；rename 空白视为清除；hide/unhide 往返 |
| `SessionPicker` | 抽取属于重构，`PanePicker.test.tsx` 既有用例必须原样通过；另加 `＋` 入口的用例（点 ＋ → 选一条会话 → 新建了标签而非填充窗格） |
| 双击/单击 | store 层断言：单击只改选中态不开标签；双击才开 |
| `reveal_in_finder` | Rust 单测：不存在的路径返回错误且**不 spawn**；文件（非目录）同样拒绝。不测真的打开访达 |

## 10. 明确不做

- 不做多级下拉菜单（`SessionPicker` 复用取代它）；
- 不在主页底部常驻「已隐藏 N 个」（用户明确选择放进 V3.2 设置）；
- 不做项目重命名（第 5 条只要求会话改名）；
- 不改别名的存储键与分隔符（§3.1）；
- 不动 `.sidebar-list` 的布局 CSS（§2.1）。

## 11. 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 别名迁移改动键格式 | **用户已改的会话名全部作废** | §3.1 明确沿用旧键与旧分隔符；测试里专门有一条「迁移后仍读得到旧数据」 |
| 隐藏项目在本期不可逆 | 用户误隐藏后要等 V3.2 才能恢复 | 撤销轻提示是安全阀；V3.2 必须补管理入口（已写入 §6 与 V3 全景） |
| 去掉 12 条上限后侧栏渲染量变大 | 会话极多时首屏变慢 | 列表本就 `overflow-y: auto`；DOM 节点数与项目数同阶，实测再优化，不预先做虚拟滚动（YAGNI） |
| `SessionPicker` 抽取破坏 ⌘D 既有行为 | 分屏选择器坏掉 | `PanePicker.test.tsx` 的既有用例必须原样通过，作为重构的安全网 |
| 双击改动与既有拖拽手势冲突 | 拖拽后误触发打开 | 既有 `suppressClickRef` 已处理"拖拽后补发的 click"；双击判定叠加其上，并补一条回归测试 |

## V3 全景

| 期 | 主题 | 状态 |
|---|---|---|
| V3.0 | 新对话身份 · 滚轮 · 文件拖放 | **已合并**（`e49537f`）。中文输入法未做 |
| **V3.1a**（本文） | 列表与菜单 | 进行中 |
| V3.1b | 面板按钮位置 · 拖图片变附件 · 分屏窗格交换 | 待做。**两个受保护文件都在这批** |
| V3.2 | 主题/hooks 进菜单栏 · 多窗口 · 设置面板（含滚轮滑块、**隐藏项目管理**） | 待做 |
