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

// Sidebar 操作失败的用户可见提示(T-148)。key 与 shell.ts 同命名空间,
// 集中在此避免只为三条提示改自动生成的文案分片。
const sidebarActionMessages: Record<string, Record<string, string>> = {
  "sidebar.deleteFailed": {
    zh: "删除对话「{title}」失败，请重试",
    en: 'Failed to delete conversation "{title}", please retry',
  },
  "sidebar.batchDeleteFailed": {
    zh: "批量删除失败（{n} 个对话未删除），请重试",
    en: "Failed to delete {n} conversations, please retry",
  },
  "sidebar.archiveFailed": {
    zh: "归档操作失败，请重试",
    en: "Archive operation failed, please retry",
  },
};

const translations: Record<string, Record<string, string>> = {
  ...shellMessages,
  ...chatMessages,
  ...tavernMessages,
  ...settingsMessages,
  ...knowledgeMessages,
  ...miscMessages,
  ...sidebarActionMessages,
};

/**
 * 插值。必须用**函数替换**：String.replace(regex, string) 会把替换值里的
 * `$&` / `$'` / "$`" / `$$` 当成替换模式(T-137)，标题含这些字符时会被改写。
 */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  let s = template;
  for (const [k, v] of Object.entries(vars)) {
    // 函数替换：返回值按字面插入，不再解析 $ 模式
    s = s.replace(new RegExp(`\\{${k}\\}`, "g"), () => String(v));
  }
  return s;
}

/** Non-reactive lookup — safe outside React (stores, event handlers) */
export function t(key: string, vars?: Record<string, string | number>): string {
  const locale = useAppConfigStore.getState?.()?.locale || "zh";
  const template = translations[key]?.[locale] || translations[key]?.en || key;
  return interpolate(template, vars);
}

// Hook version for reactive components (stable reference — safe in memo/useMemo deps)
export function useT() {
  const locale = useAppConfigStore((s) => s.locale);
  return useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const template = translations[key]?.[locale] || translations[key]?.en || key;
      return interpolate(template, vars);
    },
    [locale]
  );
}
