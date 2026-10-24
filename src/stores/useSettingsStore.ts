import { create } from "zustand";
import type {
  ModelConfig,
  ModelParameters,
  SamplerPreset,
  ModelWrapper,
  ProjectInstruction,
  BudgetConfig,
  ConnectionProfile,
} from "@/types";
import { BUILTIN_REGEX_RULES, type RegexRule } from "@/lib/regex-format";
import {
  sanitizeBudgetConfig,
  sanitizeConnectionProfiles,
  sanitizeRegexRules,
  sanitizeStringArray,
} from "@/lib/persist-sanitize";
import {
  dbSaveModel,
  dbListModelsDecrypted,
  dbDeleteModel,
  dbGetSetting,
  dbSaveSetting,
  logDiag,
} from "@/lib/tauri";

/** 工作区子模式：设置「值」按这两套分开存（数据类内容仍全局共享） */
export type SettingsScope = "chat" | "work";

/** 每个 scope 独立的一份设置值 */
export interface ScopedSettingsValues {
  activeModel: string;
  defaultParameters: ModelParameters;
  budgetConfig: BudgetConfig;
  globalInstruction: string;
  thinkingEnabled: boolean;
  reasoningEffort: "low" | "medium" | "high" | "max";
  stoppingStrings: string[];
}

interface SettingsState {
  appDir: string;
  models: ModelConfig[];
  activeModel: string;
  defaultParameters: ModelParameters;
  loaded: boolean;
  /** 当前编辑/生效的子模式 scope */
  scope: SettingsScope;
  /** 两套独立设置值（顶层字段始终是 scope 对应的一份） */
  scopes: Record<SettingsScope, ScopedSettingsValues>;
  /** 采样器预设(酒馆 API 响应配置存档) */
  samplerPresets: SamplerPreset[];
  /** AI 回复 Regex 后处理规则(内置 + 自定义) */
  regexRules: RegexRule[];
  /** 模型包装器预设(模型+知识库+工具+人设 打包,Open WebUI 式) */
  modelWrappers: ModelWrapper[];
  /** 三层指令作用域:项目级指令(全局 < 项目/知识库 < 会话) */
  projectInstructions: ProjectInstruction[];
  /** 全局自定义指令(作用域最低层) */
  globalInstruction: string;
  /** Token 预算系统配置(监控 + 手动/自动双模式) */
  budgetConfig: BudgetConfig;
  /** 停止字符串(酒馆 Stopping Strings):生成到这些串时提前终止;每行一个 */
  stoppingStrings: string[];
  /** 连接配置档案(酒馆 Connection Profiles):多套 API 连接一键切换 */
  connectionProfiles: ConnectionProfile[];
  /** Reasoning model controls (global): thinking on/off + effort level */
  thinkingEnabled: boolean;
  reasoningEffort: "low" | "medium" | "high" | "max";
  load: () => Promise<void>;
  save: () => Promise<void>;
  /** 切换生效 scope：把顶层字段换成该 scope 的值（不落盘） */
  applyScope: (mode: SettingsScope) => void;
  addModel: (model: ModelConfig) => void;
  updateModel: (name: string, patch: Partial<ModelConfig>) => void;
  removeModel: (name: string) => void;
  setActiveModel: (name: string) => void;
  setDefaultParameters: (params: ModelParameters) => void;
  setThinkingConfig: (enabled: boolean, effort: "low" | "medium" | "high" | "max") => void;
  /** Token 预算:保存配置(自动/手动 + 使用率 + 缺省窗口) */
  setBudgetConfig: (cfg: BudgetConfig) => Promise<void>;
  /** F5 轻量持久化：只写 active_model 单条设置（不重写全部模型） */
  persistActiveModel: (name: string) => void;
  /** F5 轻量持久化：只重写单个模型记录（含其 parameters） */
  persistModel: (name: string) => void;
  /** 采样器预设 CRUD */
  saveSamplerPreset: (p: SamplerPreset) => Promise<void>;
  removeSamplerPreset: (id: string) => Promise<void>;
  /** 采样器应用到当前模型(合并进 model.parameters 并落盘) */
  applySamplerToActive: (s: Omit<SamplerPreset, "id" | "name">) => Promise<void>;
  /** Regex 规则:保存(增改)/删除/切换启用 */
  saveRegexRule: (r: RegexRule) => Promise<void>;
  removeRegexRule: (id: string) => Promise<void>;
  toggleRegexRule: (id: string) => Promise<void>;
  /** 模型包装器:保存/删除/应用(切模型 + 切知识库 + 注入指令) */
  saveModelWrapper: (w: ModelWrapper) => Promise<void>;
  removeModelWrapper: (id: string) => Promise<void>;
  /** 项目级指令:保存/删除 */
  saveProjectInstruction: (p: ProjectInstruction) => Promise<void>;
  removeProjectInstruction: (id: string) => Promise<void>;
  setGlobalInstruction: (s: string) => Promise<void>;
  setStoppingStrings: (ss: string[]) => Promise<void>;
  /** 连接档案:保存当前模型连接为档案 */
  saveConnectionProfile: (p: ConnectionProfile) => Promise<void>;
  /** 连接档案:删除 */
  removeConnectionProfile: (id: string) => Promise<void>;
  /** 连接档案:应用到当前激活模型(覆盖 api_url/api_key/model 并落盘) */
  applyConnectionProfile: (id: string) => Promise<boolean>;
}

