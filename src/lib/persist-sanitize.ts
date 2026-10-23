// lib/persist-sanitize.ts — 持久化边界运行时校验
//
// 为什么要这一层：localStorage / sled / characters/*.json 都是「不可信输入」。
// 之前一律 `JSON.parse(raw) as X`，坏数据（例如 `placement: "2"`）会一路带到
// 渲染层，在 `placement.includes(...)` 处抛 TypeError → React 白屏。
// 这里逐字段 typeof + 默认值，保证返回的对象一定满足类型契约，且永不抛错。
//
// 原则：
//   - 未知/类型错误 → 回落到安全默认值（不抛、不保留脏字段）。
//   - 数组：丢弃非对象元素；对象数组再按 id 可用性过滤。
//   - 解析失败仍由调用方的 try/catch 兜底（本文件只处理「解析成功但结构坏」）。

import type {
  BudgetConfig,
  CharacterBook,
  CharacterCard,
  ConnectionProfile,
  ErrorKind,
  LoreEntry,
  Persona,
} from "@/types";
import type { RegexRule } from "@/lib/regex-format";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 字符串数组：非字符串元素丢弃，空串也丢弃（空 id/空标签没有意义） */
export function sanitizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.length > 0) out.push(item);
  }
  return out;
}

// ── RegexRule ────────────────────────────────────────────
// placement 是这次白屏的根因：类型声明是 number[]，但旧/坏数据可能是 "2" 或数字。
//   - 非数组（连数组都不是）→ 视为「缺省」= 显示期（历史行为）。
//   - 是数组 → 只保留 1/2；即使过滤后为空也保留空数组（显式约束 = 哪都不生效），
//     避免坏元素把一条「只用于出站」的规则意外翻成显示期规则。
function sanitizePlacement(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const set = new Set<number>();
  for (const item of v) {
    if (item === 1 || item === 2) set.add(item);
  }
  return [...set].sort((a, b) => a - b);
}

function sanitizeFlags(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  // 只接受 JS 正则合法标志；含非法字符/重复标志 → 丢弃（下游 new RegExp 会抛）
  if (!/^[dgimsuvy]+$/.test(v)) return undefined;
  const deduped = [...new Set(v)].join("");
  return deduped;
}

export function sanitizeRegexRule(raw: unknown): RegexRule {
  const o = isRecord(raw) ? raw : {};
  return {
    id: asString(o.id),
    name: asString(o.name),
    pattern: asString(o.pattern),
    replacement: asString(o.replacement),
    enabled: typeof o.enabled === "boolean" ? o.enabled : true,
    flags: sanitizeFlags(o.flags),
    placement: sanitizePlacement(o.placement),
    minDepth:
      typeof o.minDepth === "number" && Number.isFinite(o.minDepth) ? o.minDepth : undefined,
    maxDepth: o.maxDepth === null ? null : asNumber(o.maxDepth),
  };
}

/** 规则数组：丢弃非对象元素与没有 id 的条目（无法启用/删除/持久化） */
export function sanitizeRegexRules(raw: unknown): RegexRule[] {
  if (!Array.isArray(raw)) return [];
  const out: RegexRule[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const rule = sanitizeRegexRule(item);
    if (!rule.id) continue;
    out.push(rule);
  }
  return out;
}

// ── BudgetConfig ─────────────────────────────────────────
const DEFAULT_BUDGET: BudgetConfig = {
  mode: "auto",
  usage_pct: 90,
  default_context_window: 8192,
};

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

export function sanitizeBudgetConfig(raw: unknown): BudgetConfig {
  const o = isRecord(raw) ? raw : {};
  // 上下文窗口必须是正数；负数/0 属于坏数据 → 用默认值（而不是收敛到 128）
  const window =
    typeof o.default_context_window === "number" &&
    Number.isFinite(o.default_context_window) &&
    o.default_context_window > 0
      ? Math.min(10_000_000, Math.max(128, o.default_context_window))
      : DEFAULT_BUDGET.default_context_window;
  return {
    mode: o.mode === "manual" ? "manual" : "auto",
    usage_pct: clampNumber(o.usage_pct, 1, 100, DEFAULT_BUDGET.usage_pct),
    default_context_window: window,
  };
}

// ── ConnectionProfile ────────────────────────────────────
export function sanitizeConnectionProfile(raw: unknown): ConnectionProfile {
  const o = isRecord(raw) ? raw : {};
  return {
    id: asString(o.id),
    name: asString(o.name),
    api_url: asString(o.api_url),
    api_key: asString(o.api_key),
    model: asString(o.model),
    created_at: asString(o.created_at),
  };
}

/** 连接档案数组：丢弃 null / 非对象 / 无 id 条目 */
export function sanitizeConnectionProfiles(raw: unknown): ConnectionProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: ConnectionProfile[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const p = sanitizeConnectionProfile(item);
    if (!p.id) continue;
    out.push(p);
  }
  return out;
}

