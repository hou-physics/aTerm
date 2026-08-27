# aTerm

macOS 上专为 Claude Code agent 工作流设计的终端（Tauri 2 + React + xterm.js）。

设计文档：docs/superpowers/specs/2026-08-24-aterm-design.md
当前进度：P1（终端 + 主页 + 会话恢复）✅；P2 总览方块页开发中。

## 开发
npm install && npm run tauri dev
测试：cd src-tauri && cargo test；npx vitest run
打包：npm run tauri build

## 致谢
内置终端主题配色取自 [mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes)（MIT 许可证），见 `src/themes/data.ts` 与 `src/themes/LICENSE-iTerm2-Color-Schemes`。