const DEFAULT_PARAMS: ModelParameters = { temperature: 0.7, max_tokens: 2048 };

/** Token 预算默认:自动模式 + 90% 使用率 + 缺省 8k 窗口 */
const DEFAULT_BUDGET: BudgetConfig = {
  mode: "auto",
  usage_pct: 90,
  default_context_window: 8192,
};

const BUILTIN_SAMPLERS: SamplerPreset[] = [
  {
    id: "sampler-default-rp",
    name: "RP 默认(酒馆风格)",
    temperature: 0.8,
    top_p: 0.95,
    repetition_penalty: 1.1,
  },
  {
    id: "sampler-local-dry",
    name: "本地后端(DRY+重复抑制)",
    temperature: 0.9,
    dry_multiplier: 0.8,
    dry_base: 1.75,
    dry_allowed_length: 2,
  },
];

function parseParams(raw: string | undefined): ModelParameters {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: ModelParameters = {};
    if (typeof obj.temperature === "number") out.temperature = obj.temperature;
    if (typeof obj.max_tokens === "number") out.max_tokens = obj.max_tokens;
    // Token 预算:模型上下文窗口(缺省保守 8192,可手动覆盖)
    if (typeof obj.context_window === "number") out.context_window = obj.context_window;
    if (typeof obj.top_p === "number") out.top_p = obj.top_p;
    if (typeof obj.top_k === "number") out.top_k = obj.top_k;
    if (typeof obj.repetition_penalty === "number") out.repetition_penalty = obj.repetition_penalty;
    if (typeof obj.frequency_penalty === "number") out.frequency_penalty = obj.frequency_penalty;
    if (typeof obj.presence_penalty === "number") out.presence_penalty = obj.presence_penalty;
    if (typeof obj.min_p === "number") out.min_p = obj.min_p;
    if (typeof obj.mirostat === "number") out.mirostat = obj.mirostat;
    if (typeof obj.mirostat_tau === "number") out.mirostat_tau = obj.mirostat_tau;
    if (typeof obj.mirostat_eta === "number") out.mirostat_eta = obj.mirostat_eta;
    if (typeof obj.dry_multiplier === "number") out.dry_multiplier = obj.dry_multiplier;
    if (typeof obj.dry_base === "number") out.dry_base = obj.dry_base;
    if (typeof obj.dry_allowed_length === "number") out.dry_allowed_length = obj.dry_allowed_length;
    if (typeof obj.dry_penalty_last_n === "number") out.dry_penalty_last_n = obj.dry_penalty_last_n;
    return out;
  } catch {
    return {};
  }
}

/** 工作 scope 沿用历史 key；对话 scope 用 `${key}#chat` —— 旧数据天然继续属于「工作」 */
export function scopedSettingKey(base: string, scope: SettingsScope): string {
  return scope === "chat" ? `${base}#chat` : base;
}

