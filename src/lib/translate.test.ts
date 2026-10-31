// lib/translate.test.ts — 翻译引擎语言码映射与 local 配置透传
//
// 阶段 2a 契约：local 引擎用 BCP-47 语言码；translateText 必须把
// useTranslateStore 里的本地配置原样塞进 TranslateOptions.local。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/tauri", () => ({
  translateText: invokeMock,
  dbGetSetting: vi.fn(),
  dbSaveSetting: vi.fn(),
}));

import { langCode, translateText } from "@/lib/translate";
import { useTranslateStore } from "@/stores/useTranslateStore";

const LOCAL_CODES: Record<string, string> = {
  中文: "zh-CN",
  English: "en",
  日本語: "ja",
  한국어: "ko",
  Français: "fr",
  Deutsch: "de",
  Русский: "ru",
};

beforeEach(() => {
  invokeMock.mockReset();
  useTranslateStore.setState({
    engine: "google",
    deeplKey: "",
    libreUrl: "",
    proxyUrl: "",
    localBaseUrl: "",
    localApiKey: "",
    localModel: "",
    localSystemPrompt: "",
    localTemperature: 0.3,
    localTimeoutSecs: 120,
  });
});

describe("langCode", () => {
  it.each(Object.entries(LOCAL_CODES))("local: %s → %s (BCP-47)", (name, code) => {
    expect(langCode(name, "local")).toBe(code);
  });

  it("保留现有引擎的语言码映射", () => {
    expect(langCode("中文", "google")).toBe("zh-CN");
    expect(langCode("中文", "deepl")).toBe("ZH");
    expect(langCode("中文", "libre")).toBe("zh");
  });

  it("未知目标语言返回 undefined", () => {
    expect(langCode("Klingon", "local")).toBeUndefined();
    expect(langCode("Klingon", "google")).toBeUndefined();
  });
});

describe("translateText", () => {
  it("local 引擎透传 BCP-47 语言码与本地配置", async () => {
    useTranslateStore.setState({
      engine: "local",
      localBaseUrl: "http://127.0.0.1:11434/v1",
      localApiKey: "local-key",
      localModel: "qwen2.5:7b",
      localSystemPrompt: "只输出译文",
      localTemperature: 0.1,
      localTimeoutSecs: 90,
    });
    invokeMock.mockResolvedValue("你好");

    await expect(translateText("hello", "中文")).resolves.toBe("你好");
    expect(invokeMock).toHaveBeenCalledWith("hello", {
      engine: "local",
      targetLang: "zh-CN",
      deeplKey: "",
      libreUrl: "",
      proxyUrl: "",
      local: {
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "local-key",
        model: "qwen2.5:7b",
        temperature: 0.1,
        systemPrompt: "只输出译文",
        timeoutSecs: 90,
      },
    });
  });

  it("非 local 引擎不携带本地配置（local=null）", async () => {
    useTranslateStore.setState({ engine: "deepl", deeplKey: "abc:fx", proxyUrl: "http://p" });
    invokeMock.mockResolvedValue("translated");

    await translateText("hello", "English");
    expect(invokeMock).toHaveBeenCalledWith("hello", {
      engine: "deepl",
      targetLang: "EN",
      deeplKey: "abc:fx",
      libreUrl: "",
      proxyUrl: "http://p",
      local: null,
    });
  });

  it("不支持的目标语言在调用 IPC 前就报错", async () => {
    await expect(translateText("hello", "Klingon")).rejects.toThrow("不支持的目标语言");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
