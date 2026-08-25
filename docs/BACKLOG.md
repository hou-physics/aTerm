# aTerm 待办清单

> 由 P1 开发流水线（10 个任务 + 终审 + 用户验收）沉淀。P1 已合并进 main。

## P2：多对话实时监管（下一期）

按优先级：

1. **快照预览**（首位，用户已确认）
   点方块秒开只读会话文档，直接从 `~/.claude/projects/*.jsonl` 渲染——零等待、零 token、无需启动 claude。
   顶部「继续对话」按钮（或开始打字）才真正执行 `claude --resume`。
2. **对话目录**（并入快照，用户已确认框架）
   左栏列出用户提问（时间戳 + 摘要），点击滚动定位。原型已验证可行。
   需过滤噪音：技能调用样板文本、`[Request interrupted by user]` 等标记。
   定位：快照 = 阅读/导航面，终端 = 交互面，两者一键互跳；终端内「尽力而为定位」（search addon）为次要功能——终端滚动缓冲不含 resume 的历史，且 TUI 重绘/换行使定位脆弱。
3. **总览方块页**：状态色（蓝运行中/橙等回答/绿完成）、转圈、拖拽排布、重命名、按时间排序
4. **实时刷新**：FSEvents 监听 jsonl 增量解析
5. **hooks 一键安装**：`Notification` / `Stop` 两条，精准状态推送
6. **底部状态栏**：模型 · effort 强度 · 权限模式
7. **上下文用量徽章**

### P1 期间推迟到 P2 的 spec §5.1 项目
- 「打开文件夹」入口（把任意目录变成项目）——目前替代路径：主页命令框 `cd /path && claude`
- ⌘K 聚焦命令框
- 侧边栏「其他项目」列表 + 可折叠

推迟理由：P2 的总览工作必然重构主页/侧边栏，现在做会做两遍。

## 已知小问题（不影响使用，择机清理）

**前端**
- `useSessions.loading` 未被消费：首次加载期间主页会短暂显示「尚未发现会话」空状态
- 从终端标签切回主页不触发刷新（现依赖窗口 focus 事件）；新会话需切走再切回才出现
- `closeTab` 无重入防护：快速双击关闭按钮会弹两次确认
- 注入命令在 80×24 下启动，随后才 resize——Claude TUI 会重排一次
- `ptyBuffer` 的 `exited` / `buffers` map 不释放（每标签级别，量极小）
- rAF/ResizeObserver 时序竞态无自动化测试（jsdom 难以确定性模拟）

**Rust**
- 失效的 cwd 会被 portable-pty 静默降级到 `$HOME`，用户只看到「找不到会话」而无提示
- 空字符串标题（`Some("")`）理论上可穿透到 UI，需畸形记录才触发
- `is_uuid_stem` 不校验短横线位置（安全性由字符集保证，位置校验无增益）
- env 剥离测试未 `remove_var` 清理（并行测试的环境竞态隐患，test-only）

**工程**
- 脚手架身份未改名：`package.json` / `Cargo.toml` 仍是 `aterm-scaffold`、`"A Tauri App"`、`authors = ["you"]`；`index.html` 标题仍是 Vite 模板；`public/*.svg`、`src/assets/react.svg` 未引用
- `withGlobalTauri: true` + `"csp": null`：任何在 webview 执行的脚本都能调 `invoke('pty_spawn')`。当前无 XSS 入口（全部经 React 文本节点，xterm 不执行 HTML），属加固项而非在野漏洞——建议 P2 关掉并设置真实 CSP
- Vite 打包有 >500kB chunk 提示（仅建议性）

## 架构天花板（已向用户说明）

**终端滚动的颗粒感**：xterm.js 只能按整行移动内容（约 17px/行），Ghostty 等原生终端可按像素平移。已消除的是滚动链/回弹打架与频繁撞顶（`overscroll-behavior` + 10000 行缓冲）；剩余差距需换原生渲染器（SwiftTerm）才能消除，代价是牺牲 P4/P5 的 DAG 可视化所依赖的 Web 技术栈。若日后判断值得，可评估混合架构：终端原生渲染 + 其余 UI 保持 Web。

## 会话链的已知局限

`~/.claude/projects/` 的实际行为是：`--resume` 复用同一 sessionId 并**追加**到原文件（本机数据验证），因此多文件串链逻辑目前是防御性的空转。判定规则为「首条用户消息 uuid 相同即同链」——受「只读文件头部」约束，不做全量 uuid 交集比对；某些压缩/裁剪形态可能令链在极端情况下断开。详见 `docs/superpowers/specs/2026-08-24-aterm-design.md` §4。