const WORK_SUB_MODE_STORAGE_KEY = "work_sub_mode";

/**
 * 启动时读子模式。直接读 localStorage 而不是 import useAppModeStore：
 * useAppModeStore 不应反向依赖设置 store，避免循环依赖。
 */
function readInitialScope(): SettingsScope {
  try {
    if (
      typeof localStorage !== "undefined" &&
      localStorage.getItem(WORK_SUB_MODE_STORAGE_KEY) === "chat"
    ) {
      return "chat";
    }
  } catch {
    /* ignore */
  }
  return "work";
}

function defaultScopedValues(): ScopedSettingsValues {
  return {
    activeModel: "",
    defaultParameters: { ...DEFAULT_PARAMS },
    budgetConfig: { ...DEFAULT_BUDGET },
    globalInstruction: "",
    thinkingEnabled: true,
    reasoningEffort: "high",
    stoppingStrings: [],
  };
}

/**
 * 读一套 scope 的值。fallback 是「这个 key 缺失时」的取值：
 * 工作 scope 传默认值，对话 scope 传工作 scope 的值（首次继承，不落盘）。
 */
async function readScopedValues(
  scope: SettingsScope,
  fallback: ScopedSettingsValues
): Promise<ScopedSettingsValues> {
  const values: ScopedSettingsValues = {
    activeModel: fallback.activeModel,
    defaultParameters: { ...fallback.defaultParameters },
    budgetConfig: { ...fallback.budgetConfig },
    globalInstruction: fallback.globalInstruction,
    thinkingEnabled: fallback.thinkingEnabled,
    reasoningEffort: fallback.reasoningEffort,
    stoppingStrings: [...fallback.stoppingStrings],
  };
  const read = (base: string) => dbGetSetting(scopedSettingKey(base, scope));

  try {
    const raw = await read("active_model");
    if (raw) values.activeModel = raw;
  } catch {
    /* ignore */
  }
  try {
    const raw = await read("default_parameters");
    if (raw) values.defaultParameters = { ...DEFAULT_PARAMS, ...parseParams(raw) };
  } catch {
    /* ignore */
  }
  try {
    const raw = await read("thinking_config");
    if (raw) {
      const cfg = JSON.parse(raw) as { enabled?: unknown; effort?: unknown };
      if (typeof cfg.enabled === "boolean") values.thinkingEnabled = cfg.enabled;
      // 逐字面量比较而不是 includes()：这样 TS 会把类型收窄，不需要断言
      if (
        cfg.effort === "low" ||
        cfg.effort === "medium" ||
        cfg.effort === "high" ||
        cfg.effort === "max"
      ) {
        values.reasoningEffort = cfg.effort;
      }
    }
  } catch {
    /* ignore bad JSON */
  }
  try {
    const raw = await read("global_instruction");
    if (raw) values.globalInstruction = raw;
  } catch {
    /* ignore */
  }
  try {
    const raw = await read("budget_config");
    if (raw) values.budgetConfig = sanitizeBudgetConfig(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  try {
    const raw = await read("stopping_strings");
    if (raw) values.stoppingStrings = sanitizeStringArray(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return values;
}

/** 把补丁写进当前 scope；调用处仍需同步顶层字段（顶层 = 当前 scope 的镜像） */
function patchScope(
  state: SettingsState,
  patch: Partial<ScopedSettingsValues>
): Record<SettingsScope, ScopedSettingsValues> {
  return {
    ...state.scopes,
    [state.scope]: { ...state.scopes[state.scope], ...patch },
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  appDir: "",
  models: [],
  activeModel: "",
  defaultParameters: { ...DEFAULT_PARAMS },
  scope: readInitialScope(),
  scopes: {
    work: defaultScopedValues(),
    chat: defaultScopedValues(),
  },
  samplerPresets: [...BUILTIN_SAMPLERS],
  regexRules: [...BUILTIN_REGEX_RULES],
  modelWrappers: [],
  projectInstructions: [],
  globalInstruction: "",
  budgetConfig: { ...DEFAULT_BUDGET },
  stoppingStrings: [],
  connectionProfiles: [],
  loaded: false,
  thinkingEnabled: true,
  reasoningEffort: "high",

  load: async () => {
    try {
      // list_models_decrypted returns API keys already decrypted by Rust (DPAPI)
      const models = await dbListModelsDecrypted();
      // 两套 scope 的值：工作沿用历史 key，对话用 `${key}#chat`。
      // 对话首次没有自己的值时继承工作值 —— 只在内存里继承，不落盘。
      const workValues = await readScopedValues("work", defaultScopedValues());
      const chatValues = await readScopedValues("chat", workValues);
      // Load sampler presets (酒馆 API 响应配置存档)
      let samplerPresets: SamplerPreset[] = [...BUILTIN_SAMPLERS];
      try {
        const raw = await dbGetSetting("sampler_presets");
        if (raw) samplerPresets = [...BUILTIN_SAMPLERS, ...(JSON.parse(raw) as SamplerPreset[])];
      } catch {
        /* ignore */
      }
      // Load regex rules (AI 回复后处理;内置 + 自定义)
      let regexRules: RegexRule[] = [...BUILTIN_REGEX_RULES];
      try {
        const raw = await dbGetSetting("regex_rules");
        // 坏 placement（如 "2"）曾一路带到渲染层 → TypeError 白屏；这里先收敛成合法结构
        if (raw) regexRules = sanitizeRegexRules(JSON.parse(raw));
      } catch {
        /* ignore */
      }
      // Load model wrappers (模型包装器:模型+知识库+工具+人设)
      let modelWrappers: ModelWrapper[] = [];
      try {
        const raw = await dbGetSetting("model_wrappers");
        if (raw) modelWrappers = JSON.parse(raw) as ModelWrapper[];
      } catch {
        /* ignore */
      }
      // Load project instructions (三层指令作用域:项目级)
      let projectInstructions: ProjectInstruction[] = [];
      try {
        const raw = await dbGetSetting("project_instructions");
        if (raw) projectInstructions = JSON.parse(raw) as ProjectInstruction[];
      } catch {
        /* ignore */
      }
      // Load connection profiles (酒馆 Connection Profiles)
      let connectionProfiles: ConnectionProfile[] = [];
      try {
        const raw = await dbGetSetting("connection_profiles");
        if (raw) connectionProfiles = sanitizeConnectionProfiles(JSON.parse(raw));
      } catch {
        /* ignore */
      }
      // Defensive filter: drop records with a non-URL api_url (corrupted data)
      // F2: per-model parameters come from the persisted params_json record.
      const validModels = models
        .filter((m) => /^https?:\/\//i.test(String(m.api_url || "").trim()))
        .map((m) => ({
          name: m.name,
          provider: m.provider,
          api_url: m.api_url,
          api_key: m.api_key_encrypted || "",
          model: m.model,
          parameters: parseParams(m.params_json),
        }));
      // Remap active_model if it pointed at a dropped record ("DeepSeek " → "DeepSeek")
      // 两套 scope 各自修复，避免对话 scope 的历史值在切换后指向不存在的模型。
      const remapActive = (name: string): string => {
        if (!name) return "";
        if (validModels.some((m) => m.name === name)) return name;
        const trimmed = name.trim();
        const match = validModels.find((m) => m.name === trimmed);
        return match ? match.name : "";
      };
      const scopes: Record<SettingsScope, ScopedSettingsValues> = {
        work: { ...workValues, activeModel: remapActive(workValues.activeModel) },
        chat: { ...chatValues, activeModel: remapActive(chatValues.activeModel) },
      };
      // 顶层字段始终呈现当前 scope（启动时按 localStorage 的 work_sub_mode 决定）
      const current = scopes[get().scope];
      set({
        models: validModels,
        scopes,
        activeModel: current.activeModel,
        defaultParameters: current.defaultParameters,
        samplerPresets,
        regexRules,
        modelWrappers,
        projectInstructions,
        globalInstruction: current.globalInstruction,
        budgetConfig: current.budgetConfig,
        stoppingStrings: current.stoppingStrings,
        connectionProfiles,
        loaded: true,
        thinkingEnabled: current.thinkingEnabled,
        reasoningEffort: current.reasoningEffort,
      });
    } catch {
      set({ loaded: true });
    }
  },

  save: async () => {
    const { models, activeModel, defaultParameters, scope, thinkingEnabled, reasoningEffort } =
      get();
    // Upsert per model — save_model overwrites by name, so a mid-loop failure
    // (network, disk) no longer wipes every model the way delete-all + rewrite did.
    for (const m of models) {
      await dbSaveModel({
        name: m.name,
        provider: m.provider || "",
        api_url: m.api_url,
        api_key_encrypted: m.api_key,
        model: m.model,
        params_json: JSON.stringify(m.parameters || defaultParameters),
      });
    }
    // 只写当前 scope 的三个 key（预算/全局指令/停止串由各自 setter 即时落盘）
    await dbSaveSetting(scopedSettingKey("active_model", scope), activeModel);
    await dbSaveSetting(
      scopedSettingKey("default_parameters", scope),
      JSON.stringify(defaultParameters)
    );
    await dbSaveSetting(
      scopedSettingKey("thinking_config", scope),
      JSON.stringify({ enabled: thinkingEnabled, effort: reasoningEffort })
    );
  },

  applyScope: (mode) =>
    set((s) => ({
      scope: mode,
      ...s.scopes[mode],
    })),

  addModel: (model) => set((s) => ({ models: [...s.models, model] })),
  updateModel: (name, patch) =>
    set((s) => ({
      models: s.models.map((m) => (m.name === name ? { ...m, ...patch } : m)),
    })),
  removeModel: (name) => {
    // Persist the deletion explicitly — save() now upserts (no more
    // delete-all + rewrite), so a locally-removed model would otherwise
    // come back on the next save/restart.
    dbDeleteModel(name).catch((e: unknown) => {
      // 落库失败会让这个模型在下次 save / restart 时「复活」—— 必须留痕
      logDiag(`dbDeleteModel failed: ${String(e)} name=${name}`);
    });
    set((s) => {
      const activeModel = s.activeModel === name ? "" : s.activeModel;
      return {
        models: s.models.filter((m) => m.name !== name),
        activeModel,
        scopes: patchScope(s, { activeModel }),
      };
    });
  },
  setActiveModel: (name) =>
    set((s) => ({
      activeModel: name,
      scopes: patchScope(s, { activeModel: name }),
    })),
  setDefaultParameters: (params) =>
    set((s) => ({
      defaultParameters: params,
      scopes: patchScope(s, { defaultParameters: params }),
    })),
  setThinkingConfig: (enabled, effort) =>
    set((s) => ({
      thinkingEnabled: enabled,
      reasoningEffort: effort,
      scopes: patchScope(s, { thinkingEnabled: enabled, reasoningEffort: effort }),
    })),

  persistActiveModel: (name) => {
    const scope = get().scope;
    set((s) => ({
      activeModel: name,
      scopes: patchScope(s, { activeModel: name }),
    }));
    dbSaveSetting(scopedSettingKey("active_model", scope), name).catch((e: unknown) => {
      logDiag(`persistActiveModel failed: ${String(e)} name=${name} scope=${scope}`);
    });
  },

  persistModel: (name) => {
    const m = get().models.find((x) => x.name === name);
    if (!m) return;
    dbSaveModel({
      name: m.name,
      provider: m.provider || "",
      api_url: m.api_url,
      api_key_encrypted: m.api_key,
      model: m.model,
      params_json: JSON.stringify(m.parameters || get().defaultParameters),
    }).catch((e: unknown) => {
      // 保存模型失败 = 用户以为存了其实没存，最该留痕的一类
      logDiag(`dbSaveModel failed: ${String(e)} name=${name}`);
    });
  },

  saveSamplerPreset: async (p) => {
    const presets = get().samplerPresets.filter((x) => x.id !== p.id);
    presets.push(p);
    set({ samplerPresets: presets });
    await dbSaveSetting(
      "sampler_presets",
      JSON.stringify(presets.filter((x) => !x.id.startsWith("sampler-")))
    );
  },

  removeSamplerPreset: async (id) => {
    const presets = get().samplerPresets.filter((x) => x.id !== id);
    set({ samplerPresets: presets });
    await dbSaveSetting(
      "sampler_presets",
      JSON.stringify(presets.filter((x) => !x.id.startsWith("sampler-")))
    );
  },

  applySamplerToActive: async (s) => {
    const name = get().activeModel;
    if (!name) return;
    const m = get().models.find((x) => x.name === name);
    if (!m) return;
    const params: ModelParameters = { ...(m.parameters || {}), ...s };
    get().updateModel(name, { parameters: params });
    get().persistModel(name);
  },

  saveRegexRule: async (r) => {
    const rules = get().regexRules.some((x) => x.id === r.id)
      ? get().regexRules.map((x) => (x.id === r.id ? r : x))
      : [...get().regexRules, r];
    set({ regexRules: rules });
    await dbSaveSetting("regex_rules", JSON.stringify(rules));
  },

  removeRegexRule: async (id) => {
    const rules = get().regexRules.filter((x) => x.id !== id);
    set({ regexRules: rules });
    await dbSaveSetting("regex_rules", JSON.stringify(rules));
  },

  toggleRegexRule: async (id) => {
    const rules = get().regexRules.map((x) => (x.id === id ? { ...x, enabled: !x.enabled } : x));
    set({ regexRules: rules });
    await dbSaveSetting("regex_rules", JSON.stringify(rules));
  },

  saveModelWrapper: async (w) => {
    const list = get().modelWrappers.filter((x) => x.id !== w.id);
    list.push(w);
    set({ modelWrappers: list });
    await dbSaveSetting("model_wrappers", JSON.stringify(list));
  },

  removeModelWrapper: async (id) => {
    const list = get().modelWrappers.filter((x) => x.id !== id);
    set({ modelWrappers: list });
    await dbSaveSetting("model_wrappers", JSON.stringify(list));
  },

  saveProjectInstruction: async (p) => {
    const list = get().projectInstructions.filter((x) => x.id !== p.id);
    list.push(p);
    set({ projectInstructions: list });
    await dbSaveSetting("project_instructions", JSON.stringify(list));
  },

  removeProjectInstruction: async (id) => {
    const list = get().projectInstructions.filter((x) => x.id !== id);
    set({ projectInstructions: list });
    await dbSaveSetting("project_instructions", JSON.stringify(list));
  },

  setGlobalInstruction: async (s) => {
    const scope = get().scope;
    set((st) => ({
      globalInstruction: s,
      scopes: patchScope(st, { globalInstruction: s }),
    }));
    await dbSaveSetting(scopedSettingKey("global_instruction", scope), s);
  },

  setStoppingStrings: async (ss) => {
    const scope = get().scope;
    set((st) => ({
      stoppingStrings: ss,
      scopes: patchScope(st, { stoppingStrings: ss }),
    }));
    await dbSaveSetting(scopedSettingKey("stopping_strings", scope), JSON.stringify(ss));
  },

  saveConnectionProfile: async (p) => {
    const list = get().connectionProfiles.filter((x) => x.id !== p.id);
    list.push(p);
    set({ connectionProfiles: list });
    await dbSaveSetting("connection_profiles", JSON.stringify(list));
  },

  removeConnectionProfile: async (id) => {
    const list = get().connectionProfiles.filter((x) => x.id !== id);
    set({ connectionProfiles: list });
    await dbSaveSetting("connection_profiles", JSON.stringify(list));
  },

  applyConnectionProfile: async (id) => {
    const p = get().connectionProfiles.find((x) => x.id === id);
    if (!p) return false;
    const name = get().activeModel;
    if (!name) return false;
    // 覆盖当前激活模型的连接信息并落盘(api_key 走 save_model 加密)
    get().updateModel(name, { api_url: p.api_url, api_key: p.api_key, model: p.model });
    await get().persistModel(name);
    return true;
  },

  setBudgetConfig: async (cfg) => {
    const scope = get().scope;
    set((st) => ({
      budgetConfig: cfg,
      scopes: patchScope(st, { budgetConfig: cfg }),
    }));
    await dbSaveSetting(scopedSettingKey("budget_config", scope), JSON.stringify(cfg));
  },
}));
