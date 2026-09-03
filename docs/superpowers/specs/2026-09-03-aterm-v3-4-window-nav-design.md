# aTerm V3.4 设计：新建窗口菜单项 + 标签拖到任意窗口

日期：2026-09-03
前置：V3.3（多窗口与标签拖出）已合并至 main，三条关键真机验收已通过

## 1. 目标

用户在 V3.3 真机验收后提出两点：

1. 能方便地开一个新窗口。原提法是 Dock 右键菜单；经查 tauri 2.11.5 / tao 0.35.3 /
   muda 0.19.3 均无 Dock 菜单公开 API（tao 的 AppDelegate 实现了 8 个委托方法，没有
   `applicationDockMenu:`），唯一路径是 ObjC 运行时动态加方法——正是 `lib.rs` 里 ⌘Q
   考据明确拒绝过的模式。**用户拍板改做菜单栏 File > 新建窗口 + ⌘N。**
2. 拖出去的标签能拖回来。**用户拍板做成通用的「拖到任意其它窗口的标签栏」**，不限于拖回
   主窗口；最后一个标签拖走后的空壳窗口自动关闭。

## 2. 已核实的前提

- **⌘N 未被占用**：`App.tsx` 的全局快捷键与 `lib.rs` 的菜单加速键都没有它。
- **File 菜单在 macOS 上存在**（V3.2a 终审 M6 已纠正：tauri 的 File 子菜单 cfg 是
  `not(any(linux, …))`，macOS 不在排除名单）。当前内容只有 Close Window。
- **按标题查找子菜单有先例**：`lib.rs` 的主题菜单用 `top_items.iter().find_map(...)`。
- **交接协议本身是窗口无关的**（`emitTo(label)` + 载荷 `toLabel` 校验 + 接收端
  `{target}` 限定，V3.3 Ruling 8 确立的两头防护）。拖回与拖出走同一条尾巴：
  序列化 → 交接 → 等 ack → 移除。差别只在不建新窗口、不等 ready。
- **主窗口目前不监听交接**：`windowHandoffReady` 对非 `term-*` 直接 return。
- **Rust 能枚举所有窗口的屏幕矩形**：`webview_windows()` + `outer_position()` +
  `outer_size()` + `scale_factor()`。
- **屏幕坐标契约已定**：`create_term_window(x, y)` 收逻辑像素，调用方直接传
  `PointerEvent.screenX/screenY`，V3.3 真机已验证新窗口落点正确。命中测试沿用同一契约。
- **标签栏高度约 33px**（`.tabbar` padding 6px + `.tab` 5+13+5 + 边框）。

## 3. 明确不做

- Dock 右键菜单（见 §1，用户已拍板不做）。
- 拖到目标窗口时的**实时落点指示**。目标窗口收不到指针事件（源窗口持有 capture），做实时
  提示要额外的跨窗口 hover 事件流。本次只做"松手即生效"，指示留待后续。
- 拖到目标窗口标签栏的**精确插入位置**。本次追加到末尾。
- 主窗口的自动关闭。主窗口永远不因标签为空而关闭。

## 4. 新建窗口菜单项

**File 子菜单**插入「新建窗口」，加速键 `Command+N`，位于 Close Window 之前、以分隔线隔开。

点击后调用既有的 `create_term_window`，位置**级联于当前聚焦窗口**（聚焦窗口左上角
+30/+30 逻辑像素；取不到聚焦窗口则用主窗口；主窗口也取不到则用默认位置）。

新窗口是普通的 `term-*` 窗口，**不带任何交接**：启动后显示主页，用户按常规方式开终端。
现有基础设施全部复用——ACL glob、关窗只杀自己的 PTY、交接监听、⌘Q 转主窗口。

**必须与 `QuitReplaced` 令牌链共存**：插入 File 菜单项在 `setup_macos_menu` 内、
`replace_quit_menu_item` 之后，与「设置…」同一段。它不碰 App 子菜单，不影响 Quit 的末位
下标；但仍走同一个函数，顺序由令牌保证。

## 5. 标签拖到任意窗口

### 5.1 命中测试

新增 Rust 命令：

```rust
#[tauri::command]
async fn window_at_point(app: AppHandle, x: f64, y: f64, exclude: String)
    -> Result<Option<WindowHit>, String>

struct WindowHit { label: String, local_x: f64, local_y: f64 }
```

`x`/`y` 是逻辑屏幕坐标（与 `create_term_window` 同契约）。遍历 `webview_windows()`，
**跳过 `exclude`**（源窗口——它正持有 capture、通常也是聚焦窗口，不排除就永远命中自己），
按每个窗口自己的 `scale_factor()` 把 `outer_position`/`outer_size` 转成逻辑像素做包含判定。
命中则返回该窗口 label 与点在其内容区的本地逻辑坐标。

**多个窗口重叠时**取第一个命中的，作为已知局限记入真机验收（tao 不暴露 z-order）。

包含判定提成纯函数单测（本仓库先例：`settings_insertion_index`、`term_window_config`）。

### 5.2 松手时的三路分流

