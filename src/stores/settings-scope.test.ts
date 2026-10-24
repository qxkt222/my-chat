// @vitest-environment jsdom
//
// settings-scope.test.ts — 「对话 / 工作」两套设置值互相独立
//
// 契约（用户拍板，2026-10-23）：
//   1. 工作子模式（useAppModeStore.workSubMode = "chat" | "work"）各自记住
//      activeModel / 采样参数 / 预算 / 全局指令 / 思考开关 / 停止串；
//   2. 旧数据（无后缀 key）继续作为「工作」的值；
//   3. 「对话」首次没有自己的值时继承一份工作值；继承只发生在内存里，不落盘；
//   4. 之后各自写各自的 key（对话 = `${key}#chat`），互不影响；
//   5. applyScope(mode) 切换后顶层字段跟着换成该 scope 的值；
//   6. 启动时按 localStorage 的 work_sub_mode 应用 scope。
//
// 数据类内容（模型列表 / 技能 / 正则 / 连接档案 / 采样器预设 / 项目指令）
// 仍全局共享，不在本文件断言范围内。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** 可控的 sled 设置表：get 缺失返回 ""（与 Rust get_setting 一致） */
const mock = vi.hoisted(() => {
  const settings = new Map<string, string>();
  return {
    settings,
    getSetting: vi.fn(async (key: string) => settings.get(key) ?? ""),
    saveSetting: vi.fn(async (key: string, value: string) => {
      settings.set(key, value);
    }),
    listModels: vi.fn(async (): Promise<Array<Record<string, string>>> => []),
    saveModel: vi.fn(async () => undefined),
    deleteModel: vi.fn(async () => undefined),
  };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    dbGetSetting: mock.getSetting,
    dbSaveSetting: mock.saveSetting,
    dbListModelsDecrypted: mock.listModels,
    dbSaveModel: mock.saveModel,
    dbDeleteModel: mock.deleteModel,
    logDiag: vi.fn(),
  };
});

import { useSettingsStore } from "./useSettingsStore";

const WORK = {
  active_model: "work-model",
  default_parameters: JSON.stringify({ temperature: 0.2, max_tokens: 500 }),
  budget_config: JSON.stringify({ mode: "manual", usage_pct: 50, default_context_window: 4096 }),
  global_instruction: "WORK INSTR",
  thinking_config: JSON.stringify({ enabled: false, effort: "low" }),
  stopping_strings: JSON.stringify(["STOP-WORK"]),
};

const CHAT = {
  "active_model#chat": "chat-model",
  "default_parameters#chat": JSON.stringify({ temperature: 0.95, max_tokens: 1234 }),
  "budget_config#chat": JSON.stringify({
    mode: "manual",
    usage_pct: 20,
    default_context_window: 2048,
  }),
  "global_instruction#chat": "CHAT INSTR",
  "thinking_config#chat": JSON.stringify({ enabled: true, effort: "max" }),
  "stopping_strings#chat": JSON.stringify(["STOP-CHAT"]),
};

function seed(entries: Record<string, string>) {
  for (const [k, v] of Object.entries(entries)) mock.settings.set(k, v);
}

/** 读取落盘的 JSON 设置（避免 JSON.parse(...).field 上的 any 访问告警） */
function parsedSetting(key: string): Record<string, unknown> {
  return JSON.parse(mock.settings.get(key) as string) as Record<string, unknown>;
}

/** 把 store 恢复到干净初始态（模块级初始 scope 由 localStorage 决定，这里显式钉住） */
function resetStore() {
  useSettingsStore.setState({
    models: [],
    activeModel: "",
    defaultParameters: { temperature: 0.7, max_tokens: 2048 },
    budgetConfig: { mode: "auto", usage_pct: 90, default_context_window: 8192 },
    globalInstruction: "",
    stoppingStrings: [],
    thinkingEnabled: true,
    reasoningEffort: "high",
    loaded: false,
    scope: "work",
    scopes: {
      work: {
        activeModel: "",
        defaultParameters: { temperature: 0.7, max_tokens: 2048 },
        budgetConfig: { mode: "auto", usage_pct: 90, default_context_window: 8192 },
        globalInstruction: "",
        thinkingEnabled: true,
        reasoningEffort: "high",
        stoppingStrings: [],
      },
      chat: {
        activeModel: "",
        defaultParameters: { temperature: 0.7, max_tokens: 2048 },
        budgetConfig: { mode: "auto", usage_pct: 90, default_context_window: 8192 },
        globalInstruction: "",
        thinkingEnabled: true,
        reasoningEffort: "high",
        stoppingStrings: [],
      },
    },
  });
}

function modelDto(name: string) {
  return {
    name,
    provider: "openai",
    api_url: "http://127.0.0.1:1",
    api_key_encrypted: "k",
    model: name,
    params_json: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.settings.clear();
  mock.listModels.mockResolvedValue([
    modelDto("work-model"),
    modelDto("chat-model"),
    modelDto("chat-2"),
  ]);
  localStorage.clear();
  resetStore();
});

afterEach(() => {
  localStorage.clear();
});

describe("旧的单 key 数据仍然作为「工作」的值", () => {
  it("load() 读出工作 scope，并让对话 scope 在内存里继承一份（不落盘）", async () => {
    seed(WORK);
    await useSettingsStore.getState().load();
    const st = useSettingsStore.getState();

    expect(st.scope).toBe("work");
    expect(st.activeModel).toBe("work-model");
    expect(st.defaultParameters.temperature).toBe(0.2);
    expect(st.defaultParameters.max_tokens).toBe(500);
    expect(st.budgetConfig.mode).toBe("manual");
    expect(st.budgetConfig.usage_pct).toBe(50);
    expect(st.globalInstruction).toBe("WORK INSTR");
    expect(st.thinkingEnabled).toBe(false);
    expect(st.reasoningEffort).toBe("low");
    expect(st.stoppingStrings).toEqual(["STOP-WORK"]);

    // 对话 scope 首份值 = 工作值
    expect(st.scopes.chat).toEqual(st.scopes.work);
    // 继承只发生在内存：load 不写任何设置
    expect(mock.saveSetting).not.toHaveBeenCalled();
  });
});

