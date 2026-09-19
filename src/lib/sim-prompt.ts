// lib/sim-prompt.ts — 推演模式(酒馆子模式)提示词组装 + 世界状态解析(纯函数,无 Tauri 依赖)
//
// 三段式(DeepSeek 缓存核心,与 rp-prompt 同构):
//  - stableSystem:类型规则指令(按 type 切换)+ 设定 setup + 节奏规则 —— 恒定前缀
//  - stateBlock:当前时间 + 世界状态(按 stateMode:text 直拼 / table 转键值表 / none 空)—— 可变尾部
//  - summary:记忆卡摘要 —— 可变尾部
// 发送链路拼成 messages:system(stable) 在前、stateBlock/summary 尾部、user 最后,
// 保证「前缀恒定、只尾部变」→ 长推演 DeepSeek 前缀缓存持续命中。

import type {
  Message,
  SimStateMode,
  SimStateUpdate,
  SimType,
  SimulationConversation,
} from "@/types";

/** 推演节奏规则(按 pacing 注入 stableSystem,静态 → 缓存友好) */
function pacingRule(pacing: SimulationConversation["pacing"]): string {
  switch (pacing) {
    case "turn":
      return "节奏:回合制。你每轮推演一步剧情,等待玩家下一个指令;玩家可能用「继续推演」让你自主续写,此时自然推进直到玩家介入。";
    case "time":
      return "节奏:时间步进。玩家会指定时间跨度(如 3 天 / 1 年),你推演该时段内发生的事件简报;未指定时按一自然时间段推进。";
    case "auto":
      return "节奏:自动连续推演。玩家可要求你连续推演多轮,你按当前局面自然发展,逐步展开;每轮之间保持因果连贯。";
  }
}

/** 类型规则指令(按 type 切换;story/sandbox/tactical 各自的行为约束) */
function typeRule(type: SimType): string {
  switch (type) {
    case "story":
      return [
        "这是【剧情推演】模式。你扮演故事导演与推演引擎:",
        "1. 玩家的每条输入(行动/决策/对话)都会推进剧情,你推演出合理的发展与后果,保持因果与人物动机一致。",
        "2. 不要替玩家决定其角色的行动或内心——玩家角色的选择永远由玩家做出。",
        "3. 可以引入新事件、配角、冲突与转折,但不得违背已确立的世界观事实。",
        "4. 每轮推演 1-4 段,语气是叙述体,保留沉浸感。",
      ].join("\n");
    case "sandbox":
      return [
        "这是【世界沙盒】模式。你负责推演一个世界的宏观演化:",
        "1. 多势力 / 多人物 / 多事件并行发展,每次推演给出该时段内的主要变化(政治、军事、经济、自然、人物命运等)。",
        "2. 玩家可以注入事件(天灾、奇遇、命令)、改变势力行为或提问世界细节,你按设定与既有局势推演其连锁反应。",
        "3. 保持世界自洽:已被设定的发展不得随意反转,除非有明确诱因。",
        "4. 视角宏观,可按时间线/地理/势力分段叙述。",
      ].join("\n");
    case "tactical":
      return [
        "这是【战术行动】模式。你负责数值裁定与战斗/行动结算:",
        "1. 玩家的每个行动先评估成功率(可明示,如 65%);若玩家提供了骰子结果(🎲 格式),严格按结果结算:通过=行动达成,失败=行动受阻并给出后果。",
        "2. 未掷骰时由你判定:高风险行动用 50-80%,绝境行动 20-50%,稳妥行动 80-95%。",
        "3. 结算时给出数值变化(兵力 / 资源 / 士气 / 状态)与叙事后果,数值更新保持连贯。",
        "4. 每轮输出以「裁定」为主,附 1-3 段结果叙事。",
      ].join("\n");
  }
}

/** 状态更新策略指令:inline 模式要求输出带结构化标记,供前端解析(不产生额外流) */
function stateUpdateRule(update: SimStateUpdate, stateMode: SimStateMode): string {
  if (update !== "inline") return "";
  if (stateMode === "table") {
    return "【输出格式要求】每次推演回复末尾必须附【状态表】段(每行一条 `键: 值`,反映当前局势),并在开头或结尾附一行 `[时间线] 时间:事件` 概括本次关键进展。";
  }
  return "【输出格式要求】每次推演回复末尾必须附【状态】段(2-4 句当前世界局面),并在开头或结尾附一行 `[时间线] 时间:事件` 概括本次关键进展。";
}

