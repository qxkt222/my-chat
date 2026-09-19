// lib/context-budget.ts — Token 预算系统(监控 + 手动/自动双模式)
//
// 自动模式:发送前按优先级收缩 messages,超限从低优先级裁起;
// 历史超限时【整段替换为摘要】(不是逐条删——保三段式前缀稳定、DeepSeek 缓存不失效)。
// 手动模式:不自动砍,返回各段占用供 UI 提示。
//
// 优先级(高→低,超预算从低砍):
//   P0 stableSystem / 钉住 / 回锚(永不砍——缓存核心)
//   P1 摘要        P2 向量记忆      P3 世界书
//   P4 历史        P5 尾部注入(stateBlock/作者注/深度提示词/knowledge/相关记忆)

import { countTokens } from "@/lib/token-counter";
import type { BudgetConfig, Message, ModelConfig } from "@/types";

/** 消息段标注:名称 + 优先级 + 是否可砍 */
export interface BudgetSegment {
  name: string;
  priority: 0 | 1 | 2 | 3 | 4 | 5;
  /** 该段在 messages 中的下标集合 */
  indices: number[];
}

/** 收缩结果 */
export interface BudgetResult {
  /** 收缩后的 messages(自动模式可能被砍) */
  messages: Pick<Message, "role" | "content">[];
  /** 是否超预算(手动模式:仅提示不砍) */
  over: boolean;
  /** 各段 token 占用(UI 展示) */
  segments: { name: string; tokens: number; priority: number }[];
  /** 总 token(收缩后) */
  total: number;
  /** 预算上限 */
  budget: number;
}

export function estimateTokens(text: string): number {
  return countTokens(text);
}

/** 模型上下文预算:context_window × usage_pct(缺省保守窗口回退 default) */
export function budgetFor(model: ModelConfig | undefined, cfg: BudgetConfig): number {
  const window = model?.parameters?.context_window ?? cfg.default_context_window ?? 8192;
  const pct = Math.min(100, Math.max(10, cfg.usage_pct ?? 90));
  return Math.floor((window * pct) / 100);
}

/**
 * 给组装好的 apiMessages 分段(按内容特征识别),供收缩/展示共用。
 * 约定:各链路的 system 注入段带固定前缀标记(【钉住】【对话摘要】【世界书】
 * 【作者注】【深度提示词】【相关记忆】【状态】【时间】【此前对话摘要】…)。
 * 识别规则:历史 = user/assistant 消息;其余 system 按前缀归类。
 */
function segmentMessages(msgs: Pick<Message, "role" | "content">[]): {
  segments: BudgetSegment[];
  historyIndices: number[];
} {
  const segments: BudgetSegment[] = [];
  const historyIndices: number[] = [];
  const push = (name: string, priority: 0 | 1 | 2 | 3 | 4 | 5, idx: number) => {
    const seg = segments.find((s) => s.name === name);
    if (seg) seg.indices.push(idx);
    else segments.push({ name, priority, indices: [idx] });
  };

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role === "user" || m.role === "assistant") {
      historyIndices.push(i);
      continue;
    }
    const c = m.content;
    // 前缀识别(按现有链路注入格式)
    if (c.startsWith("【钉住】")) push("钉住", 0, i);
    else if (c.startsWith("【既定事实锚点】") || c.startsWith("【回锚】")) push("回锚", 0, i);
    else if (c.startsWith("【对话摘要】") || c.startsWith("【此前对话摘要】")) push("摘要", 1, i);
    else if (c.startsWith("【相关记忆】")) push("向量记忆", 2, i);
    else if (c.startsWith("【世界书") || c.startsWith("【世界观设定】")) push("世界书", 3, i);
    else if (c.startsWith("【作者注】")) push("作者注", 5, i);
    else if (c.startsWith("【深度提示词】")) push("深度提示词", 5, i);
    else if (c.startsWith("【状态") || c.startsWith("【当前时间】")) push("状态块", 5, i);
    else if (c.startsWith("Reference Knowledge")) push("知识上下文", 5, i);
    else push("稳定前缀", 0, i); // 其余 system 默认 P0(stableSystem)
  }
  return { segments, historyIndices };
}

/**
 * 收缩入口。自动模式超限时按优先级从低砍:
 *  - P5 段整体移除(知识上下文/作者注/深度提示词/状态块/相关记忆)
 *  - 再砍 P3 世界书(只保留 score 排序已由 collectLorebookText 做过,这里整段去)
 *  - 再砍 P2 向量记忆、P1 摘要(整段去,最后保 P0)
 *  - 历史超限(自动模式):整段替换为【对话摘要】(若有 conv.summary)——不是逐条删
 * 返回收缩结果;手动模式只返回 over 与占用。
 */
export function shrinkMessages(
  msgs: Pick<Message, "role" | "content">[],
  budget: number,
  opts: { mode: BudgetConfig["mode"]; summary?: string | undefined }
): BudgetResult {
  const { segments, historyIndices } = segmentMessages(msgs);
  const total0 = msgs.reduce((s, m) => s + estimateTokens(m.content), 0);

  const tokenOf = (indices: number[]) =>
    indices.reduce((s, i) => s + estimateTokens(msgs[i]?.content || ""), 0);

  const segmentRows = segments
    .map((seg) => ({ name: seg.name, tokens: tokenOf(seg.indices), priority: seg.priority }))
    .sort((a, b) => a.priority - b.priority);

  if (opts.mode !== "auto" || total0 <= budget) {
    return {
      messages: msgs,
      over: total0 > budget,
      segments: segmentRows,
      total: total0,
      budget,
    };
  }

  // 自动模式:从最低优先级向上逐级移除
  let working = [...msgs];
  const removed = new Set<number>();
  const canDrop = [...segments]
    .filter((s) => s.priority >= 1)
    .sort((a, b) => b.priority - a.priority);
  for (const seg of canDrop) {
    if (working.reduce((s, m) => s + estimateTokens(m.content), 0) <= budget) break;
    // 世界书降级:先只砍 P5,再 P3/2/1(保 P0)
    if (seg.priority === 0) continue;
    for (const i of seg.indices) removed.add(i);
    working = working.filter((_, i) => !removed.has(i));
  }

  // 历史仍超限 → 整段替换为摘要(保三段式前缀稳定,缓存不失效)
  let historyKept = working.filter((_, i) => !historyIndices.includes(i));
  let historyMsgs = working.filter((_, i) => historyIndices.includes(i));
  if (historyMsgs.length > 0) {
    const histTokens = historyMsgs.reduce((s, m) => s + estimateTokens(m.content), 0);
    const sumTokens = estimateTokens(opts.summary || "");
    if (histTokens > 0 && sumTokens < histTokens) {
      if (opts.summary?.trim()) {
        historyKept = [
          ...historyKept,
          { role: "system" as const, content: `【对话摘要】\n${opts.summary.trim()}` },
        ];
      }
      historyMsgs = [];
    }
  }
  working = [...historyKept, ...historyMsgs];

  const final = working;
  const over = final.reduce((s, m) => s + estimateTokens(m.content), 0) > budget;
  // 重新分段统计(收缩后)
  const { segments: seg2 } = segmentMessages(final);
  return {
    messages: final,
    over,
    segments: seg2.map((s) => ({
      name: s.name,
      tokens: s.indices.reduce((acc, i) => acc + estimateTokens(final[i]?.content || ""), 0),
      priority: s.priority,
    })),
    total: final.reduce((s, m) => s + estimateTokens(m.content), 0),
    budget,
  };
}
