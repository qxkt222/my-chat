import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  test: {
    // lib/ 纯函数测试跑在 node 环境（快）；组件测试在文件头用
    // `// @vitest-environment jsdom` 单独切到 jsdom（见 MessageRenderer.test.tsx）。
    // ⚠️ include 此前只写死 lib/**/*.test.ts —— 组件测试写在哪都不会被收集，
    //    47 个组件对 6 个测试文件的落差有一半来自这里，不是「懒得写」。
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // ⚠️ 不要设 exclude：实测（2026-09-25）它**会覆盖** v8 provider 的默认排除表，
      // 把 node_modules/.vite 缓存等一并纳入统计，全局读数从 60.46% 崩到 22.6%。
      // 要排除某些文件，应把默认表抄全后再追加，而不是只写自己的几条。
      // 2026-09-25 实测基线（口径：vitest 控制台 "All files" 行，**全部源文件为分母**）：
      //   statements 21.35 · branches 15.88 · functions 12.79 · lines 22.6
      //
      // ⚠️ 一次真实的口径翻车记录：这两个数最初被设成 58/56/47/50，
      //    来源是 coverage/coverage-summary.json 的 total=60.46%。
      //    但那个 JSON **只统计「有覆盖的」文件**（25 个），0% 的文件被它排除，
      //    而闸门比的是控制台那行**含全部源文件**的 22.6% —— 两个数不是同一个量。
      //    更糟的是当时读到的 JSON 还是前一晚 23:49 的旧文件（当天没更新）。
      //    教训：设阈值前，必须确认「我读的这个数」与「闸门比的那个数」同源。
      //
      // 阈值 = 地板：按实测再下留约 2 个点，作用是拦住断崖式倒退（比如某次改动
      // 删掉一堆测试、或把大模块从测试里摘出去），不是宣称覆盖率好看。
      // 绝大多数 UI 组件仍是 0%（组件测试只有 4 个文件），要提高得先补测试再抬这里。
      thresholds: {
        lines: 20,
        statements: 19,
        functions: 11,
        branches: 14,
      },
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
});
