// lib/preset-import.ts — 酒馆(SillyTavern)预设导入解析(纯函数)
//
// 兼容两种格式:
//  1) 单条预设 JSON:{name, system_prompt} 或 {identifier, name, content, ...}
//  2) ImpExp 完整导出(如 Freaky Frankenstein 4 MAX+):{prompts:[...], prompt_order:[...]}
//      - 按 prompt_order 把「默认启用」的段按顺序拼成组合预设(开箱即用)
//      - 每个有实质内容的条目独立成预设(可选单点:只加 NSFW / 只加 Jailbreak…)

import type { PromptPreset } from "@/types";

interface TavernPrompt {
  identifier?: string;
  name?: string;
  content?: unknown;
  system_prompt?: unknown;
  enabled?: boolean;
}

interface TavernExport {
  name?: string;
  prompts?: TavernPrompt[];
  prompt_order?: { order?: { identifier: string; enabled: boolean }[] }[];
}

/** 清洗名称:去掉 emoji/装饰符号,截断 */
function cleanName(name: string): string {
  const noEmoji = name
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1F9B0}-\u{1F9FF}\u{FE0E}]/gu,
      ""
    )
    .trim();
  return noEmoji.replace(/\s+/g, " ").slice(0, 40) || "未命名预设";
}

/** 取条目文本内容(兼容 content 或 system_prompt 字段) */
function promptText(p: TavernPrompt): string {
  const c = p.content;
  const s = p.system_prompt;
  const v = typeof c === "string" && c.trim() ? c : typeof s === "string" && s.trim() ? s : "";
  return v.trim();
}

/**
 * 解析酒馆预设 JSON,返回生成的 PromptPreset 列表。
 * 第一个 = 「默认组合」(若文件有 prompt_order 且存在启用段),其余 = 独立条目。
 */
export function parseTavernPresets(rawJson: string): PromptPreset[] {
  const out: PromptPreset[] = [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return out;
  }

  const now = new Date().toISOString();

  // ── 格式 2:ImpExp 完整导出 {prompts: [...]} ──
  const exportObj = obj as TavernExport;
  if (Array.isArray(exportObj.prompts) && exportObj.prompts.length > 0) {
    const prompts = exportObj.prompts.filter((p) => promptText(p).length > 10);
    if (prompts.length === 0) return out;

    // 1) 默认组合:按 prompt_order 启用段顺序拼接(无 order 时取第一个条目)
    const order = exportObj.prompt_order?.[0]?.order;
    const comboParts: string[] = [];
    const addPart = (p: TavernPrompt) => {
      const text = promptText(p);
      if (text) comboParts.push(text);
    };
    if (order) {
      for (const o of order) {
        const p = prompts.find((x) => x.identifier === o.identifier);
        if (p) addPart(p);
      }
    } else {
      const first = prompts[0];
      if (first) addPart(first);
    }
    // 组合预设名取文件名风格(无则"导入预设")
    const baseName = cleanName(exportObj.name || "导入预设") || "导入预设";
    if (comboParts.length > 0) {
      out.push({
        id: `imp-${crypto.randomUUID()}`,
        name: `${baseName}（默认组合）`,
        is_preset: false,
        description: `酒馆预设导入,已按默认顺序拼接 ${comboParts.length} 段`,
        template: comboParts.join("\n\n"),
        created_at: now,
      });
    }

    // 2) 每个独立条目 → 单独预设
    for (const p of prompts) {
      const text = promptText(p);
      if (!text) continue;
      out.push({
        id: `imp-${crypto.randomUUID()}`,
        name: cleanName(p.name || "预设"),
        is_preset: false,
        description: "酒馆预设条目(可单独启用)",
        template: text,
        created_at: now,
      });
    }
    return out;
  }

  // ── 格式 1:单条预设 {name, system_prompt} 或 {name, content} ──
  const text = promptText(obj as TavernPrompt);
  if (!text) return out;
  out.push({
    id: `imp-${crypto.randomUUID()}`,
    name: cleanName(String(obj.name || "导入预设")),
    is_preset: false,
    description: "导入的预设",
    template: text,
    created_at: now,
  });
  return out;
}
