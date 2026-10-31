// @vitest-environment jsdom
//
// stores/theme-store.test.ts — 主题持久化值的校验回退(T-151)
//
// 旧实现 `localStorage.getItem("theme") as ThemeMode || "dark"`:手改/旧版本
// 留下的坏值(如 "solarized")会被当成合法 ThemeMode 接受,主题落到未定义分支
// (实际表现为按 system 处理),而不是回退默认 dark。契约:
//   1. 无存量值 → dark;
//   2. 合法值 light/dark/system 正常恢复;
//   3. 非法/空值 → dark;
//   4. setTheme 同时写内存与 localStorage。

import { describe, it, expect, beforeEach, vi } from "vitest";

const THEME_KEY = "theme";

/** 重新求值模块:store 在 import 期读 localStorage,必须 resetModules 才能测初始化 */
async function freshStore() {
  vi.resetModules();
  const mod = await import("./useThemeStore");
  return mod.useThemeStore;
}

beforeEach(() => {
  localStorage.clear();
});

describe("useThemeStore 初始化校验(T-151)", () => {
  it("无存量值时默认 dark", async () => {
    const store = await freshStore();
    expect(store.getState().theme).toBe("dark");
  });

  it.each(["light", "dark", "system"] as const)("恢复合法值 %s", async (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    const store = await freshStore();
    expect(store.getState().theme).toBe(theme);
  });

  it.each(["solarized", "DARK", "system ", ""])("非法值 %j 回落 dark", async (bad) => {
    localStorage.setItem(THEME_KEY, bad);
    const store = await freshStore();
    expect(store.getState().theme).toBe("dark");
  });

  it("setTheme 同步内存与 localStorage", async () => {
    const store = await freshStore();
    store.getState().setTheme("light");
    expect(store.getState().theme).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
  });
});
