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
  },
  envPrefix: ["VITE_", "TAURI_"],
});
