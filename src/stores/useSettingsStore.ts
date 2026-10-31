import { create } from "zustand";
import type {
  DrawEngine,
  ModelConfig,
  ModelParameters,
  SamplerPreset,
  ModelWrapper,
  ProjectInstruction,
  BudgetConfig,
  ConnectionProfile,
} from "@/types";
import { BUILTIN_REGEX_RULES, type RegexRule } from "@/lib/regex-format";
import { sanitizeContextWindow } from "@/lib/context-budget";
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

// ── 绘图全局配置(阶段 2c2):不分 scope,引擎/服务地址与对话行为无关 ──
/** 绘图引擎设置：chat-model = 沿用当前聊天模型(旧行为)，其余为独立出图服务 */
export type DrawEngineSetting = DrawEngine | "chat-model";

/** 默认出图参数(存为 `draw_defaults` JSON) */
export interface DrawDefaults {
  size: string;
  steps: number;
  cfgScale: number;
  seed: number;
  sampler: string;
}

export interface DrawConfig {
  engine: DrawEngineSetting;
  baseUrl: string;
  apiKey: string;
  model: string;
  defaults: DrawDefaults;
  comfyWorkflow: string;
}

export const DEFAULT_DRAW_DEFAULTS: DrawDefaults = {
  size: "1024x1024",
  steps: 20,
  cfgScale: 7,
  seed: -1,
  sampler: "",
};

export const DEFAULT_DRAW_CONFIG: DrawConfig = {
  engine: "chat-model",
  baseUrl: "",
  apiKey: "",
  model: "",
  defaults: { ...DEFAULT_DRAW_DEFAULTS },
  comfyWorkflow: "",
};

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
  /** 绘图全局配置(引擎/服务地址/密钥/默认参数/ComfyUI 工作流) */
  drawConfig: DrawConfig;
  /** 更新并立即落盘绘图配置(设置键:draw_engine/draw_base_url/draw_api_key/…) */
  setDrawConfig: (patch: Partial<DrawConfig>) => Promise<void>;
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
    // Token 预算:模型上下文窗口(缺省保守 8192,可手动覆盖)。
    // T-112: 0/NaN/负数与过小值在这里就收敛,坏数据不得进入发送链路。
    const contextWindow = sanitizeContextWindow(obj.context_window);
    if (contextWindow !== undefined) out.context_window = contextWindow;
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

function parseDrawDefaults(raw: string | undefined): DrawDefaults {
  if (!raw) return { ...DEFAULT_DRAW_DEFAULTS };
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const num = (camel: string, snake: string, fallback: number): number => {
      const v = obj[camel] ?? obj[snake];
      return typeof v === "number" && Number.isFinite(v) ? v : fallback;
    };
    return {
      size: typeof obj.size === "string" && obj.size.trim() ? obj.size : DEFAULT_DRAW_DEFAULTS.size,
      steps: num("steps", "steps", DEFAULT_DRAW_DEFAULTS.steps),
      cfgScale: num("cfgScale", "cfg_scale", DEFAULT_DRAW_DEFAULTS.cfgScale),
      seed: num("seed", "seed", DEFAULT_DRAW_DEFAULTS.seed),
      sampler: typeof obj.sampler === "string" ? obj.sampler : DEFAULT_DRAW_DEFAULTS.sampler,
    };
  } catch {
    return { ...DEFAULT_DRAW_DEFAULTS };
  }
}

function parseDrawEngine(raw: string | undefined): DrawEngineSetting {
  return raw === "openai" || raw === "comfyui" || raw === "sdwebui" ? raw : "chat-model";
}

/**
 * 读全局绘图配置。单个 key 失败只回退默认值,不拖垮其它设置
 * (与 readScopedValues 同样是「坏一条不影响全局」的策略)。
 */
async function readDrawConfig(): Promise<DrawConfig> {
  const safe = async (key: string): Promise<string> => {
    try {
      return (await dbGetSetting(key)) || "";
    } catch {
      return "";
    }
  };
  const [engine, baseUrl, apiKey, model, defaults, comfyWorkflow] = await Promise.all([
    safe("draw_engine"),
    safe("draw_base_url"),
    safe("draw_api_key"),
    safe("draw_model"),
    safe("draw_defaults"),
    safe("draw_comfy_workflow"),
  ]);
  return {
    engine: parseDrawEngine(engine),
    baseUrl,
    apiKey,
    model,
    defaults: parseDrawDefaults(defaults),
    comfyWorkflow,
  };
}

