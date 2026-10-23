// lib/model-config.test.ts — 发送给 Rust 的 model_config 统一构造
//
// 背景：三个 store 里这条 5 字段字面量被抄了 12 次。任何一处漏掉
// `provider: model.provider || ""`，Rust 端适配器选择就会退化到默认分支。
// 这里钉住字段映射，防止以后「顺手加个字段」改变线上请求形状。

import { describe, it, expect } from "vitest";
import { toModelConfig } from "./model-config";

describe("toModelConfig", () => {
  it("字段一一映射", () => {
    expect(
      toModelConfig({
        name: "gpt-x",
        provider: "openai",
        api_url: "https://api.example/v1",
        api_key: "sk-test",
        model: "gpt-x-2026",
      })
    ).toEqual({
      name: "gpt-x",
      provider: "openai",
      api_url: "https://api.example/v1",
      api_key: "sk-test",
      model: "gpt-x-2026",
    });
  });

  it("provider 缺省时降级为空串（历史行为）", () => {
    const out = toModelConfig({
      name: "local",
      api_url: "http://127.0.0.1:8080/v1",
      api_key: "",
      model: "qwen",
    });
    expect(out.provider).toBe("");
  });

  it("provider 为 null 时同样降级为空串", () => {
    const out = toModelConfig({
      name: "local",
      provider: null,
      api_url: "http://127.0.0.1:8080/v1",
      api_key: "",
      model: "qwen",
    });
    expect(out.provider).toBe("");
  });

  it("只保留 5 个发送字段，不把 parameters 等本地配置带出去", () => {
    const out = toModelConfig({
      name: "n",
      provider: "p",
      api_url: "u",
      api_key: "k",
      model: "m",
      parameters: { temperature: 1.2, context_window: 128000 },
    });
    expect(out).toEqual({ name: "n", provider: "p", api_url: "u", api_key: "k", model: "m" });
    expect("parameters" in out).toBe(false);
  });
});
