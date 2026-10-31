import { create } from "zustand";
import { dbGetSetting, dbSaveSetting } from "@/lib/tauri";
import type { TranslateEngine } from "@/types";

export type { TranslateEngine };

/** 默认温度：翻译要稳定，取低值 */
const DEFAULT_LOCAL_TEMPERATURE = 0.3;
/** 默认单请求超时（秒） */
const DEFAULT_LOCAL_TIMEOUT = 120;

function parseNumber(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

interface TranslateState {
  engine: TranslateEngine;
  deeplKey: string;
  libreUrl: string;
  /** 可选 HTTP 代理(国内访问 Google 翻译必需,如 http://127.0.0.1:7890);空 = 直连 */
  proxyUrl: string;
  /** 本地 OpenAI 兼容端点（Ollama / LM Studio / llama.cpp server） */
  localBaseUrl: string;
  /** 本地端点 API Key（Ollama 通常为空）；设置键以 `_key` 结尾会自动 DPAPI 加密 */
  localApiKey: string;
  localModel: string;
  localSystemPrompt: string;
  localTemperature: number;
  localTimeoutSecs: number;
  loaded: boolean;
  load: () => Promise<void>;
  setEngine: (e: TranslateEngine) => Promise<void>;
  setDeeplKey: (k: string) => Promise<void>;
  setLibreUrl: (u: string) => Promise<void>;
  setProxyUrl: (p: string) => Promise<void>;
  setLocalBaseUrl: (u: string) => Promise<void>;
  setLocalApiKey: (k: string) => Promise<void>;
  setLocalModel: (m: string) => Promise<void>;
  setLocalSystemPrompt: (p: string) => Promise<void>;
  setLocalTemperature: (t: number) => Promise<void>;
  setLocalTimeoutSecs: (s: number) => Promise<void>;
}

/** 翻译引擎全局配置(settings 树持久化;酒馆与工作共用) */
export const useTranslateStore = create<TranslateState>((set) => ({
  engine: "google",
  deeplKey: "",
  libreUrl: "",
  proxyUrl: "",
  localBaseUrl: "",
  localApiKey: "",
  localModel: "",
  localSystemPrompt: "",
  localTemperature: DEFAULT_LOCAL_TEMPERATURE,
  localTimeoutSecs: DEFAULT_LOCAL_TIMEOUT,
  loaded: false,

  load: async () => {
    try {
      const [
        e,
        k,
        u,
        p,
        localUrl,
        localKey,
        localModel,
        localPrompt,
        localTemperature,
        localTimeout,
      ] = await Promise.all([
        dbGetSetting("translate_engine"),
        dbGetSetting("deepl_key"),
        dbGetSetting("libre_url"),
        dbGetSetting("translate_proxy"),
        dbGetSetting("translate_local_url"),
        dbGetSetting("translate_local_key"),
        dbGetSetting("translate_local_model"),
        dbGetSetting("translate_local_prompt"),
        dbGetSetting("translate_local_temperature"),
        dbGetSetting("translate_local_timeout"),
      ]);
      set({
        engine: (e as TranslateEngine) || "google",
        deeplKey: k || "",
        libreUrl: u || "",
        proxyUrl: p || "",
        localBaseUrl: localUrl || "",
        localApiKey: localKey || "",
        localModel: localModel || "",
        localSystemPrompt: localPrompt || "",
        localTemperature: parseNumber(localTemperature, DEFAULT_LOCAL_TEMPERATURE),
        localTimeoutSecs: parseNumber(localTimeout, DEFAULT_LOCAL_TIMEOUT),
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  setEngine: async (e) => {
    set({ engine: e });
    await dbSaveSetting("translate_engine", e);
  },
  setDeeplKey: async (k) => {
    set({ deeplKey: k });
    await dbSaveSetting("deepl_key", k);
  },
  setLibreUrl: async (u) => {
    set({ libreUrl: u });
    await dbSaveSetting("libre_url", u);
  },
  setProxyUrl: async (p) => {
    set({ proxyUrl: p });
    await dbSaveSetting("translate_proxy", p);
  },
  setLocalBaseUrl: async (u) => {
    set({ localBaseUrl: u });
    await dbSaveSetting("translate_local_url", u);
  },
  setLocalApiKey: async (k) => {
    set({ localApiKey: k });
    await dbSaveSetting("translate_local_key", k);
  },
  setLocalModel: async (m) => {
    set({ localModel: m });
    await dbSaveSetting("translate_local_model", m);
  },
  setLocalSystemPrompt: async (p) => {
    set({ localSystemPrompt: p });
    await dbSaveSetting("translate_local_prompt", p);
  },
  setLocalTemperature: async (t) => {
    set({ localTemperature: t });
    await dbSaveSetting("translate_local_temperature", String(t));
  },
  setLocalTimeoutSecs: async (s) => {
    set({ localTimeoutSecs: s });
    await dbSaveSetting("translate_local_timeout", String(s));
  },
}));
