// @vitest-environment jsdom
//
// T-028 — 新增模型不得把「当前 scope」的默认采样参数烧进 params_json。
//
// 复现路径（FE-US 审查报告）：
//   ModelWizard 走 addModel({name,...}) —— 不带 parameters；
//   useSettingsStore.save() 原先写 JSON.stringify(m.parameters || defaultParameters)，
//   defaultParameters 是**当前 scope** 的镜像。于是在「对话」里新增模型，
//   params_json 落成对话的 0.95/950；重启后该模型带显式 parameters，
//   在「工作」里也优先用它（useChatStore.ts:282 先取 model.parameters），
//   与 scope 隔离承诺矛盾。
//
// 契约：
//   1. 无 per-model 参数 → params_json === "{}"（不是当前 scope 默认值）；
//   2. 有 per-model 参数 → 原样落盘（修复不能顺手抹掉显式覆盖）。

import { describe, it, expect, vi, beforeEach } from "vitest";

const mock = vi.hoisted(() => ({
  saveModel: vi.fn(async (_model: Record<string, unknown>) => undefined),
  saveSetting: vi.fn(async (_key: string, _value: string) => undefined),
  getSetting: vi.fn(async (_key: string) => ""),
  listModels: vi.fn(async (): Promise<Array<Record<string, string>>> => []),
  deleteModel: vi.fn(async (_name: string) => undefined),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    dbSaveModel: mock.saveModel,
    dbSaveSetting: mock.saveSetting,
    dbGetSetting: mock.getSetting,
    dbListModelsDecrypted: mock.listModels,
    dbDeleteModel: mock.deleteModel,
    logDiag: vi.fn(),
  };
});

import { useSettingsStore } from "./useSettingsStore";

/** 对话 scope 的采样参数（故意与工作不同，方便断言「没被烧入」） */
const CHAT_PARAMS = { temperature: 0.95, max_tokens: 950 };

function resetStore() {
  useSettingsStore.setState({
    models: [],
    activeModel: "",
    defaultParameters: { ...CHAT_PARAMS },
    scope: "chat",
    scopes: {
      work: {
        activeModel: "",
        defaultParameters: { temperature: 0.2, max_tokens: 500 },
        budgetConfig: { mode: "auto", usage_pct: 90, default_context_window: 8192 },
        globalInstruction: "",
        thinkingEnabled: true,
        reasoningEffort: "high",
        stoppingStrings: [],
      },
      chat: {
        activeModel: "",
        defaultParameters: { ...CHAT_PARAMS },
        budgetConfig: { mode: "auto", usage_pct: 90, default_context_window: 8192 },
        globalInstruction: "",
        thinkingEnabled: true,
        reasoningEffort: "high",
        stoppingStrings: [],
      },
    },
    loaded: false,
  });
}

/** 取 save_model 收到的 params_json 并解析 */
function savedParams(): unknown {
  const call = mock.saveModel.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (!call) throw new Error("dbSaveModel 未被调用");
  return JSON.parse(String(call.params_json));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("T-028 save() 不把当前 scope 默认值烧进模型", () => {
  it("在「对话」新增模型（无自定义参数）→ params_json 为 {}，不是对话的 0.95/950", async () => {
    // 与 ModelWizard.save() 完全一致的调用形态：addModel 不带 parameters
    useSettingsStore.getState().addModel({
      name: "新增模型",
      provider: "openai",
      api_url: "https://example.invalid/v1",
      api_key: "k",
      model: "m",
    });

    await useSettingsStore.getState().save();

    expect(mock.saveModel).toHaveBeenCalledTimes(1);
    expect(savedParams()).toEqual({});
  });

  it("已有 per-model 参数 → 原样落盘（不被空对象覆盖）", async () => {
    useSettingsStore.getState().addModel({
      name: "带参数模型",
      provider: "openai",
      api_url: "https://example.invalid/v1",
      api_key: "k",
      model: "m",
      parameters: { temperature: 0.3, max_tokens: 123 },
    });

    await useSettingsStore.getState().save();

    expect(savedParams()).toEqual({ temperature: 0.3, max_tokens: 123 });
  });
});

// T-040：persistModel 是第二条模型保存路径（改连接档案 / 应用采样器走它），
// 旧写法 `m.parameters || get().defaultParameters` 与 T-028 同型 —— 无参数模型
// 会把当前 scope 的默认值烧进 params_json，重启后跨 scope 生效。
describe("T-040 persistModel 不把当前 scope 默认值烧进模型", () => {
  it("无 per-model 参数 → params_json 为 {}（不是当前 scope 的 0.95/950）", () => {
    useSettingsStore.getState().addModel({
      name: "persist 模型",
      provider: "openai",
      api_url: "https://example.invalid/v1",
      api_key: "k",
      model: "m",
    });

    useSettingsStore.getState().persistModel("persist 模型");

    expect(mock.saveModel).toHaveBeenCalledTimes(1);
    expect(savedParams()).toEqual({});
  });

  it("有 per-model 参数 → 原样落盘", () => {
    useSettingsStore.getState().addModel({
      name: "persist 带参数",
      provider: "openai",
      api_url: "https://example.invalid/v1",
      api_key: "k",
      model: "m",
      parameters: { temperature: 0.3 },
    });

    useSettingsStore.getState().persistModel("persist 带参数");

    expect(savedParams()).toEqual({ temperature: 0.3 });
  });
});

// T-112 — 坏 context_window（0/负数/过小）不得进入 store；
// 否则 budgetFor 算出 0/极小预算，auto 模式把任意会话判超限。
describe("T-112 load() 收敛坏 context_window", () => {
  const dto = (name: string, params_json: string) => ({
    name,
    provider: "openai",
    api_url: "https://example.invalid/v1",
    api_key_encrypted: "k",
    model: name,
    params_json,
  });

  it("0/负数 → 丢弃(回退默认)；正数过小 → 抬到 1024；正常值原样", async () => {
    mock.listModels.mockResolvedValue([
      dto("zero", '{"context_window":0}'),
      dto("negative", '{"context_window":-5}'),
      dto("tiny", '{"context_window":400}'),
      dto("normal", '{"context_window":128000}'),
    ]);

    await useSettingsStore.getState().load();

    const byName = (n: string) => useSettingsStore.getState().models.find((m) => m.name === n);
    expect(byName("zero")?.parameters?.context_window).toBeUndefined();
    expect(byName("negative")?.parameters?.context_window).toBeUndefined();
    expect(byName("tiny")?.parameters?.context_window).toBe(1024);
    expect(byName("normal")?.parameters?.context_window).toBe(128000);
  });
});
