// stores/chat/rp-messages.ts — RP 会话的 API 消息组装（从 useChatStore.sendMessage 抽出）
//
// 工作模式里带角色卡的会话走三段式：stableSystem 前缀恒定、世界书/摘要尾部可变，
// 只尾部变才能让 DeepSeek 的前缀缓存持续命中。这段逻辑原先埋在 sendMessage 的
// 394 行里，和流式回调、落盘、插件调用混在一起 —— 抽出来才有测试可言。
//
// 注意：深度提示词（酒馆 V3 的 depth_prompt）不是追加在尾部，而是**插进历史中间**
// 固定位置；它的文本恒定、注入点之前的全部内容跨轮不变，所以同样不破坏缓存前缀。

import type { Message } from "@/types";

export function assembleRpMessages(args: {
  stableSystem: string;
  history: readonly Message[];
  lorebook?: string | undefined;
  summary?: string | undefined;
  depthPrompt?: { depth: number; prompt: string } | undefined;
}): Pick<Message, "role" | "content">[] {
  const out: Pick<Message, "role" | "content">[] = [
    { role: "system", content: args.stableSystem },
  ];

  // 历史里的 system 消息一律丢弃：它们已经在 stableSystem 里了
  for (const m of args.history) {
    if (m.role !== "system") out.push({ role: m.role, content: m.content });
  }

  if (args.lorebook) out.push({ role: "system", content: args.lorebook });
  if (args.summary) out.push({ role: "system", content: `【对话摘要】\n${args.summary}` });

  // 深度提示词：对话长度够 depth 条时才激活，插在 stableSystem 之后第 depth 条
  if (args.depthPrompt && args.history.length >= args.depthPrompt.depth) {
    const at = Math.min(1 + args.depthPrompt.depth, out.length);
    out.splice(at, 0, { role: "system", content: `【深度提示词】\n${args.depthPrompt.prompt}` });
  }

  return out;
}
