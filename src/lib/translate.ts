// lib/translate.ts — 内置翻译(专业翻译引擎,不消耗对话模型)
//
// 用户明确要求:翻译用非 AI 翻译工具(Google/DeepL/LibreTranslate),
// 不要用对话 LLM——省额度、不受当前预设影响、质量稳定。
// 引擎配置在设置 → 翻译(useTranslateStore),酒馆自动/手动翻译共用。

import { translateText as invokeTranslate } from "./tauri";
import { useTranslateStore, type TranslateEngine } from "@/stores/useTranslateStore";

/** 目标语言(与酒馆顶栏下拉一致) */
export const TARGET_LANGS = [
  "中文",
  "English",
  "日本語",
  "한국어",
  "Français",
  "Deutsch",
  "Русский",
];

/** 各引擎的语言代码映射 */
const GOOGLE_CODES: Record<string, string> = {
  中文: "zh-CN",
  English: "en",
  日本語: "ja",
  한국어: "ko",
  Français: "fr",
  Deutsch: "de",
  Русский: "ru",
};
const DEEPL_CODES: Record<string, string> = {
  中文: "ZH",
  English: "EN",
  日本語: "JA",
  한국어: "KO",
  Français: "FR",
  Deutsch: "DE",
  Русский: "RU",
};
const LIBRE_CODES: Record<string, string> = {
  中文: "zh",
  English: "en",
  日本語: "ja",
  한국어: "ko",
  Français: "fr",
  Deutsch: "de",
  Русский: "ru",
};

function langCode(targetLang: string, engine: TranslateEngine): string | undefined {
  if (engine === "deepl") return DEEPL_CODES[targetLang];
  if (engine === "libre") return LIBRE_CODES[targetLang];
  return GOOGLE_CODES[targetLang];
}

/** 翻译文本到目标语言(语言名为展示名,如 "中文");走当前配置的引擎 */
export async function translateText(text: string, targetLang: string): Promise<string> {
  const s = useTranslateStore.getState();
  const code = langCode(targetLang, s.engine);
  if (!code) throw new Error(`不支持的目标语言: ${targetLang}`);
  return invokeTranslate(text, code, s.engine, s.deeplKey, s.libreUrl, s.proxyUrl);
}

/** 判断文本是否含中文字符(用于默认目标语言建议) */
export function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}
