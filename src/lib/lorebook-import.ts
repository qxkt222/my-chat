// lib/lorebook-import.ts — 酒馆世界书(Lorebook)导入解析(纯函数)
//
// 兼容格式:
//  - TavernAI/LibreLore 独立世界书:{entries:[...]}
//  - 角色卡内嵌:{character_book:{entries:[...]}}
//  - 旧版:{entries} 条目字段 key(单数)/keys(数组)均兼容

import type { CharacterBook, LoreEntry } from "@/types";

function normalizeEntry(e: Record<string, unknown>): LoreEntry | null {
  const keysRaw = (e.keys as unknown[] | undefined) ?? (e.key ? [e.key] : []);
  const keys = (Array.isArray(keysRaw) ? keysRaw : []).map(String).filter(Boolean);
  const content = String(e.content ?? "").trim();
  if (keys.length === 0 && e.constant !== true) return null; // 无关键词且非常驻 → 无法触发,跳过
  if (!content) return null;
  // 启用状态兼容两种表示:标准 V2 用 enabled:false;酒馆导出用 disable:true
  const disabled = e.disable === true || e.enabled === false;
  return {
    keys,
    keyssecondary: Array.isArray(e.keyssecondary)
      ? (e.keyssecondary as unknown[]).map(String)
      : undefined,
    content,
    constant: e.constant === true,
    selective: e.selective === true,
    insertion_order:
      typeof e.insertion_order === "number"
        ? e.insertion_order
        : typeof e.order === "number"
          ? e.order
          : 0,
    position: e.position ? String(e.position) : "before_char",
    enabled: !disabled,
    comment: e.comment ? String(e.comment) : "",
    // 修复导入丢字段:酒馆高级字段此前被丢弃
    case_sensitive: e.case_sensitive === true ? true : undefined,
    probability: typeof e.probability === "number" ? e.probability : undefined,
    recursive: e.recursive === true ? true : undefined,
    regex: e.regex === true ? true : undefined,
    match_whole_words: e.match_whole_words === true ? true : undefined,
    min_activations: typeof e.min_activations === "number" ? e.min_activations : undefined,
  };
}

/**
 * 解析酒馆世界书 JSON。返回 CharacterBook(entries 已按 insertion_order 排序),
 * 解析失败或无可导入条目返回 null。
 */
export function parseLorebook(rawJson: string): CharacterBook | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return null;
  }

  // 兼容 {character_book:{...}} 包装(角色卡导出里的世界书)
  const bookObj =
    obj.character_book && typeof obj.character_book === "object"
      ? (obj.character_book as Record<string, unknown>)
      : obj;

  // 兼容两种 entries 形态:
  //  - 数组 [entry, ...](标准 character_book)
  //  - 字典 { "1": entry, "2": entry, ... }(酒馆导出世界书,key 为 uid/序号)
  const rawEntries = bookObj.entries;
  if (!rawEntries) return null;

  let list: Record<string, unknown>[];
  if (Array.isArray(rawEntries)) {
    list = rawEntries.filter((e): e is Record<string, unknown> => e && typeof e === "object");
  } else if (typeof rawEntries === "object") {
    list = Object.values(rawEntries).filter(
      (e): e is Record<string, unknown> => e && typeof e === "object"
    );
  } else {
    return null;
  }

  const entries = list
    .map(normalizeEntry)
    .filter((e): e is LoreEntry => e !== null)
    .sort((a, b) => (a.insertion_order ?? 0) - (b.insertion_order ?? 0));

  if (entries.length === 0) return null;

  return {
    name: bookObj.name ? String(bookObj.name) : "导入世界书",
    description: bookObj.description ? String(bookObj.description) : "",
    scan_depth: typeof bookObj.scan_depth === "number" ? bookObj.scan_depth : undefined,
    token_budget: typeof bookObj.token_budget === "number" ? bookObj.token_budget : undefined,
    entries,
  };
}
