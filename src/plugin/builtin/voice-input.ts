// plugin/builtin/voice-input.ts — Voice input plugin (降级:WebView2 不支持)
//
// Tauri WebView2/Chromium 桌面端不提供 Web Speech Recognition(SpeechRecognition
// 未实现),原实现调用必然走 error 分支——属于"永远用不了的假功能"。
// 降级为明确提示,不再假装支持。

import type { ChatPlugin } from "../types";

export const voiceInputPlugin: ChatPlugin = {
  manifest: {
    id: "builtin-voice-input",
    name: "Voice Input",
    version: "1.1.0",
    description: "Record voice and convert to text",
    author: "Built-in",
  },
  hooks: {
    onCommand: async (cmd, _args, _ctx) => {
      if (cmd !== "voice") return null;
      return "语音输入暂不支持:桌面 WebView 未实现 Web Speech Recognition。\n请改用文字输入,或在系统层接入 whisper 等本地识别工具。";
    },
  },
  enabled: false,
};
