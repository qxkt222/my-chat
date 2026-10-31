// plugin/builtin/image-gen.ts — Image generation plugin (OpenAI / ComfyUI / SD WebUI)
//
// 接线真实能力:与绘图工作区共用 `useSettingsStore.drawConfig` 与 Rust
// `generate_image`(URL 归一化/引擎分派全在 Rust,前端不再拼端点)。
// 生成结果经 asset 协议转为 URL,以 markdown 图片插入消息。

import { convertFileSrc } from "@tauri-apps/api/core";
import { generateImage } from "@/lib/tauri";
import { useSettingsStore } from "@/stores/useSettingsStore";
import type { DrawRequest } from "@/types";
import type { ChatPlugin } from "../types";

export const imageGenPlugin: ChatPlugin = {
  manifest: {
    id: "builtin-image-gen",
    name: "Image Generation",
    version: "1.2.0",
    description: "Generate images via OpenAI-compatible / ComfyUI / SD WebUI",
    author: "Built-in",
  },
  hooks: {
    onCommand: async (cmd, args, ctx) => {
      if (cmd !== "image") return null;
      if (!args) return "Usage: /image {prompt}";

      const settings = useSettingsStore.getState();
      const cfg = settings.drawConfig;
      const base = {
        prompt: args,
        size: cfg.defaults.size,
        negativePrompt: null,
        steps: cfg.defaults.steps,
        cfgScale: cfg.defaults.cfgScale,
        seed: cfg.defaults.seed,
        sampler: cfg.defaults.sampler || null,
      };

      let req: DrawRequest;
      if (cfg.engine === "chat-model") {
        // 旧行为:沿用当前激活聊天模型的连接信息
        const model = settings.models.find((m) => m.name === settings.activeModel);
        if (!model) return "请先在设置 → 模型 中添加并激活一个模型。";
        req = {
          ...base,
          engine: "openai",
          baseUrl: model.api_url,
          apiKey: model.api_key || null,
          model: model.model || null,
        };
      } else {
        req = {
          ...base,
          engine: cfg.engine,
          baseUrl: cfg.baseUrl.trim(),
          apiKey: cfg.apiKey || null,
          model: cfg.model.trim() || null,
          workflowJson:
            cfg.engine === "comfyui" && cfg.comfyWorkflow.trim() ? cfg.comfyWorkflow : null,
        };
      }

      ctx.notify("🖼 正在生成图片...");
      try {
        const images = await generateImage(req);
        if (images.length === 0) return "图片生成失败:接口未返回图片";
        return images.map((im) => `![generated](${convertFileSrc(im.path)})`).join("\n");
      } catch (e) {
        return `图片生成失败: ${e}`;
      }
    },
  },
  enabled: false,
};
