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
  dbSaveModel,
  dbListModelsDecrypted,
  dbDeleteModel,
  dbGetSetting,
  dbSaveSetting,
} from "@/lib/tauri";

interface SettingsState {
  appDir: string;
  models: ModelConfig[];
  activeModel: string;
  defaultParameters: ModelParameters;
  loaded: boolean;
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

export const useSettingsStore = create<SettingsState>((set, get) => ({
  appDir: "",
  models: [],
  activeModel: "",
  defaultParameters: { ...DEFAULT_PARAMS },
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
      const activeModel = await dbGetSetting("active_model");
      // Load persisted default parameters (temperature / max_tokens)
      let defaultParameters: ModelParameters = { ...DEFAULT_PARAMS };
      const paramsRaw = await dbGetSetting("default_parameters");
      if (paramsRaw) {
        try {
          defaultParameters = { ...defaultParameters, ...JSON.parse(paramsRaw) };
        } catch {
          /* ignore bad JSON */
        }
      }
      // Load thinking config (default: thinking on, effort high)
      let thinkingEnabled = true;
      let reasoningEffort: "low" | "medium" | "high" | "max" = "high";
      const thinkingRaw = await dbGetSetting("thinking_config");
      if (thinkingRaw) {
        try {
          const cfg = JSON.parse(thinkingRaw);
          if (typeof cfg.enabled === "boolean") thinkingEnabled = cfg.enabled;
          if (["low", "medium", "high", "max"].includes(cfg.effort)) reasoningEffort = cfg.effort;
        } catch {
          /* ignore bad JSON */
        }
      }
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
        if (raw) regexRules = [...(JSON.parse(raw) as RegexRule[])];
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
      // Load global instruction (作用域最低层)
      let globalInstruction = "";
      try {
        globalInstruction = (await dbGetSetting("global_instruction")) || "";
      } catch {
        /* ignore */
      }
      // Load budget config (Token 预算:监控 + 手动/自动双模式)
      let budgetConfig: BudgetConfig = { ...DEFAULT_BUDGET };
      try {
        const raw = await dbGetSetting("budget_config");
        if (raw) budgetConfig = { ...DEFAULT_BUDGET, ...(JSON.parse(raw) as BudgetConfig) };
      } catch {
        /* ignore */
      }
      // Load stopping strings (酒馆 Stopping Strings)
      let stoppingStrings: string[] = [];
      try {
        const raw = await dbGetSetting("stopping_strings");
        if (raw) stoppingStrings = JSON.parse(raw) as string[];
      } catch {
        /* ignore */
      }
      // Load connection profiles (酒馆 Connection Profiles)
      let connectionProfiles: ConnectionProfile[] = [];
      try {
        const raw = await dbGetSetting("connection_profiles");
        if (raw) connectionProfiles = JSON.parse(raw) as ConnectionProfile[];
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
      let effectiveActive = activeModel || "";
      if (effectiveActive && !validModels.some((m) => m.name === effectiveActive)) {
        const trimmed = effectiveActive.trim();
        const match = validModels.find((m) => m.name === trimmed);
        effectiveActive = match ? match.name : "";
      }
      set({
        models: validModels,
        activeModel: effectiveActive,
        defaultParameters,
        samplerPresets,
        regexRules,
        modelWrappers,
        projectInstructions,
        globalInstruction,
        budgetConfig,
        stoppingStrings,
        connectionProfiles,
        loaded: true,
        thinkingEnabled,
        reasoningEffort,
      });
    } catch {
      set({ loaded: true });
    }
  },

  save: async () => {
    const { models, activeModel, defaultParameters } = get();
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
    await dbSaveSetting("active_model", activeModel);
    await dbSaveSetting("default_parameters", JSON.stringify(defaultParameters));
    await dbSaveSetting(
      "thinking_config",
      JSON.stringify({
        enabled: get().thinkingEnabled,
        effort: get().reasoningEffort,
      })
    );
  },

  addModel: (model) => set((s) => ({ models: [...s.models, model] })),
  updateModel: (name, patch) =>
    set((s) => ({
      models: s.models.map((m) => (m.name === name ? { ...m, ...patch } : m)),
    })),
  removeModel: (name) => {
    // Persist the deletion explicitly — save() now upserts (no more
    // delete-all + rewrite), so a locally-removed model would otherwise
    // come back on the next save/restart.
    dbDeleteModel(name).catch(() => {});
    set((s) => ({
      models: s.models.filter((m) => m.name !== name),
      activeModel: s.activeModel === name ? "" : s.activeModel,
    }));
  },
  setActiveModel: (name) => set({ activeModel: name }),
  setDefaultParameters: (params) => set({ defaultParameters: params }),
  setThinkingConfig: (enabled, effort) =>
    set({ thinkingEnabled: enabled, reasoningEffort: effort }),

  persistActiveModel: (name) => {
    set({ activeModel: name });
    dbSaveSetting("active_model", name).catch(() => {});
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
    }).catch(() => {});
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
    set({ globalInstruction: s });
    await dbSaveSetting("global_instruction", s);
  },

  setStoppingStrings: async (ss) => {
    set({ stoppingStrings: ss });
    await dbSaveSetting("stopping_strings", JSON.stringify(ss));
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
    set({ budgetConfig: cfg });
    await dbSaveSetting("budget_config", JSON.stringify(cfg));
  },
}));
