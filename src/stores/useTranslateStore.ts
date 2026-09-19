import { create } from "zustand";
import { dbGetSetting, dbSaveSetting } from "@/lib/tauri";

/** 翻译引擎:google(免费免key,默认)/ deepl(需key)/ libre(自托管或公共实例) */
export type TranslateEngine = "google" | "deepl" | "libre";

interface TranslateState {
  engine: TranslateEngine;
  deeplKey: string;
  libreUrl: string;
  /** 可选 HTTP 代理(国内访问 Google 翻译必需,如 http://127.0.0.1:16210);空 = 直连 */
  proxyUrl: string;
  loaded: boolean;
  load: () => Promise<void>;
  setEngine: (e: TranslateEngine) => Promise<void>;
  setDeeplKey: (k: string) => Promise<void>;
  setLibreUrl: (u: string) => Promise<void>;
  setProxyUrl: (p: string) => Promise<void>;
}

/** 翻译引擎全局配置(settings 树持久化;酒馆与工作共用) */
export const useTranslateStore = create<TranslateState>((set) => ({
  engine: "google",
  deeplKey: "",
  libreUrl: "",
  proxyUrl: "",
  loaded: false,

  load: async () => {
    try {
      const [e, k, u, p] = await Promise.all([
        dbGetSetting("translate_engine"),
        dbGetSetting("deepl_key"),
        dbGetSetting("libre_url"),
        dbGetSetting("translate_proxy"),
      ]);
      set({
        engine: (e as TranslateEngine) || "google",
        deeplKey: k || "",
        libreUrl: u || "",
        proxyUrl: p || "",
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
}));
