// lib/rp-prompt.ts — 角色扮演提示词组装(纯函数)
//
// 酒馆风格:把角色卡字段 + 世界书命中 + Persona 描述,经预设模板渲染成
// 一个 system_prompt,再走现有 sendMessage 链路(缓存友好:system 在前,
// knowledge 尾部的顺序不变)。

import type { CharacterCard, CharacterBook, Persona, PromptPreset, Message } from "@/types";
import { assembleRoster } from "./preset-roster";

export interface RpContext {
  card: CharacterCard;
  persona?: Persona | null | undefined;
  /** 提示词模板来源，两种形态：
   *   · PromptPreset      —— 单套预设（角色卡绑定的那一套，回退用）
   *   · PromptPreset[]    —— **全局条目名册**（2026-09-25 起的主路径）：
   *                          取其所有 enabled===true 的条目按 order 拼起来；
   *                          一条都没启用时返回空串，于是自动回退到下面的单套形态。
   *  单个对象会被当成「只有这一条且已启用」，便于旧调用点与单测不改。 */
  preset?: PromptPreset | PromptPreset[] | null | undefined;
  /** 会话原有 system_prompt(技能/会话自定义) */
  baseSystemPrompt?: string | undefined;
  /** 全局世界书 + 角色内嵌书 + Persona 绑定的世界书(已合并) */
  lorebooks: CharacterBook[];
  /** 最近消息(世界书关键词扫描源)+ 当前输入 */
  recentMessages: Pick<Message, "role" | "content">[];
  currentInput: string;
  /** 对话摘要(酒馆 Summarize:注入以保记忆) */
  summary?: string | undefined;
  /** 定时世界书状态(酒馆 Timed WI:sticky 常驻 + cooldown 冷却) */
  timed?: TimedLoreState | undefined;
}

const SCAN_DEPTH_DEFAULT = 8; // 默认扫描最近 N 条消息(酒馆 scan_depth 简化)
const CHAR_BUDGET_DEFAULT = 1500; // 默认注入字符上限(酒馆 token_budget 简化)
const RECURSION_MAX = 2; // 递归激活深度上限(防循环)

/** 确定性伪随机:按内容 hash 决定概率注入,同输入同结果(保 DeepSeek 缓存前缀稳定) */
function deterministicHit(text: string, prob: number): boolean {
  if (prob >= 100) return true;
  if (prob <= 0) return false;
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  const v = (h >>> 0) % 100;
  return v < prob;
}

/** 关键词匹配:按 case_sensitive 决定原样/小写包含;支持正则关键词(酒馆 World Info regex) */
function entryMatches(
  keys: string[],
  text: string,
  caseSensitive: boolean,
  regex?: boolean,
  wholeWords?: boolean
): boolean {
  if (regex) {
    // 正则关键词:逐条尝试编译;编译失败回退字面量(防坏规则拖垮整条世界书)
    return keys.some((k) => {
      const t = k.trim();
      if (!t) return false;
      try {
        return new RegExp(t, caseSensitive ? "" : "i").test(text);
      } catch {
        return literalMatch(t, text, caseSensitive, wholeWords);
      }
    });
  }
  return keys.some((k) => {
    const t = k.trim();
    return t !== "" && literalMatch(t, text, caseSensitive, wholeWords);
  });
}

