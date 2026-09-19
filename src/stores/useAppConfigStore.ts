import { create } from "zustand";
import type { ThemeMode } from "@/types";

interface AppConfigState {
  theme: ThemeMode;
  accentHue: number; // 0-360
  fontSize: "small" | "medium" | "large";
  locale: "zh" | "en";
  setTheme: (t: ThemeMode) => void;
  setAccentHue: (h: number) => void;
  setFontSize: (s: "small" | "medium" | "large") => void;
  setLocale: (l: "zh" | "en") => void;
}

export const useAppConfigStore = create<AppConfigState>((set) => ({
  theme: (localStorage.getItem("theme") as ThemeMode) || "dark",
  accentHue: parseInt(localStorage.getItem("accentHue") || "262"),
  fontSize: (localStorage.getItem("fontSize") as "small" | "medium" | "large") || "medium",
  locale: (localStorage.getItem("locale") as "zh" | "en") || "zh",
  setTheme: (t) => {
    localStorage.setItem("theme", t);
    set({ theme: t });
  },
  setAccentHue: (h) => {
    localStorage.setItem("accentHue", String(h));
    set({ accentHue: h });
  },
  setFontSize: (s) => {
    localStorage.setItem("fontSize", s);
    set({ fontSize: s });
  },
  setLocale: (l) => {
    localStorage.setItem("locale", l);
    set({ locale: l });
  },
}));

// Apply accent hue CSS variable
export function applyAccentHue(hue: number) {
  document.documentElement.style.setProperty("--accent-hue", String(hue));
}

// Apply font size
const FONT_SIZES = { small: "13px", medium: "14px", large: "16px" };
export function applyFontSize(size: keyof typeof FONT_SIZES) {
  document.documentElement.style.setProperty("--font-size", FONT_SIZES[size]);
}