/** 工作 scope 沿用历史 key；对话 scope 用 `${key}#chat` —— 旧数据天然继续属于「工作」 */
export function scopedSettingKey(base: string, scope: SettingsScope): string {
  return scope === "chat" ? `${base}#chat` : base;
}

/** api_url 归一化结果；reason 供向导选择提示文案。 */
export type ApiUrlNormalization =
  | { ok: true; url: string; changed: boolean }
  | { ok: false; reason: "empty" | "scheme" | "invalid" };

/** 无 scheme 的输入是否「像主机名」——避免把误贴的 API key 补成 http://sk-xxx */
function looksLikeHost(parsed: URL): boolean {
  const host = parsed.hostname;
  return (
    host === "localhost" ||
    host.includes(".") ||
    host.startsWith("[") || // IPv6 字面量（URL.hostname 带动方括号）
    parsed.port !== ""
  );
}

/**
 * 把用户输入的 api_url 归一化为 http(s) 地址（T-033）。
 *
 * - 缺 scheme 且形如 `host:port/path` → 自动补 `http://`；
 * - 非 http(s) scheme → 拒绝（reason: "scheme"），不允许保存；
 * - 保存前统一去首尾空白与尾斜杠。
 *
 * 与 Rust `normalize_api_url` 保持同一套判定，避免「前端能存、后端自愈丢弃」。
 */