/** 字面量匹配(含全词边界;全词匹配只对 ASCII 词生效,中文无词边界退化为包含) */
function literalMatch(
  key: string,
  text: string,
  caseSensitive: boolean,
  wholeWords?: boolean
): boolean {
  if (wholeWords && /^[A-Za-z0-9_]+$/.test(key)) {
    // 词边界匹配:转义关键词避免正则特殊字符,首尾 \b
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${esc}\\b`, caseSensitive ? "" : "i").test(text);
  }
  return caseSensitive ? text.includes(key) : text.toLowerCase().includes(key.toLowerCase());
}

/** 关键词在文本中的出现次数(最小激活计数;全词匹配下按词边界计) */
function countOccurrences(
  key: string,
  text: string,
  caseSensitive: boolean,
  wholeWords?: boolean
): number {
  if (wholeWords && /^[A-Za-z0-9_]+$/.test(key)) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${esc}\\b`, caseSensitive ? "g" : "gi");
    return (text.match(re) || []).length;
  }
  const lowerText = text.toLowerCase();
  const lowerKey = key.toLowerCase();
  let count = 0;
  let idx = 0;
  while (idx < lowerText.length) {
    const at = lowerText.indexOf(lowerKey, idx);
    if (at < 0) break;
    count++;
    idx = at + Math.max(1, lowerKey.length);
  }
  return count;
}

interface LoreHit {
  order: number;
  content: string;
}

/** 定时世界书状态(酒馆 Timed WI):sticky 内容常驻 + cooldown 剩余轮数 */
export interface TimedLoreState {
  stickyContents: string[];
  cooldownLeft: Record<string, number>;
}

/** collectLorebookText 的返回(含命中追踪,供调用方更新 timed 状态) */
export interface LoreCollectResult {
  text: string;
  /** 本轮命中且带 sticky 的条目内容(加入常驻列表) */
  stickyHits: string[];
  /** 本轮命中且带 cooldown 的条目内容 → 冷却轮数 */
  cooldownHits: Record<string, number>;
}

/**
 * 合并多本世界书,按关键词+常驻过滤,按 insertion_order 排序,截断到字符预算。
 * 支持酒馆高级字段:
 *  - case_sensitive:关键词大小写敏感
 *  - probability:命中后按概率注入(0-100,缺省恒注入)
 *  - recursive:递归激活——命中条目的内容加入扫描文本,连锁拉入其他条目(深度上限)
 *  - scan_depth / token_budget:每本可覆盖默认
 *  - match_whole_words / min_activations:全词匹配 / 最小激活
 *  - sticky / cooldown:定时世界书——sticky 命中后常驻,cooldown 命中后 N 轮不重复
 */
