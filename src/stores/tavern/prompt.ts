// stores/tavern/prompt.ts — 发送前的会话变换（从 useTavernStore.ts 拆出）
//
// 这三个函数都是**纯的**：输入会话对象，输出要发给 API 的东西，不碰 store 状态、
// 不读写磁盘。它们原本混在 store 里，现在单独放一处 —— 也正因为纯，将来可以独立补测试。

import type { TavernConversation, Message } from "@/types";
import { resolveVarMacros, type TimedLoreState, type LoreCollectResult } from "@/lib/rp-prompt";

/** 发送前统一替换会话消息变量({{var::x}}/{{getvar::x}});无变量时零开销 */
export function resolveConversationVars(
  messages: Pick<Message, "role" | "content">[],
  conv: TavernConversation
): Pick<Message, "role" | "content">[] {
  if (!conv.variables || Object.keys(conv.variables).length === 0) return messages;
  return messages.map((m) => ({
    role: m.role,
    content: resolveVarMacros(m.content, conv.variables),
  }));
}

/** 合并定时世界书状态:sticky 常驻内容并集 + cooldown 递减幸存值 ∪ 本轮新命中(新命中覆盖为完整冷却) */
export function mergeTimedLore(
  prev: TimedLoreState | undefined,
  result: LoreCollectResult
): TimedLoreState {
  return {
    stickyContents: [...new Set([...(prev?.stickyContents || []), ...result.stickyHits])],
    cooldownLeft: { ...result.cooldownHits },
  };
}

/** 数据银行/聊天附件(酒馆 Data Bank):拼成 system 块注入 prompt(可变尾部,缓存友好) */
export function buildAttachmentBlock(conv: TavernConversation): string {
  const atts = (conv.attachments || []).filter((a) => a.name.trim() && a.content.trim());
  if (atts.length === 0) return "";
  return (
    `【数据银行 / 聊天附件】\n` +
    atts.map((a) => `--- ${a.name} ---\n${a.content}`).join("\n\n")
  );
}
