# aTerm

macOS 上专为 Claude Code agent 工作流设计的终端（Tauri 2 + React + xterm.js）。

设计文档：docs/superpowers/specs/2026-08-24-aterm-design.md
当前进度：P1（终端 + 主页 + 会话恢复）✅；P2 总览方块页开发中。

## 开发
npm install && npm run tauri dev
测试：cd src-tauri && cargo test；npx vitest run
打包：npm run tauri build