export function collectLorebookTextWithTimed(
  lorebooks: CharacterBook[],
  recentMessages: Pick<Message, "role" | "content">[],
  currentInput: string,
  timed?: TimedLoreState
): LoreCollectResult {
  // 定时世界书预处理:
  //  1) cooldown 递减一轮(负数钳 0)
  //  2) sticky 常驻条目 → 以 constant 形式并入(无论关键词命中与否,始终在场)
  const cooldownLeft: Record<string, number> = {};
  if (timed) {
    for (const [k, v] of Object.entries(timed.cooldownLeft || {})) {
      const next = v - 1;
      if (next > 0) cooldownLeft[k] = next;
    }
  }
  const merged: CharacterBook[] = [...lorebooks];
  if (timed?.stickyContents?.length) {
    merged.push({
      entries: timed.stickyContents.map((content) => ({
        keys: [],
        content,
        constant: true,
        insertion_order: -1000, // 常驻最前
      })),
    });
  }
  // cooldown 中的条目本轮剔除(在冷却期内)
  const books = merged.map((b) => ({
    ...b,
    entries: b.entries.filter((e) => (cooldownLeft[e.content] ?? 0) <= 0),
  }));

  const hits: LoreHit[] = [];
  const seen = new Set<string>(); // 防同一内容重复注入(递归跨轮)
  const stickyHits: string[] = [];
  const cooldownHits: Record<string, number> = {};

  for (const book of books) {
    const scanDepth = book.scan_depth ?? SCAN_DEPTH_DEFAULT;
    const budget = book.token_budget ?? CHAR_BUDGET_DEFAULT;
    // 递归激活:扫描文本随轮次累积(内容触发更多关键词)
    let scanText = [...recentMessages.slice(-scanDepth).map((m) => m.content), currentInput].join(
      "\n"
    );
    let roundHits: LoreHit[] = [];
    const matchedContents = new Set<string>(); // 本轮命中(含常驻)的内容,递归源

    for (const e of book.entries) {
      if (e.enabled === false) continue;
      const constant = e.constant === true;
      // 最小激活计数(酒馆 Min Activations):关键词在扫描文本出现 ≥ N 次才注入;
      // 正则关键词不参与计数(正则已内建匹配语义),常驻条目恒激活
      const minAct = Math.max(1, e.min_activations ?? 1);
      const matched =
        constant ||
        (() => {
          if (e.regex) {
            return entryMatches(
              e.keys || [],
              scanText,
              e.case_sensitive === true,
              true,
              e.match_whole_words === true
            );
          }
          return (e.keys || []).some((k) => {
            const t = k.trim();
            return (
              t !== "" &&
              countOccurrences(
                t,
                scanText,
                e.case_sensitive === true,
                e.match_whole_words === true
              ) >= minAct
            );
          });
        })();
      if (!matched) continue;
      // selective:需要 secondary keys 也命中才注入
      if (!constant && e.selective && e.keyssecondary && e.keyssecondary.length > 0) {
        if (
          !entryMatches(
            e.keyssecondary,
            scanText,
            e.case_sensitive === true,
            e.regex === true,
            e.match_whole_words === true
          )
        )
          continue;
      }
      // probability:命中后按概率注入(确定性 hash,保缓存稳定——酒馆 Probability)
      const prob = e.probability ?? 100;
      const keysText = (e.keys || []).join(",");
      if (!deterministicHit(`${scanText}\u0000${e.content}\u0000${keysText}`, prob)) continue;
      matchedContents.add(e.content);
      if (!seen.has(e.content)) {
        seen.add(e.content);
        roundHits.push({ order: e.insertion_order ?? 0, content: e.content });
        // 定时世界书:命中条目按 sticky/cooldown 标记追踪(供会话持久化)
        if (e.sticky === true) stickyHits.push(e.content);
        if (typeof e.cooldown === "number" && e.cooldown > 0) cooldownHits[e.content] = e.cooldown;
      }
    }

    // 递归激活:命中条目内容成为新的关键词源,最多 RECURSION_MAX 轮
    for (let round = 1; round < RECURSION_MAX && roundHits.length > 0; round++) {
      const prevContents = [...matchedContents];
      if (prevContents.length === 0) break;
      matchedContents.clear();
      const added: LoreHit[] = [];
      for (const e of book.entries) {
        if (e.enabled === false || e.recursive !== true) continue;
        if (seen.has(e.content)) continue;
        const matched = entryMatches(
          e.keys || [],
          prevContents.join("\n"),
          e.case_sensitive === true,
          e.regex === true,
          e.match_whole_words === true
        );
        if (!matched) continue;
        const prob = e.probability ?? 100;
        const keysText = (e.keys || []).join(",");
        if (
          !deterministicHit(`${prevContents.join("\n")}\u0000${e.content}\u0000${keysText}`, prob)
        )
          continue;
        seen.add(e.content);
        matchedContents.add(e.content);
        added.push({ order: e.insertion_order ?? 0, content: e.content });
        if (e.sticky === true) stickyHits.push(e.content);
        if (typeof e.cooldown === "number" && e.cooldown > 0) cooldownHits[e.content] = e.cooldown;
      }
      if (added.length === 0) break;
      roundHits = roundHits.concat(added);
    }

    // 预算截断(每本独立预算,按顺序注入)
    roundHits.sort((a, b) => a.order - b.order);
    let total = 0;
    for (const h of roundHits) {
      if (total + h.content.length > budget) break;
      hits.push(h);
      total += h.content.length;
    }
  }

  return {
    text:
      hits.length === 0
        ? ""
        : `【世界书 / 世界观设定】\n${hits.map((h) => h.content).join("\n\n")}`,
    stickyHits,
    // 递减幸存的旧冷却 ∪ 本轮新命中(新命中覆盖为完整冷却)
    cooldownHits: { ...cooldownLeft, ...cooldownHits },
  };
}

