// plugin/builtin/translator.ts — Built-in translation plugin
//
// 接线真实能力:调 `lib/translate.ts translateText`(与酒馆翻译同链路,
// 非 AI 引擎:Google 免key/DeepL/Libre),不消耗对话模型。

import { translateText } from "@/lib/translate";
import { containsChinese } from "@/lib/translate";
import type { ChatPlugin } from "../types";

export const translatorPlugin: ChatPlugin = {
  manifest: {
    id: "builtin-translator",
    name: "Translator",
    version: "1.1.0",
    description: "Translate messages between Chinese and English",
    author: "Built-in",
  },
  hooks: {
    onCommand: async (cmd, args, ctx) => {
      if (cmd !== "translate") return null;
      const msgs = ctx.getConversationMessages();
      // 优先最后一条 AI 回复,无则回退最后一条 user 消息
      const last =
        [...msgs].reverse().find((m) => m.role === "assistant") ||
        [...msgs].reverse().find((m) => m.role === "user");
      if (!last) return "No message to translate.";

      const target = containsChinese(last.content) ? "English" : "中文";
      ctx.notify(`🌐 正在翻译为 ${target}...`);
      try {
        const translated = await translateText(last.content, target);
        if (!translated) return "翻译失败:引擎未返回结果";
        return `**译文(${target})**\n${translated}`;
      } catch (e) {
        return `翻译失败: ${e}`;
      }
    },
  },
  enabled: false,
};
