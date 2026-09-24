// stores/tavern/assembly.ts — 发送流程里的纯组装逻辑（从 useTavernStore 抽出）
//
// 这三块原先在 sendMessage / sendGroupMessage / swipeGenerate / continueMessage 里
// 各有一份复制。它们决定「发给模型的东西长什么样」——三段式顺序一旦被改坏，
// DeepSeek 的缓存命中率会直接掉下来，而界面上看不出任何异常。
// 所以先抽出来、补上测试，再谈拆那几个巨型 action。

import type { CharacterCard, Message, ModelParameters } from "@/types";

/** 世界书类型直接取自角色卡字段，省得再引一个类型名 */
type LorebookLike = NonNullable<CharacterCard["character_book"]>;

/** 采样器可调项（与 Rust 请求体字段一一对应） */
export type SamplerKey =
  | "temperature"
  | "top_p"
  | "top_k"
  | "repetition_penalty"
  | "frequency_penalty"
  | "presence_penalty"
  | "min_p"
  | "mirostat"
  | "mirostat_tau"
  | "mirostat_eta"
  | "dry_multiplier"
  | "dry_base"
  | "dry_allowed_length"
  | "dry_penalty_last_n";

/**
 * 世界书四类来源去重合并。
 *
 * 顺序有讲究：主世界书恒在首位，其后是角色卡内嵌，最后才是按 id 展开的
 * 「全局启用 + Persona 多选 + 会话绑定 + 角色级多选」。空书一律过滤掉。
 */
export function collectLorebooks(args: {
  globalLorebook: LorebookLike | null | undefined;
  card: Pick<CharacterCard, "character_book" | "lorebookIds">;
  enabledIds: readonly string[];
  personaIds: readonly string[];
  convIds: readonly string[];
  byId: Record<string, LorebookLike | undefined>;
}): LorebookLike[] {
  const activeIds = new Set<string>([
    ...args.enabledIds,
    ...args.personaIds,
    ...args.convIds,
    ...(args.card.lorebookIds || []),
  ]);
  return [
    args.globalLorebook,
    args.card.character_book,
    ...[...activeIds].map((id) => args.byId[id]),
  ].filter((b): b is LorebookLike => !!b);
}

/**
 * 采样器回退链：会话预设 → 当前模型参数 → 全局默认 → null（该字段不发送）。
 *
 * 抽出来的理由：这条链在四个发送入口各写了一遍，任何一处改错都只会表现为
 * 「模型行为怪怪的」，很难查。现在只有一份，且有测试钉住优先级。
 */
export function makeSamplerPicker(
  sampler: Partial<Record<SamplerKey, number>> | undefined,
  modelParams: ModelParameters | undefined,
  defaults: ModelParameters
): (k: SamplerKey) => number | null {
  return (k) => {
    const s = sampler?.[k];
    if (s != null) return s;
    const m = modelParams?.[k];
    if (m != null) return m;
    const d = defaults[k];
    return d != null ? d : null;
  };
}

/**
 * 三段式消息组装（DeepSeek 缓存设计的核心，顺序不能变）：
 *
 *   system(stable 前缀) → 钉住区 → 历史消息 → 可变尾部(世界书/摘要/附件) → 当前输入(user)
 *
 * 顶部恒定、尾部可变才是缓存命中的前提；把世界书塞回 system 中间会让整段前缀失效。
 */
export function assembleApiMessages(args: {
  stableSystem: string;
  pinned?: string | undefined;
  history: readonly Pick<Message, "role" | "content">[];
  lorebook?: string | undefined;
  summary?: string | undefined;
  attachmentBlock?: string | undefined;
  userContent: string;
}): Pick<Message, "role" | "content">[] {
  const out: Pick<Message, "role" | "content">[] = [
    { role: "system", content: args.stableSystem },
  ];
  if (args.pinned?.trim()) {
    out.push({ role: "system", content: `【钉住】\n${args.pinned.trim()}` });
  }
  out.push(...args.history.map((m) => ({ role: m.role, content: m.content })));
  if (args.lorebook) out.push({ role: "system", content: args.lorebook });
  if (args.summary) out.push({ role: "system", content: `【对话摘要】\n${args.summary}` });
  if (args.attachmentBlock) out.push({ role: "system", content: args.attachmentBlock });
  out.push({ role: "user", content: args.userContent });
  return out;
}
