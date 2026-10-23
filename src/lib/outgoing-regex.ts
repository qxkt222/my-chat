// lib/outgoing-regex.ts — 出站正则清理（酒馆 placement=2 的「只改提示词」脚本）
//
// 为什么单独一条通路（2026-09-25 实测事故）：
//   那套 `FF5 Regex 3.0 Suite` 里有 5 条脚本的 placement 是 `[2]`——它们**不改显示**，
//   只在消息发给模型之前把不该给模型看的东西剥掉：
//     · 剥 `<internal_states>` / GFX 块（省上下文）
//     · 剥 `<!-- IMG_PROMPT: … -->`
//     · 剥 `<thinking>`/`<thoughts>`/`### Internal Monologue` 等思考块
//   若把它们混进渲染期规则，用户界面上自己的思考块会**凭空消失**（酒馆不是这样）。
//   所以显示与出站各走各的通路，靠 RegexRule.placement 明确区分。
//
// 纯函数：不读全局状态、不落盘 —— 发送前算一遍就丢，绝不改会话里的原始消息。

import type { BudgetConfig, Message } from "@/types";
import type { RegexRule } from "./regex-format";
import { appliesToPrompt } from "./regex-format";
import { compileRegex } from "./regex-cache";
import { shrinkMessages, type BudgetResult } from "./context-budget";

/** 深度口径：只数 user/assistant（与酒馆一致），system 消息不计入 depth */
function isHistoryRole(role: string): boolean {
  return role === "user" || role === "assistant";
}

/**
 * 某条规则在「距末尾 depth 条」的消息上是否生效。
 * 酒馆语义：minDepth ≤ depth ≤ maxDepth；null/undefined 表示该端不限。
 * depth 从末尾 0 起算（最后一条历史 = 0）。
 */
export function depthAllows(rule: RegexRule, depth: number): boolean {
  const min = typeof rule.minDepth === "number" ? rule.minDepth : null;
  const max = typeof rule.maxDepth === "number" ? rule.maxDepth : null;
  if (min !== null && depth < min) return false;
  if (max !== null && depth > max) return false;
  return true;
}

/**
 * 对即将发给模型的消息逐条应用「出站」规则。
 *
 * 返回**新数组**（不原地改），保证调用方手里的 conv.messages 不受影响。
 * 坏正则逐条跳过，不让一条坏规则挡住整轮发送。
 */
export function applyOutgoingRegex(
  messages: Pick<Message, "role" | "content">[],
  rules: RegexRule[]
): Pick<Message, "role" | "content">[] {
  const active = rules.filter((r) => r.enabled && r.pattern && appliesToPrompt(r));
  if (active.length === 0) return messages;

  // 先算每条历史消息的 depth：从末尾往前数，只数 user/assistant
  const depthOf = new Array<number>(messages.length).fill(-1);
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (isHistoryRole(m.role)) {
      depthOf[i] = seen;
      seen += 1;
    }
  }

  return messages.map((m, i) => {
    const depth = depthOf[i];
    if (depth === undefined || depth < 0) return m; // system 等：出站规则不动它
    let out = m.content;
    for (const r of active) {
      if (!depthAllows(r, depth)) continue;
      try {
        // 与世界书/渲染期共用编译缓存（SRC-14）：同一条规则在每条消息上只编译一次
        const re = compileRegex(r.pattern, r.flags || "g");
        if (!re) continue; // 坏/超长正则：跳过本条，不挡住整轮发送
        out = out.replace(re, r.replacement);
      } catch {
        /* 坏正则跳过 */
      }
    }
    return out === m.content ? m : { ...m, content: out };
  });
}

/** 供 UI 提示用：当前有多少条出站规则处于启用状态 */
export function activeOutgoingCount(rules: RegexRule[]): number {
  return rules.filter((r) => r.enabled && r.pattern && appliesToPrompt(r)).length;
}

export interface PrepareOutgoingOptions {
  /** 该模型的 token 预算上限（budgetFor 的结果） */
  budget: number;
  /** 预算模式：auto 才真正裁剪，manual 只统计 */
  mode: BudgetConfig["mode"];
  /** 会话滚动摘要：历史超限时整段替换用 */
  summary?: string | undefined;
  /** 设置里的全部正则；只有 placement 含 2 的会生效 */
  regexRules: RegexRule[];
}

/**
 * 三条发送链路（工作 / 酒馆 / 推演）共用的「发送前准备」。
 *
 * 顺序固定：**先 shrinkMessages（预算收缩），再 applyOutgoingRegex（出站清理）**。
 * 顺序不能反：出站规则按「距末尾 depth」定位消息，必须在最终待发数组上数；
 * 而且先清理再计 token 会让预算统计与实际发送内容脱节（干净内容更小）。
 *
 * 纯函数：返回的 messages 是一份新数组（无规则时可能就是 shrink 的数组），
 * 调用方手里的 conv.messages 永远不被修改。
 */
export function prepareOutgoingMessages(
  messages: Pick<Message, "role" | "content">[],
  opts: PrepareOutgoingOptions
): BudgetResult {
  const shrunk = shrinkMessages(messages, opts.budget, {
    mode: opts.mode,
    summary: opts.summary,
  });
  return {
    ...shrunk,
    messages: applyOutgoingRegex(shrunk.messages, opts.regexRules),
  };
}
