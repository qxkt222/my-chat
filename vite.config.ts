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
    // lib/ 纯函数测试(无 Tauri 依赖,天然可测);node 环境跑
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
  envPrefix: ["VITE_", "TAURI_"],
});