源窗口 `pointerup` 且指针在源窗口外（沿用 V3.3 的判定与 40px 余量）时：

1. 调 `window_at_point(x, y, 本窗口 label)`。
2. **命中其它窗口且 `local_y < 标签栏落区高度`** → 交接给该窗口（§5.3）。
3. **命中其它窗口但不在标签栏落区** → **取消**，标签留在原处，不建窗口。
   理由：在别的窗口的终端区域松手，用户意图不明；在它上面再叠一个新窗口更不可能是本意。
4. **未命中任何窗口** → 走 V3.3 既有的建新窗口路径。

标签栏落区高度是前端常量（建议 40px，给 33px 的实际高度留余量），写在 `tabTearOut.ts`
旁并注明依据。

**`tabCount <= 1` 的守卫只对第 4 路生效**。把 `term-*` 窗口里最后一个标签拖到别的窗口
正是本功能的核心用例，不得被守卫拦下。主窗口的最后一个终端标签拖到别的窗口也允许——
主窗口留个主页不算空壳。

### 5.3 交接给已存在的窗口

复用 `tearOutTab` 的尾巴，抽成共享函数：

- 序列化滚屏（沿用 V3.3 Ruling 5：**发送那一刻**才序列化）
- `emitTo(目标 label, handoff, 载荷)`，载荷 `toLabel` = 目标
- 等 ack（沿用 5s 超时）
- ack 到 → `removeTabKeepingPty`；超时 → 标签留在原处 + 轻提示，**不关目标窗口**
  （它本来就在，不是本次建的）

**所有窗口都要监听交接**：`windowHandoffReady` 去掉 `isTornOutWindow` 对监听器的门禁；
就绪广播仍只由 `term-*` 发（主窗口不需要宣告就绪）。接收端的 `{target}` 限定与载荷
`toLabel` 校验原样保留——两头防护不因主窗口加入而松动。

目标窗口收到交接后追加标签到末尾并激活它。

### 5.4 空壳窗口自动关闭

`term-*` 窗口交接出**最后一个非主页标签**后，调既有的 `destroy_term_window` 关掉自己。
此时它不持有任何 PTY，`destroy` 绕过 CloseRequested 也不会误杀（V3.3 已核实 destroy 的
语义）。主窗口永不自动关闭。

**顺序**：先收到 ack、`removeTabKeepingPty` 完成、确认本窗口已无终端标签，**再** destroy。
不得在 ack 之前 destroy——那会让交接中的标签两边都没有。

## 6. 全局约束

见仓库根 `CLAUDE.md`。另：

- **受保护文件** `ConversationPanel.tsx` / `TerminalView.tsx` 本规格**不需要改动**。
- **⌘Q 那一整套不得破坏**：`replace_quit_menu_item` 长注释、`QuitReplaced` 令牌顺序不变式。
- **跨窗口事件两头防护**（V3.3 Ruling 8/15/17）：本规格不新增事件，但去掉主窗口的监听
  门禁后，主窗口首次成为交接接收方——其 `{target}` 与 `toLabel` 校验必须与 `term-*` 一致。
- 基线：前端 1045 / 72 文件；Rust 148；`npm run build` 干净；既有拖拽 91 条全绿。

## 7. 测试要求

前端：三路分流各一条（命中标签栏→交接、命中非标签栏→取消且标签仍在、未命中→建窗）；
`tabCount<=1` 守卫不拦交接路；ack 超时后标签仍在**且目标窗口未被关闭**；空壳自动关闭
只在无终端标签时触发、且在 ack 之后；主窗口永不自动关闭。**断言真实 store 状态。**

Rust：包含判定纯函数（含边界、DPR≠1、排除自身）；File 菜单项插入后 Close Window 仍在
且 Quit 仍是 App 子菜单末位；`QuitReplaced` 令牌链不受影响。

真机（单测零信号）：
1. ⌘N 与 File > 新建窗口 各开一个窗口，位置级联
2. 从 `term-*` 拖标签到主窗口标签栏 → 标签出现在主窗口末尾且激活，会话不断
3. 拖走 `term-*` 的最后一个标签 → 该窗口自动消失
4. 拖到另一个窗口的**终端区域**松手 → 什么都不发生，标签留在原处
5. 两个 `term-*` 之间互拖
6. 目标窗口被别的窗口部分遮挡时拖到遮挡区 → 观察命中哪个（已知局限）
7. Retina 与外接显示器混用时的命中精度

## 8. 风险

| 风险 | 应对 |
|---|---|
| 主窗口加入交接接收方后串扰面扩大 | 两头防护原样保留；测试替身 label 用非 `main` 值（Ruling 14） |
| 空壳自动关闭时序错误吃掉标签 | §5.4 顺序写死：ack → remove → 确认为空 → destroy |
| 命中测试的 DPR 换算 | 纯函数单测覆盖 DPR≠1；真机第 7 条 |
| File 菜单项破坏 ⌘Q 令牌链 | 在 `setup_macos_menu` 内、令牌之后；Rust 测试断言 Quit 仍末位 |