export function normalizeApiUrl(raw: string): ApiUrlNormalization {
  const input = raw.trim();
  if (!input) return { ok: false, reason: "empty" };
  if (/[\s\u0000-\u001f\u007f]/.test(input)) return { ok: false, reason: "invalid" };

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(input);
  let candidate: string;
  if (schemeMatch) {
    const scheme = schemeMatch[1]?.toLowerCase() ?? "";
    if (scheme !== "http" && scheme !== "https") return { ok: false, reason: "scheme" };
    candidate = input;
  } else {
    if (input.startsWith("/") || input.startsWith("\\")) {
      return { ok: false, reason: "invalid" };
    }
    candidate = `http://${input}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "scheme" };
  }
  if (!parsed.hostname) return { ok: false, reason: "invalid" };
  if (!schemeMatch && !looksLikeHost(parsed)) return { ok: false, reason: "invalid" };

  const url = candidate.replace(/\/+$/, "");
  return { ok: true, url, changed: url !== raw };
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
  drawConfig: { ...DEFAULT_DRAW_CONFIG, defaults: { ...DEFAULT_DRAW_DEFAULTS } },

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
      // Load drawing config (全局:引擎/服务地址/密钥/默认参数/ComfyUI 工作流)
      const drawConfig = await readDrawConfig();
      // Load connection profiles (酒馆 Connection Profiles)
      let connectionProfiles: ConnectionProfile[] = [];
      try {
        const raw = await dbGetSetting("connection_profiles");
        if (raw) connectionProfiles = sanitizeConnectionProfiles(JSON.parse(raw));
      } catch {
        /* ignore */
      }
      // Defensive filter: records with an unusable api_url stay in the DB
      // (Rust self-heal keeps them too) but are not offered to the UI. Missing
      // schemes are repaired here so legacy `localhost:11434/v1` keeps working.
      // F2: per-model parameters come from the persisted params_json record.
      const skippedModels: string[] = [];
      // T-040：Rust 解不开密文时返回 api_key_locked 标记 + 空 key。空值只代表
      // 「本次拿不到明文」，不是「用户清空了 key」——Rust 的 save_model 收到空
      // key 会保留原密文，这里额外留痕，避免用户以为 key 丢了。
      const lockedModels: string[] = [];
      const validModels = models.flatMap((m) => {
        const normalized = normalizeApiUrl(String(m.api_url || ""));
        if (!normalized.ok) {
          skippedModels.push(m.name);
          return [];
        }
        if ((m as { api_key_locked?: boolean }).api_key_locked) lockedModels.push(m.name);
        return [
          {
            name: m.name,
            provider: m.provider,
            api_url: normalized.url,
            api_key: m.api_key_encrypted || "",
            model: m.model,
            parameters: parseParams(m.params_json),
          },
        ];
      });
      if (skippedModels.length > 0) {
        // 不静默：记录仍在数据库里，只是本轮不可用（Rust 自愈同样保留记录）
        logDiag(
          `settings.load: 跳过 api_url 非 http(s) 的模型（记录已保留）: ${skippedModels.join(", ")}`
        );
      }
      if (lockedModels.length > 0) {
        // 不静默：密文仍在库中，本次只是拿不到明文（重启/换账户常见）
        logDiag(
          `settings.load: ${lockedModels.join(", ")} 的 API key 解密失败（密文仍在库中，需重新输入 key 才能使用）`
        );
      }
      // Remap active_model if it pointed at a dropped record ("DeepSeek " → "DeepSeek")
      // 两套 scope 各自修复，避免对话 scope 的历史值在切换后指向不存在的模型。
      const remapActive = (name: string): string => {
        if (!name) return "";
        if (validModels.some((m) => m.name === name)) return name;
        const trimmed = name.trim();
        const match = validModels.find((m) => m.name === trimmed);
        if (match) return match.name;
        // 不静默清空：数据库里的 active_model 保留，前端只是本轮没有可用模型
        logDiag(`settings.load: active_model「${name}」不可用，已临时清空（数据库记录保留）`);
        return "";
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
        drawConfig,
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
        // T-028: 没有 per-model 参数就写 "{}"，**不要**把当前 scope 的默认值烧进来。
        // defaultParameters 是当前 scope 的镜像；旧写法会让「对话」里新增的模型带
        // 显式参数，重启后跨 scope 生效（发送端 useChatStore 先取 model.parameters）。
        // 发送端已有回退逻辑：model.parameters?.x ?? 当前 scope 默认值。
        params_json: JSON.stringify(m.parameters ?? {}),
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
      // T-096: 模型列表是全局的，两个 scope 的 activeModel 都可能指向它。
      // 只清当前 scope 会让另一个 scope 残留已删名字 —— 切过去后 select
      // 没有匹配项、发送按钮直接置灰。
      const scopes = {
        work: { ...s.scopes.work },
        chat: { ...s.scopes.chat },
      };
      if (scopes.work.activeModel === name) scopes.work.activeModel = "";
      if (scopes.chat.activeModel === name) scopes.chat.activeModel = "";
      return {
        models: s.models.filter((m) => m.name !== name),
        activeModel: s.activeModel === name ? "" : s.activeModel,
        scopes,
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

  setDrawConfig: async (patch) => {
    set((s) => ({ drawConfig: { ...s.drawConfig, ...patch } }));
    const jobs: Promise<void>[] = [];
    if (patch.engine !== undefined) jobs.push(dbSaveSetting("draw_engine", patch.engine));
    if (patch.baseUrl !== undefined) jobs.push(dbSaveSetting("draw_base_url", patch.baseUrl));
    // `_key` 后缀由 Rust 侧自动 DPAPI 加密/解密
    if (patch.apiKey !== undefined) jobs.push(dbSaveSetting("draw_api_key", patch.apiKey));
    if (patch.model !== undefined) jobs.push(dbSaveSetting("draw_model", patch.model));
    if (patch.defaults !== undefined)
      jobs.push(dbSaveSetting("draw_defaults", JSON.stringify(patch.defaults)));
    if (patch.comfyWorkflow !== undefined)
      jobs.push(dbSaveSetting("draw_comfy_workflow", patch.comfyWorkflow));
    try {
      await Promise.all(jobs);
    } catch (e) {
      logDiag(`setDrawConfig failed: ${String(e)}`);
    }
  },

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
      // T-040：空 key（解密失败/未填）不会覆盖库中已有密文 —— Rust save_model
      // 对此做了保留；这里与 save() 的 T-028 写法保持一致。
      api_key_encrypted: m.api_key,
      model: m.model,
      // T-028/T-040：无 per-model 参数写 "{}"，不把当前 scope 默认值烧进记录
      params_json: JSON.stringify(m.parameters ?? {}),
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