/** 兼容旧签名:只返回文本(不带 timed 追踪) */
export function collectLorebookText(
  lorebooks: CharacterBook[],
  recentMessages: Pick<Message, "role" | "content">[],
  currentInput: string,
  timed?: TimedLoreState
): string {
  return collectLorebookTextWithTimed(lorebooks, recentMessages, currentInput, timed).text;
}

function swapVars(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

/**
 * 会话消息变量替换(酒馆 {{var::name}} / {{getvar::name}} 宏):
 * 在既有 {{char}}/{{user}} 等替换之后应用;未定义的变量替换为空串。
 * 纯函数,方便单测。
 */
export function resolveVarMacros(text: string, vars: Record<string, string> | undefined): string {
  if (!text || !vars) return text;
  return text.replace(
    /\{\{var::([^}]+)\}\}|\{\{getvar::([^}]+)\}\}/g,
    (_m, a: string, b: string) => {
      const key = (a || b || "").trim();
      return key ? (vars[key] ?? "") : "";
    }
  );
}

/**
 * 群聊多角色三段式拆分(缓存友好):角色定义(名/描述/性格/场景,不含内嵌书)进 stableSystem,
 * 全局+启用独立+各角色内嵌书合并进 lorebook 尾部,摘要尾部。
 */
export function buildGroupSystemParts(ctx: {
  cards: CharacterCard[];
  persona?: Persona | null | undefined;
  personaName?: string | undefined;
  lorebooks: CharacterBook[];
  recentMessages: Pick<Message, "role" | "content">[];
  currentInput: string;
  summary?: string | undefined;
  timed?: TimedLoreState | undefined;
  /** 群聊队列:这轮轮到谁发言(角色名),提示 AI 不要抢话 */
  queueCharName?: string | undefined;
}): { stableSystem: string; lorebook: string; summary: string; timedResult: LoreCollectResult } {
  const { cards, persona, personaName, lorebooks, recentMessages, currentInput, summary } = ctx;
  const user = personaName || persona?.name || "User";

  // roleDefs 只含稳定字段;各角色内嵌书(随对话变)合并进 lorebook 尾部
  const roleDefs = cards
    .map((c) =>
      [`### ${c.name}`, `描述: ${c.description}`, `性格: ${c.personality}`, `场景: ${c.scenario}`]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");

  const ownBooks = cards.map((c) => c.character_book).filter((b): b is CharacterBook => !!b);
  const loreResult = collectLorebookTextWithTimed(
    [...lorebooks, ...ownBooks],
    recentMessages,
    currentInput,
    ctx.timed
  );
  const lorebook = loreResult.text;
  const personaBlock = persona?.description
    ? `【我的身份】\nYou are ${persona.name}. ${persona.description}`
    : "";

  const stable = [
    "这是群聊角色扮演场景。以下是所有在场角色:",
    "",
    roleDefs,
    "",
    personaBlock,
    "",
    "规则:",
    "1. 每次回复由【一个】角色发出,保持该角色的身份与口吻。",
    "2. 回复必须以 `【角色名】` 开头(角色名取自上面的角色列表),然后才是内容。",
    "3. 必要时可描写动作/神态,但不要替其他角色或 {{user}} 说话。",
    `4. 你是 ${user} 的对话对象。`,
    ...(ctx.queueCharName ? [`5. 这一轮轮到 ${ctx.queueCharName} 发言,其他角色不要抢话。`] : []),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    stableSystem: swapVars(stable, { user, char: cards[0]?.name || "角色" }),
    lorebook,
    summary: summary?.trim() || "",
    timedResult: loreResult,
  };
}

/**
 * 群聊多角色 systemPrompt(酒馆群聊;向后兼容单字符串,三段拼回)。
 */
export function buildGroupSystemPrompt(ctx: Parameters<typeof buildGroupSystemParts>[0]): string {
  const { stableSystem, lorebook, summary } = buildGroupSystemParts(ctx);
  let rp = stableSystem;
  if (lorebook) rp = `${rp}\n\n【世界观设定】\n${lorebook}`;
  if (summary) rp = `${rp}\n\n【对话摘要】\n${summary}`;
  return rp;
}

/**
 * 三段式拆分(DeepSeek 缓存优化核心):
 *  - stableSystem:模板({{lorebook}}/{{summary}} 先置空)+ persona + post_history + baseSystemPrompt —— 完全稳定
 *  - lorebook:世界书命中(可变尾部)
 *  - summary:对话摘要(可变尾部)
 * 发送链路把三段拼成 messages:system(stable) 在前、lorebook/summary 尾部、user 最后,
 * 保证「前缀恒定、只尾部变」→ 长对话 DeepSeek 前缀缓存持续命中(80-90%+)。
 */
export function buildRpSystemParts(ctx: RpContext): {
  stableSystem: string;
  lorebook: string;
  summary: string;
  /** V3 扩展:深度提示词(对话到第 depth 条消息时注入;未到深度/未配置时为 undefined) */
  depthPrompt?: { depth: number; prompt: string } | undefined;
  /** 定时世界书追踪(sticky 命中/cooldown 命中),供调用方持久化到会话 */
  timedResult: LoreCollectResult;
} {
  const {
    card,
    persona,
    preset,
    baseSystemPrompt,
    lorebooks,
    recentMessages,
    currentInput,
    timed,
  } = ctx;

  const user = persona?.name || "User";
  const char = card.name || "Character";
  const personaBlock =
    persona && persona.description
      ? `【我的身份】\nYou are ${persona.name}. ${persona.description}`
      : "";

  const vars: Record<string, string> = {
    char,
    user,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    mes_example: card.mes_example,
    first_mes: card.first_mes,
    system_prompt: baseSystemPrompt || "",
    persona: personaBlock,
    lorebook: "",
    summary: "",
    time: new Date().toLocaleString("zh-CN"),
  };

  let template = "";
  if (card.system_prompt?.trim()) {
    // 角色卡自己的提示词恒定最高优先 —— 「角色只管自己的提示词与世界书」
    // （开发者 2026-09-25 确认的设计边界）
    template = card.system_prompt;
  } else {
    // 名册路径：数组形态 → 取所有已启用条目按 order 拼装（一条都没启用就是空串）
    const rosterText = Array.isArray(preset) ? assembleRoster(preset) : "";
    // 回退路径：单套预设（数组形态下它已被名册取代，不再参与）
    const singleText = Array.isArray(preset) ? "" : (preset?.template ?? "");
    template =
      rosterText.trim() ||
      singleText ||
      "你扮演 {{char}}。{{description}} {{personality}} {{scenario}} 与 {{user}} 对话,保持角色。";
  }

  let stable = swapVars(template, vars);

  // persona 块:模板里有 {{persona}} 就用,否则追加尾部
  if (personaBlock && !/\{\{persona\}\}/.test(template)) {
    stable = `${stable}\n\n${personaBlock}`;
  }

  // post_history_instructions:放在 system 尾部(酒馆习惯),仅角色卡有值时拼
  if (card.post_history_instructions?.trim()) {
    stable = `${stable}\n\n${swapVars(card.post_history_instructions, vars)}`;
  }

  // 合并会话原有 system_prompt(若模板未用 {{system_prompt}} 且内容存在)
  if (baseSystemPrompt?.trim() && !/\{\{system_prompt\}\}/.test(template)) {
    stable = `${stable}\n\n${baseSystemPrompt}`;
  }

  const loreResult = collectLorebookTextWithTimed(lorebooks, recentMessages, currentInput, timed);

  return {
    stableSystem: stable,
    lorebook: loreResult.text,
    summary: ctx.summary?.trim() || "",
    timedResult: loreResult,
    // V3 扩展:深度提示词(对话到第 depth 条消息时注入,文本恒定 → 缓存友好)
    depthPrompt: card.depth_prompt?.prompt?.trim()
      ? {
          depth: Math.max(0, Math.floor(card.depth_prompt.depth)),
          prompt: swapVars(card.depth_prompt.prompt, vars),
        }
      : undefined,
  };
}

/**
 * V3 扩展:把深度提示词注入已组装的 API messages。
 * 语义(酒馆 Depth Prompt):messages[0] 是 system(stable),第 depth 条历史消息后
 * 插入该提示;对话未到深度(historyLen < depth)时不激活。注入位置固定、文本恒定,
 * 注入点之前的全部内容跨轮不变 → 不破坏三段式缓存前缀。
 */
export function injectDepthPrompt(
  messages: Pick<Message, "role" | "content">[],
  depthPrompt: { depth: number; prompt: string } | undefined,
  historyLen: number
): Pick<Message, "role" | "content">[] {
  if (!depthPrompt || !depthPrompt.prompt.trim()) return messages;
  if (historyLen < depthPrompt.depth) return messages;
  const at = Math.min(1 + depthPrompt.depth, messages.length);
  return [
    ...messages.slice(0, at),
    { role: "system", content: `【深度提示词】\n${depthPrompt.prompt.trim()}` },
    ...messages.slice(at),
  ];
}

/** Author's Note 注入配置(酒馆 note 扩展的简化四维) */
export interface AuthorNoteConfig {
  text: string;
  /** 插入深度:聊天内模式在第 N 条消息后插入;prompt 模式忽略 */
  depth?: number | undefined;
  /** 插入位置:"in_chat"= 聊天内(靠消息)/ "prompt"= prompt 尾部(默认) */
  position?: "in_chat" | "prompt" | undefined;
  /** 消息角色:system(默认)/ user / assistant */
  role?: "system" | "user" | "assistant" | undefined;
}

/**
 * Author's Note 注入(酒馆 note 扩展对齐):按 depth/position/role 把作者注插入 messages。
 * - position="prompt"(默认):插入到 user 最后一条之前(system 角色),即 prompt 尾部。
 * - position="in_chat":在历史第 depth 条消息之后插入(对齐酒馆 note_depth)。
 * - role:决定插入消息的角色。
 * 返回新数组(不修改原数组)。
 */
export function injectAuthorNote(
  messages: Pick<Message, "role" | "content">[],
  note: AuthorNoteConfig | undefined
): Pick<Message, "role" | "content">[] {
  if (!note || !note.text?.trim()) return messages;
  const text = note.text.trim();
  const role = note.role || "system";
  const content = role === "system" ? `【作者注】\n${text}` : text;
  const base = { role, content } as const;

  if (note.position === "in_chat") {
    // 聊天内:在第 depth 条消息后插入(缺省 4);越界则插末尾
    const depth = Math.max(0, note.depth ?? 4);
    const at = Math.min(1 + depth, messages.length);
    return [...messages.slice(0, at), base, ...messages.slice(at)];
  }
  // prompt 模式:插在最后一条 user 之前(prompt 尾部)
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const at = lastUser >= 0 ? lastUser : messages.length;
  return [...messages.slice(0, at), base, ...messages.slice(at)];
}

/**
 * 组装角色扮演 system_prompt(向后兼容:三段拼成单个字符串)。
 * 优先级:角色自定义 system_prompt > 选中预设模板 > 兜底模板。
 */
export function buildRpSystemPrompt(ctx: RpContext): string {
  const { stableSystem, lorebook, summary, depthPrompt } = buildRpSystemParts(ctx);
  let rp = stableSystem;
  if (depthPrompt) {
    rp = `${rp}\n\n【深度提示词】\n${depthPrompt.prompt}`;
  }
  if (lorebook) {
    rp = `${rp}\n\n${lorebook}`;
  }
  if (summary) {
    rp = `${rp}\n\n【对话摘要】\n${summary}`;
  }
  return rp;
}