export interface SimPromptContext {
  conv: SimulationConversation;
  /** 最近消息(纯用于长度信息;推演不需要关键词扫描,历史直接进 messages) */
  recentMessages: Pick<Message, "role" | "content">[];
}

/** 世界状态块(可变尾部):当前时间 + 状态(按 stateMode 形态输出) */
export function buildStateBlock(conv: SimulationConversation): string {
  const parts: string[] = [];
  if (conv.timeLabel) parts.push(`【当前时间】${conv.timeLabel}`);
  if (conv.stateMode === "text" && conv.worldState.trim()) {
    parts.push(`【世界状态】\n${conv.worldState.trim()}`);
  } else if (conv.stateMode === "table") {
    const rows = Object.entries(conv.stateTable).filter(([, v]) => v.trim() !== "");
    if (rows.length > 0) {
      parts.push(`【状态表】\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}`);
    }
  }
  return parts.join("\n\n");
}

/**
 * 三段式拆分(推演模式):stableSystem 恒定(类型指令+setup+节奏+格式要求),
 * stateBlock 可变尾部,summary 可变尾部。
 */
export function buildSimSystemParts(ctx: SimPromptContext): {
  stableSystem: string;
  stateBlock: string;
  summary: string;
} {
  const { conv } = ctx;
  const vars: Record<string, string> = {
    setup: conv.setup.trim(),
    world_state: buildStateBlock(conv),
    time: conv.timeLabel || "初始时间",
  };
  const swap = (s: string) => {
    let out = s;
    for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
    return out;
  };

  const blocks: string[] = [typeRule(conv.type), ""];
  // 设定(稳定前缀的核心内容;setup 里可用 {{time}}/{{world_state}} 宏)
  blocks.push(
    conv.setup.trim()
      ? swap(`【世界设定】\n${conv.setup.trim()}`)
      : "【世界设定】\n(未填写,请基于玩家后续输入自然建立世界观)"
  );
  // 钉住区(40):关键承诺/伏笔/人物关系钉入稳定前缀区(缓存友好,永远在场)
  if (conv.pinned?.trim()) {
    blocks.push(`【钉住】\n${conv.pinned.trim()}`);
  }
  // 漂移回锚(39):回锚摘要入稳定前缀(旧锚点是已确立事实,不应随对话漂移)
  if (conv.anchor?.trim()) {
    blocks.push(`【既定事实锚点】\n${conv.anchor.trim()}`);
  }
  blocks.push(pacingRule(conv.pacing));
  // 观察/干预双通道(43):旁观模式提示 AI 自主推进,玩家只观察
  if (conv.observerMode) {
    blocks.push(
      "当前为旁观模式:你自主推进世界演化(可按时间步/事件自然发展),玩家仅观察,不需等待玩家指令。"
    );
  }
  const updateRule = stateUpdateRule(conv.stateUpdate, conv.stateMode);
  if (updateRule) blocks.push(updateRule);

  return {
    stableSystem: blocks.filter(Boolean).join("\n\n"),
    stateBlock: buildStateBlock(conv),
    summary: conv.summary?.trim() || "",
  };
}

/** 向后兼容:三段拼成单个 system 字符串(无 stateBlock 时原样) */
export function buildSimSystemPrompt(ctx: SimPromptContext): string {
  const { stableSystem, stateBlock, summary } = buildSimSystemParts(ctx);
  let s = stableSystem;
  if (stateBlock) s = `${s}\n\n${stateBlock}`;
  if (summary) s = `${s}\n\n【对话摘要】\n${summary}`;
  return s;
}

/** 从推演输出解析时间线事件行:[时间线] 时间:事件(可多行;括号标记允许行中,宽松匹配)。
 *  支持分层标记(38):`[里程碑]` → milestone,`[日志]` → log,缺省 → event。 */
