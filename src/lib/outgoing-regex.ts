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

import type { Message } from "@/types";
import type { RegexRule } from "./regex-format";
import { appliesToPrompt } from "./regex-format";

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
        out = out.replace(new RegExp(r.pattern, r.flags || "g"), r.replacement);
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
