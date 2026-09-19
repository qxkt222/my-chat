// plugin/builtin/summarizer.ts — Conversation summarizer
//
// 接线真实能力:用当前模型跑独立流总结(不写会话,与"压缩上下文"同链路)。

import { streamChat } from "@/lib/tauri";
import { useSettingsStore } from "@/stores/useSettingsStore";
import type { ChatPlugin } from "../types";

export const summarizerPlugin: ChatPlugin = {
  manifest: {
    id: "builtin-summarizer",
    name: "Conversation Summary",
    version: "1.1.0",
    description: "Auto-summarize the current conversation",
    author: "Built-in",
  },
  hooks: {
    onCommand: async (cmd, args, ctx) => {
      if (cmd !== "summarize") return null;

      const msgs = ctx.getConversationMessages();
      if (msgs.length === 0) return "No messages to summarize.";

      const settings = useSettingsStore.getState();
      const model = settings.models.find((m) => m.name === settings.activeModel);
      if (!model) return "请先在设置 → 模型 中添加并激活一个模型。";

      const transcript = msgs
        .map(
          (m) =>
            `${m.role === "user" ? "用户" : "AI"}${m.model ? `(${m.model})` : ""}：\n${m.content.slice(0, 800)}`
        )
        .join("\n\n---\n\n")
        .slice(0, 9000);
      const sys =
        "你是对话总结器。请把以下对话提炼成精炼的中文摘要（保留关键事实、结论、用户偏好、未决问题），300 字以内，只输出摘要正文。";

      ctx.notify("📊 正在总结对话...");
      // 独立流,不写入会话(不污染历史)
      return await new Promise<string>((resolve) => {
        let acc = "";
        let settled = false;
        const done = (errText?: string) => {
          if (!settled) {
            settled = true;
            resolve(acc.trim() || errText || "总结失败:未返回内容");
          }
        };
        void streamChat(
          {
            model_config: {
              name: model.name,
              provider: model.provider || "",
              api_url: model.api_url,
              api_key: model.api_key,
              model: model.model,
            },
            messages: [
              { role: "system", content: sys },
              { role: "user", content: transcript },
            ],
            temperature: 0.3,
            thinking_enabled: false,
          },
          crypto.randomUUID(),
          {
            onToken: (d) => {
              acc += d;
            },
            onDone: () => done(),
            onError: (e) => done(`总结失败: ${e}`),
          }
        );
      });
    },
  },
  enabled: false,
};
