// lib/i18n/index.ts — 汇总各分组文案，对外 API 与拆分前完全一致（t / useT）
// NOTE: plugin built-in command outputs and model system prompts are "content"
// rather than UI copy — they intentionally stay in their authored language.

import { useCallback } from "react";
import { useAppConfigStore } from "@/stores/useAppConfigStore";
import { shellMessages } from "./shell";
import { chatMessages } from "./chat";
import { tavernMessages } from "./tavern";
import { settingsMessages } from "./settings";
import { knowledgeMessages } from "./knowledge";
import { miscMessages } from "./misc";

const translations: Record<string, Record<string, string>> = {
  ...shellMessages,
  ...chatMessages,
  ...tavernMessages,
  ...settingsMessages,
  ...knowledgeMessages,
  ...miscMessages,
};

/** Non-reactive lookup — safe outside React (stores, event handlers) */
export function t(key: string, vars?: Record<string, string | number>): string {
  const locale = useAppConfigStore.getState?.()?.locale || "zh";
  let s = translations[key]?.[locale] || translations[key]?.en || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}

// Hook version for reactive components (stable reference — safe in memo/useMemo deps)
export function useT() {
  const locale = useAppConfigStore((s) => s.locale);
  return useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let s = translations[key]?.[locale] || translations[key]?.en || key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }
      return s;
    },
    [locale]
  );
}
