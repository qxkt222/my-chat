// lib/preset-import.ts — 酒馆(SillyTavern)预设导入解析(纯函数)
//
// 兼容两种格式:
//  1) 单条预设 JSON:{name, system_prompt} 或 {identifier, name, content, ...}
//  2) ImpExp 完整导出(如 Freaky Frankenstein 4 MAX+):{prompts:[...], prompt_order:[...]}
//      - 每个有实质内容的条目独立成一条**名册条目**(可逐条开关,对齐酒馆 Prompts 列表)
//      - 另附一条「（默认组合）」= 当年按 prompt_order 拼好的整包,默认**不启用**
//
// 2026-09-25 改造(全局条目名册):导入时给每条打上
//   · group  = 包名(取预设名),用于 UI 分区
//   · order  = prompts 里的原始次序,决定拼装先后
//   · enabled = 读酒馆 prompt_order 自带的启用标记
// ⚠️ 旧数据(本机实测 34 条)没有这三个字段,由 store 的 migrateLegacyEntries 补 group/order,
//    但**补不出**当年的启用标记 —— 那部分只能按未启用处理,要拿回真实状态需重新导入。

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
 * 「默认组合」是否要启用。
 *
 * 结论：**恒定 false**（开发者 2026-09-25 选定「默认关掉，保留可选」）。
 * 原因：它是导入时把 prompt_order 里所有段拼起来的产物，实测本机那条有 65762 字符
 * （约 6.5 万字）；逐条开关上线后，它一开就把整包灌进去，直接顶爆上下文预算，
 * 而且会与用户逐条勾选的结果重复叠加。所以只保留为「一键全开」的备选，不默认生效。
 */
function comboEnabled(): boolean {
  return false;
}

/**
 * 解析酒馆预设 JSON,返回生成的 PromptPreset 列表。
 * 第一条 = 「默认组合」(不启用),其余 = 逐条开关的独立条目。
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

    const group = cleanName(exportObj.name || "导入预设") || "导入预设";

    // 酒馆自带的启用标记,按 identifier 建索引(enabled 缺省按未启用)
    const order = exportObj.prompt_order?.[0]?.order;
    const enabledByIdent = new Map<string, boolean>();
    if (Array.isArray(order)) {
      for (const o of order) {
        if (o && typeof o.identifier === "string") {
          enabledByIdent.set(o.identifier, o.enabled === true);
        }
      }
    }

    // 1) 默认组合:按 prompt_order 启用段顺序拼接(无 order 时取第一个条目)
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
    if (comboParts.length > 0) {
      out.push({
        id: `imp-${crypto.randomUUID()}`,
        name: `${group}（默认组合）`,
        is_preset: false,
        description: `酒馆预设导入,已按默认顺序拼接 ${comboParts.length} 段（整包;建议逐条勾选而非直接开它）`,
        template: comboParts.join("\n\n"),
        created_at: now,
        group,
        order: -1, // 排在包首,便于「一键全开」时先看到
        enabled: comboEnabled(),
      });
    }

    // 2) 每条独立条目 → 一个名册条目,order 取 prompts 里的原始次序
    prompts.forEach((p, i) => {
      const text = promptText(p);
      if (!text) return;
      const ident = typeof p.identifier === "string" ? p.identifier : "";
      const enabled =
        enabledByIdent.get(ident) ?? (typeof p.enabled === "boolean" ? p.enabled === true : false);
      out.push({
        id: `imp-${crypto.randomUUID()}`,
        name: cleanName(p.name || "预设"),
        is_preset: false,
        description: `酒馆预设条目（${group}）`,
        template: text,
        created_at: now,
        group,
        order: i,
        enabled,
      });
    });
    return out;
  }

  // ── 格式 1:单条预设 {name, system_prompt} 或 {name, content} ──
  const text = promptText(obj as TavernPrompt);
  if (!text) return out;
  const singleName = cleanName(String(obj.name || "导入预设"));
  out.push({
    id: `imp-${crypto.randomUUID()}`,
    name: singleName,
    is_preset: false,
    description: "导入的预设",
    template: text,
    created_at: now,
    group: singleName,
    order: 0,
    // 单条预设没有 prompt_order 可言：开箱即用是它的本意，默认启用
    enabled: true,
  });
  return out;
}
