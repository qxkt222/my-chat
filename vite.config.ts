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
      // 2026-09-25 最严健康度审查实测基线：
      //   lines 60.46 · statements 58.55 · functions 49.6 · branches 52（25 个文件）
      // 阈值 = 地板，不是目标：设成「比实测低约 2 个点」，作用是拦住断崖式倒退，
      // 而不是把门焊死。真要提高得先补测试，再抬这里 —— 顺序不能反。
      thresholds: {
        lines: 58,
        statements: 56,
        functions: 47,
        branches: 50,
      },
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
});