// ── CharacterBook / LoreEntry ────────────────────────────
function sanitizeLoreEntry(raw: unknown): LoreEntry {
  const o = isRecord(raw) ? raw : {};
  return {
    keys: sanitizeStringArray(o.keys),
    keyssecondary: Array.isArray(o.keyssecondary)
      ? sanitizeStringArray(o.keyssecondary)
      : undefined,
    content: asString(o.content),
    constant: asBool(o.constant),
    selective: asBool(o.selective),
    insertion_order: asNumber(o.insertion_order),
    position: asOptionalString(o.position),
    enabled: asBool(o.enabled),
    comment: asOptionalString(o.comment),
    case_sensitive: asBool(o.case_sensitive),
    probability: asNumber(o.probability),
    recursive: asBool(o.recursive),
    regex: asBool(o.regex),
    match_whole_words: asBool(o.match_whole_words),
    min_activations: asNumber(o.min_activations),
    sticky: asBool(o.sticky),
    cooldown: asNumber(o.cooldown),
  };
}

export function sanitizeCharacterBook(raw: unknown): CharacterBook {
  const o = isRecord(raw) ? raw : {};
  const rawEntries = Array.isArray(o.entries) ? o.entries : [];
  return {
    name: asOptionalString(o.name),
    description: asOptionalString(o.description),
    scan_depth: asNumber(o.scan_depth),
    token_budget: asNumber(o.token_budget),
    entries: rawEntries
      .filter(isRecord)
      // 无 keys 且非 constant 的条目永远不会被命中，是结构性坏数据 → 丢弃
      .filter((e) => Array.isArray(e.keys) || e.constant === true)
      .map(sanitizeLoreEntry),
  };
}

// ── CharacterCard ────────────────────────────────────────
function sanitizeDepthPrompt(raw: unknown): { depth: number; prompt: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.depth !== "number" || !Number.isFinite(raw.depth)) return undefined;
  if (typeof raw.prompt !== "string") return undefined;
  return { depth: raw.depth, prompt: raw.prompt };
}

export function sanitizeCharacterCard(raw: unknown): CharacterCard {
  const o = isRecord(raw) ? raw : {};
  return {
    id: asString(o.id),
    specVersion: asString(o.specVersion),
    name: asString(o.name),
    description: asString(o.description),
    personality: asString(o.personality),
    scenario: asString(o.scenario),
    first_mes: asString(o.first_mes),
    mes_example: asString(o.mes_example),
    creator_notes: asString(o.creator_notes),
    system_prompt: asString(o.system_prompt),
    post_history_instructions: asString(o.post_history_instructions),
    alternate_greetings: sanitizeStringArray(o.alternate_greetings),
    tags: sanitizeStringArray(o.tags),
    creator: asString(o.creator),
    character_version: asString(o.character_version),
    character_book: isRecord(o.character_book)
      ? sanitizeCharacterBook(o.character_book)
      : undefined,
    extensions: isRecord(o.extensions) ? { ...o.extensions } : undefined,
    depth_prompt: sanitizeDepthPrompt(o.depth_prompt),
    avatarPath: asString(o.avatarPath),
    presetId: asOptionalString(o.presetId),
    lorebookIds: Array.isArray(o.lorebookIds) ? sanitizeStringArray(o.lorebookIds) : undefined,
    favorite: asBool(o.favorite),
    created_at: asString(o.created_at),
    updated_at: asString(o.updated_at),
  };
}

// ── Persona ──────────────────────────────────────────────
export function sanitizePersona(raw: unknown): Persona {
  const o = isRecord(raw) ? raw : {};
  const legacyId = asOptionalString(o.lorebookId);
  // 与旧 load() 的迁移口径一致：lorebookIds 存在就以它为准（即使是空数组），
  // 只有完全没有 lorebookIds 时才回落到单值 lorebookId。
  const lorebookIds = Array.isArray(o.lorebookIds)
    ? sanitizeStringArray(o.lorebookIds)
    : legacyId
      ? [legacyId]
      : [];
  return {
    id: asString(o.id),
    name: asString(o.name),
    description: asString(o.description),
    avatarPath: asString(o.avatarPath),
    lorebookIds,
    created_at: asString(o.created_at),
    ...(legacyId ? { lorebookId: legacyId } : {}),
  };
}

/** Persona 数组：丢弃 null / 非对象 / 无 id 条目 */
export function sanitizePersonas(raw: unknown): Persona[] {
  if (!Array.isArray(raw)) return [];
  const out: Persona[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const p = sanitizePersona(item);
    if (!p.id) continue;
    out.push(p);
  }
  return out;
}

// ── ErrorKind（持久化字符串 → 枚举）──────────────────────
const ERROR_KINDS: readonly ErrorKind[] = [
  "rate_limit",
  "timeout",
  "rejected",
  "auth",
  "overload",
  "unknown",
];

/** 旧数据/后端字符串可能不在枚举内 → 返回 undefined（渲染层走通用文案） */
export function parseErrorKind(raw: unknown): ErrorKind | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return ERROR_KINDS.find((k) => k === raw);
}
