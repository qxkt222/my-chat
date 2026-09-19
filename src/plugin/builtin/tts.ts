// plugin/builtin/tts.ts — Text-to-Speech plugin

import type { ChatPlugin } from "../types";

export const ttsPlugin: ChatPlugin = {
  manifest: {
    id: "builtin-tts",
    name: "Text to Speech",
    version: "1.0.0",
    description: "Read AI responses aloud (Web Speech API)",
    author: "Built-in",
  },
  hooks: {
    onCommand: async (cmd, args, ctx) => {
      if (cmd !== "speak") return null;
      if (!("speechSynthesis" in window)) return "TTS not supported in this browser.";

      const msgs = ctx.getConversationMessages();
      const lastAsm = msgs.filter((m) => m.role === "assistant").pop();
      if (!lastAsm) return "No AI response to speak.";

      const utterance = new SpeechSynthesisUtterance(lastAsm.content.slice(0, 500));
      utterance.lang = "zh-CN";
      utterance.rate = 1.0;
      window.speechSynthesis.speak(utterance);
      ctx.notify("🔊 Speaking...");
      return null;
    },
  },
  enabled: false,
};
