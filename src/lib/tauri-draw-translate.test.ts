// lib/tauri-draw-translate.test.ts — 翻译/绘图 IPC 载荷契约
//
// 钉住阶段 2a 的新契约：结构体入参用 camelCase、命令名不变。
// translateText 的旧位置参数重载已在 2c1 删除（组件全部改用结构体）；
// generateImage 的旧重载保留给尚未迁移的绘图调用方。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  generateImage,
  llamaStart,
  llamaStatus,
  llamaStop,
  probeDrawService,
  probeLocalLlm,
  translateText,
} from "@/lib/tauri";
import type { DrawRequest } from "@/types";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("translateText", () => {
  it("新签名：text + TranslateOptions 结构体", async () => {
    invokeMock.mockResolvedValue("译文");
    await expect(
      translateText("hello", {
        engine: "local",
        targetLang: "ja",
        deeplKey: "",
        libreUrl: "",
        proxyUrl: "",
        local: {
          baseUrl: "http://127.0.0.1:1234/v1",
          apiKey: "",
          model: "qwen",
          temperature: 0.2,
          systemPrompt: "",
          timeoutSecs: 120,
        },
      })
    ).resolves.toBe("译文");
    expect(invokeMock).toHaveBeenCalledWith("translate_text", {
      text: "hello",
      opts: expect.objectContaining({ engine: "local", targetLang: "ja" }),
    });
  });
});

describe("generateImage", () => {
  const req: DrawRequest = {
    engine: "comfyui",
    baseUrl: "http://127.0.0.1:8188",
    model: "sd_xl.safetensors",
    prompt: "cat",
    negativePrompt: "dog",
    size: "768x512",
    steps: 20,
    cfgScale: 7,
    seed: 1,
    sampler: "euler",
    workflowJson: null,
  };

  it("新签名：invoke('generate_image', { req })，返回多图", async () => {
    const images = [{ path: "C:/gen/a.png", mime: "image/png" }];
    invokeMock.mockResolvedValue(images);
    await expect(generateImage(req)).resolves.toEqual(images);
    expect(invokeMock).toHaveBeenCalledWith("generate_image", { req });
  });

  it("旧位置参数：映射为 openai 引擎并返回首图路径", async () => {
    invokeMock.mockResolvedValue([
      { path: "C:/gen/1.png", mime: "image/png" },
      { path: "C:/gen/2.png", mime: "image/png" },
    ]);
    const url = "https://api.example.com/v1/images/generations";
    await expect(generateImage(url, "key", "cat", "dall-e-3", "1024x1024")).resolves.toBe(
      "C:/gen/1.png"
    );
    expect(invokeMock).toHaveBeenCalledWith("generate_image", {
      req: {
        engine: "openai",
        baseUrl: url,
        apiKey: "key",
        prompt: "cat",
        model: "dall-e-3",
        size: "1024x1024",
      },
    });
  });

  it("旧位置参数：接口未返回图片时返回空字符串（旧组件按 falsy 报错）", async () => {
    invokeMock.mockResolvedValue([]);
    await expect(generateImage("https://x/v1/images/generations", "", "p", "m", "s")).resolves.toBe(
      ""
    );
  });
});

describe("llama runtime", () => {
  it("llamaStart 提交 { cfg }，llamaStop/llamaStatus 无参", async () => {
    const status = { running: true, port: 39321, pid: 42 };
    invokeMock.mockResolvedValue(status);

    await expect(
      llamaStart({ serverPath: "C:/llama/llama-server.exe", modelPath: "C:/m.gguf", ctxSize: 4096 })
    ).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("llama_start", {
      cfg: { serverPath: "C:/llama/llama-server.exe", modelPath: "C:/m.gguf", ctxSize: 4096 },
    });

    await llamaStop();
    expect(invokeMock).toHaveBeenCalledWith("llama_stop");

    await expect(llamaStatus()).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("llama_status");
  });
});

describe("probes", () => {
  it("probeLocalLlm 提交 baseUrl/apiKey", async () => {
    invokeMock.mockResolvedValue(["qwen2.5:7b"]);
    await expect(probeLocalLlm("http://127.0.0.1:11434/v1", "k")).resolves.toEqual(["qwen2.5:7b"]);
    expect(invokeMock).toHaveBeenCalledWith("probe_local_llm", {
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "k",
    });
  });

  it("probeDrawService 提交 engine/baseUrl/apiKey", async () => {
    const info = { online: true, models: ["sd_xl"], samplers: ["euler"] };
    invokeMock.mockResolvedValue(info);
    await expect(probeDrawService("comfyui", "http://127.0.0.1:8188", "")).resolves.toEqual(info);
    expect(invokeMock).toHaveBeenCalledWith("probe_draw_service", {
      engine: "comfyui",
      baseUrl: "http://127.0.0.1:8188",
      apiKey: "",
    });
  });
});
