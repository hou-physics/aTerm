/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // TZ 钉死为非 UTC 时区：groupRecentByDate（src/sessionList.ts）用 setHours(0,0,0,0)
  // 取本地零点。在 TZ=UTC 下跑，setHours 与 setUTCHours 完全等价，午夜边界用例
  // （sessionList.test.ts 的 lastActivityMs === todayMs 那条）会失去区分力——实现
  // 若把 `>=` 误写成 `>`，那条用例在 UTC 环境下仍然全绿。钉死之后这条保障不再依赖
  // 任何人机器上的 TZ 环境变量。
  test: { environment: 'jsdom', globals: true, env: { TZ: 'Europe/Berlin' } },
}));