describe("两套 scope 独立读写", () => {
  it("applyScope('chat') 后顶层字段换成对话值，写入也只落在 #chat key", async () => {
    seed(WORK);
    seed(CHAT);
    await useSettingsStore.getState().load();
    const st = useSettingsStore.getState();

    st.applyScope("chat");
    const chat = useSettingsStore.getState();
    expect(chat.scope).toBe("chat");
    expect(chat.activeModel).toBe("chat-model");
    expect(chat.defaultParameters.temperature).toBe(0.95);
    expect(chat.budgetConfig.usage_pct).toBe(20);
    expect(chat.globalInstruction).toBe("CHAT INSTR");
    expect(chat.thinkingEnabled).toBe(true);
    expect(chat.reasoningEffort).toBe("max");
    expect(chat.stoppingStrings).toEqual(["STOP-CHAT"]);

    // 在对话 scope 里改值
    useSettingsStore.getState().setActiveModel("chat-2");
    useSettingsStore.getState().setDefaultParameters({ temperature: 0.3, max_tokens: 64 });
    useSettingsStore.getState().setThinkingConfig(false, "medium");
    useSettingsStore.getState().persistActiveModel("chat-2");
    await useSettingsStore.getState().setBudgetConfig({
      mode: "auto",
      usage_pct: 10,
      default_context_window: 1024,
    });
    await useSettingsStore.getState().setGlobalInstruction("CHAT-2 INSTR");
    await useSettingsStore.getState().setStoppingStrings(["CHAT-2-STOP"]);
    await useSettingsStore.getState().save();

    // 对话 key 被更新
    expect(mock.settings.get("active_model#chat")).toBe("chat-2");
    expect(parsedSetting("default_parameters#chat").temperature).toBe(0.3);
    expect(parsedSetting("thinking_config#chat")).toEqual({
      enabled: false,
      effort: "medium",
    });
    expect(parsedSetting("budget_config#chat").usage_pct).toBe(10);
    expect(mock.settings.get("global_instruction#chat")).toBe("CHAT-2 INSTR");
    expect(mock.settings.get("stopping_strings#chat")).toBe(JSON.stringify(["CHAT-2-STOP"]));

    // 工作 key 原样不动
    expect(mock.settings.get("active_model")).toBe("work-model");
    expect(parsedSetting("default_parameters").temperature).toBe(0.2);
    expect(parsedSetting("thinking_config").enabled).toBe(false);
    expect(mock.settings.get("global_instruction")).toBe("WORK INSTR");
    expect(mock.settings.get("stopping_strings")).toBe(JSON.stringify(["STOP-WORK"]));

    // 工作 scope 内存值也没被串改
    expect(useSettingsStore.getState().scopes.work.activeModel).toBe("work-model");
  });
});

describe("applyScope 交换顶层字段", () => {
  it("工作 → 对话 → 工作 往返后各自保留自己的修改", async () => {
    seed(WORK);
    await useSettingsStore.getState().load();

    // 对话首份继承工作值
    useSettingsStore.getState().applyScope("chat");
    expect(useSettingsStore.getState().activeModel).toBe("work-model");

    // 只改对话
    useSettingsStore.getState().setActiveModel("chat-only");
    useSettingsStore.getState().setDefaultParameters({ temperature: 0.11, max_tokens: 111 });
    useSettingsStore.getState().setThinkingConfig(false, "low");

    // 回工作：工作值不受影响
    useSettingsStore.getState().applyScope("work");
    expect(useSettingsStore.getState().scope).toBe("work");
    expect(useSettingsStore.getState().activeModel).toBe("work-model");
    expect(useSettingsStore.getState().defaultParameters.temperature).toBe(0.2);
    expect(useSettingsStore.getState().thinkingEnabled).toBe(false);
    expect(useSettingsStore.getState().reasoningEffort).toBe("low");

    // 再回对话：对话的修改还在
    useSettingsStore.getState().applyScope("chat");
    expect(useSettingsStore.getState().activeModel).toBe("chat-only");
    expect(useSettingsStore.getState().defaultParameters.temperature).toBe(0.11);
    expect(useSettingsStore.getState().defaultParameters.max_tokens).toBe(111);
  });
});

describe("启动时按 localStorage 的 work_sub_mode 应用 scope", () => {
  it("work_sub_mode=chat 时 load() 直接呈现对话 values", async () => {
    localStorage.setItem("work_sub_mode", "chat");
    seed(WORK);
    seed(CHAT);

    // 重新求值模块，让初始化读到此时 localStorage 里的子模式
    vi.resetModules();
    const fresh = await import("./useSettingsStore");
    await fresh.useSettingsStore.getState().load();

    const st = fresh.useSettingsStore.getState();
    expect(st.scope).toBe("chat");
    expect(st.activeModel).toBe("chat-model");
    expect(st.globalInstruction).toBe("CHAT INSTR");
  });

  it("work_sub_mode 缺失/非法时默认工作 scope", async () => {
    localStorage.setItem("work_sub_mode", "nonsense");
    seed(WORK);

    vi.resetModules();
    const fresh = await import("./useSettingsStore");
    await fresh.useSettingsStore.getState().load();

    expect(fresh.useSettingsStore.getState().scope).toBe("work");
    expect(fresh.useSettingsStore.getState().activeModel).toBe("work-model");
  });
});
