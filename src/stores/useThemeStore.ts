import { create } from "zustand";
import type { ThemeMode } from "@/types";

const THEME_KEY = "theme";
const THEMES: readonly ThemeMode[] = ["light", "dark", "system"];

/**
 * 只认合法值(T-151):旧实现直接 `as ThemeMode` 断言,手改/旧版本留下的坏值
 * 会让主题落回 system(而不是默认 dark),且类型上假装合法、无法定位。
 */
function readTheme(): ThemeMode {
  const v = localStorage.getItem(THEME_KEY);
  return v && (THEMES as readonly string[]).includes(v) ? (v as ThemeMode) : "dark";
}

interface ThemeState {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: readTheme(),
  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    set({ theme });
  },
}));