export function parseTimelineLines(
  content: string,
  fallbackTime: string
): { time: string; event: string; kind?: "event" | "log" | "milestone" }[] {
  const out: { time: string; event: string; kind?: "event" | "log" | "milestone" }[] = [];
  const re =
    /\[(时间线|时间|事件|里程碑|日志)\]\s*([^\n]+)|^\s*-?\s*(?:事件|时间)\s*[：:]\s*([^\n]+)/gm;
  for (const m of content.matchAll(re)) {
    const marker = m[1];
    const raw = (m[2] || m[3] || "").trim();
    if (!raw) continue;
    // 分层:按括号标记词判断(里程碑/日志)——避免只靠内容前缀误判
    let kind: "event" | "log" | "milestone" | undefined;
    if (marker === "里程碑") kind = "milestone";
    else if (marker === "日志") kind = "log";
    let line = raw;
    // 行内再拆 "时间:事件"(取第一个分隔;无分隔则事件整行、时间用 fallback)
    const sep = line.indexOf(":");
    const sepC = line.indexOf("：");
    const idx = sep >= 0 && (sepC < 0 || sep < sepC) ? sep : sepC;
    if (idx > 0 && idx < line.length - 1) {
      const time = line.slice(0, idx).trim();
      const event = line.slice(idx + 1).trim();
      if (event) out.push({ time: time || fallbackTime, event, ...(kind ? { kind } : {}) });
    } else {
      out.push({ time: fallbackTime, event: line, ...(kind ? { kind } : {}) });
    }
  }
  return out;
}

/** 从推演输出解析【状态】段(到下一个标记或末尾) */
export function parseStateText(content: string): string | null {
  const m = /【状态】\s*\n?([\s\S]*?)(?=\n\s*【|\n\s*\[时间线]|\n\s*\[状态表]|$)/.exec(content);
  if (!m) return null;
  const text = (m[1] ?? "").trim();
  return text || null;
}

/** 从推演输出解析【状态表】段(每行 `键: 值`;容忍 = 分隔) */
export function parseStateTable(content: string): Record<string, string> | null {
  const m = /【状态表】\s*\n?([\s\S]*?)(?=\n\s*【|\n\s*\[时间线]|$)/.exec(content);
  if (!m) return null;
  const table: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const idx = line.indexOf(":");
    const idxC = line.indexOf("：");
    const idxEq = line.indexOf("=");
    let sep = -1;
    if (idx >= 0 && (idxC < 0 || idx < idxC)) sep = idx;
    else if (idxC >= 0) sep = idxC;
    else if (idxEq >= 0) sep = idxEq;
    if (sep <= 0) continue;
    const k = line.slice(0, sep).trim();
    const v = line.slice(sep + 1).trim();
    if (k && v) table[k] = v;
  }
  return Object.keys(table).length > 0 ? table : null;
}

/** 从推演输出解析【当前时间】或时间线内的新时间(时间步进更新用) */
export function parseTimeLabel(content: string, fallback: string): string {
  const m = /【(?:当前时间|时间)】\s*[:：]?\s*([^\n【\]]+)/.exec(content);
  if (m && (m[1] ?? "").trim()) return (m[1] ?? "").trim();
  const tl = parseTimelineLines(content, fallback);
  const first = tl[0];
  if (tl.length > 0 && first?.time && first.time !== fallback) return first.time;
  return fallback;
}

/**
 * 掷骰数据化(37):返回结构化结果而非纯文本——判定可复核、可展开明细
 * (DC/骰面/修正),tactical 指令让模型读结构化骰子(而非解析纯文本)。
 * dice 如 "D100"/"D20"/"D6",threshold 可选(成功率判定,大等于通过)。
 */
export interface DiceResult {
  dice: string;
  roll: number;
  threshold: number | null;
  pass: boolean | null;
  /** 展示文本,如 "🎲 [D100] 74 ≥ 65 → 成功" */
  text: string;
}

export function rollDice(dice: string, threshold?: number | null): DiceResult {
  const sides = parseInt(dice.replace(/\D/g, ""), 10) || 20;
  const roll = Math.floor(Math.random() * sides) + 1;
  const th = threshold != null && threshold > 0 ? Math.round(threshold) : null;
  const pass = th != null ? roll >= th : null;
  let text = `🎲 [${dice.toUpperCase()}] ${roll}`;
  if (th != null) {
    text += ` ${pass ? "≥" : "<"} ${th} → ${pass ? "成功" : "失败"}`;
  }
  return { dice: dice.toUpperCase(), roll, threshold: th, pass, text };
}
