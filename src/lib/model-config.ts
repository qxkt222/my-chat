// lib/model-config.ts — 发送给 Rust 的 model_config 唯一构造点
//
// 这条 5 字段字面量原来在工作模式 / 酒馆 / 推演三个 store 里被抄了 12 次
// （发送、摘要、回锚、状态同步、滑卡、续写、群聊……）。漏掉 provider 的
// 那次抄写会让 Rust 端适配器选择退化到默认分支，而且不会有任何报错。
//
// 只负责「发送形状」：parameters 等纯前端配置不进入请求（历史行为）。

import type { ModelConfig } from "@/types";

/** 允许来源模型缺少 provider（旧数据/本地模型），其余字段必填。
 *  parameters 等前端本地配置可以存在，但不会进入发送请求。 */
export type ModelConfigSource = Pick<ModelConfig, "name" | "api_url" | "api_key" | "model"> & {
  provider?: string | null | undefined;
  parameters?: ModelConfig["parameters"];
};

/** 构造 ChatRequest.model_config：provider 缺省/空 → 空串（Rust 端据此走默认适配器） */
export function toModelConfig(model: ModelConfigSource): ModelConfig {
  return {
    name: model.name,
    provider: model.provider || "",
    api_url: model.api_url,
    api_key: model.api_key,
    model: model.model,
  };
}
