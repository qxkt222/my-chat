// plugin/builtin/image-gen.ts — Image generation plugin (DALL-E / compatible)
//
// 接线真实能力:调用 Rust `generate_image`(与绘图工作区同链路),生成结果
// 经 asset 协议转为 URL,以 markdown 图片插入消息。

import { convertFileSrc } from "@tauri-apps/api/core";
import { generateImage } from "@/lib/tauri";
import { useSettingsStore } from "@/stores/useSettingsStore";
import type { ChatPlugin } from "../types";

export const imageGenPlugin: ChatPlugin = {
  manifest: {
    id: "builtin-image-gen",
    name: "Image Generation",
    version: "1.1.0",
    description: "Generate images via DALL-E compatible API",
    author: "Built-in",
  },
  hooks: {
    onCommand: async (cmd, args, ctx) => {
      if (cmd !== "image") return null;
      if (!args) return "Usage: /image {prompt}";

      // 取当前激活模型(与绘图工作区一致)
      const settings = useSettingsStore.getState();
      const model = settings.models.find((m) => m.name === settings.activeModel);
      if (!model) return "请先在设置 → 模型 中添加并激活一个模型。";

      ctx.notify("🖼 正在生成图片...");
      try {
        // 端点 = {base}/v1/images/generations(build_api_url 兼容裸地址)
        const base = model.api_url.replace(/\/chat\/completions$/, "").replace(/\/v\d$/, "");
        const url = `${base}/v1/images/generations`;
        const path = await generateImage(url, model.api_key, args, model.model, "1024x1024");
        if (!path) return "图片生成失败:接口未返回图片";
        return `![generated](${convertFileSrc(path)})`;
      } catch (e) {
        return `图片生成失败: ${e}`;
      }
    },
  },
  enabled: false,
};
