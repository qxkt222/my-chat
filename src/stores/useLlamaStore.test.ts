// stores/useLlamaStore.test.ts — 启动成功后自动补全翻译用的本地模型名
//
// 真机复现：内置 llama.cpp 启动成功后只写了 translate_local_url，没写
// translate_local_model，用户点「翻译测试」得到「未配置本地模型名称」。
// llama-server 的 /v1/models 返回的 id 是 .gguf 完整路径，这里钉住三条行为：
//   1. 模型名为空 → 启动后 probe 并写入 translate_local_model；
//   2. 已有模型名且仍在返回列表 → 不覆盖（不在列表 → 改成第一个）；
//   3. probe 抛错 → 启动仍算成功，不向上抛。

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipc = vi.hoisted(() => ({
  dbGetSetting: vi.fn(async (_key: string): Promise<string | null> => null),
  dbSaveSetting: vi.fn(async (_key: string, _value: string): Promise<void> => undefined),
  llamaStart: vi.fn(),
  llamaStop: vi.fn(async (): Promise<void> => undefined),
  llamaStatus: vi.fn(async () => ({ running: false })),
  probeLocalLlm: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ipc);

import { useLlamaStore } from "./useLlamaStore";
import { useTranslateStore } from "./useTranslateStore";

const MODEL = "D:\\models\\a.gguf";
const PORT = 14548;
const BASE_URL = `http://127.0.0.1:${PORT}/v1`;

function resetStores() {
  useLlamaStore.setState({
    serverPath: "C:\\llama\\llama-server.exe",
    modelPath: MODEL,
    ctxSize: null,
    nGpuLayers: null,
    port: null,
    status: { running: false },
    starting: false,
    autoFilledUrl: null,
    loaded: true,
  });
  useTranslateStore.setState({
    localBaseUrl: "",
    localApiKey: "",
    localModel: "",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.dbGetSetting.mockResolvedValue(null);
  ipc.dbSaveSetting.mockResolvedValue(undefined);
  ipc.llamaStart.mockResolvedValue({ running: true, port: PORT });
  ipc.probeLocalLlm.mockResolvedValue([MODEL]);
  resetStores();
});

describe("useLlamaStore.start — 自动补全本地模型名", () => {
  it("启动成功且模型名为空 → probe 后写入 translate_local_model", async () => {
    await useLlamaStore.getState().start();

    expect(ipc.llamaStart).toHaveBeenCalledTimes(1);
    expect(ipc.probeLocalLlm).toHaveBeenCalledWith(BASE_URL, "");
    expect(useTranslateStore.getState().localModel).toBe(MODEL);
    expect(ipc.dbSaveSetting).toHaveBeenCalledWith("translate_local_model", MODEL);
    expect(useTranslateStore.getState().localBaseUrl).toBe(BASE_URL);
    expect(useLlamaStore.getState().status).toEqual({ running: true, port: PORT });
    expect(useLlamaStore.getState().autoFilledUrl).toBe(BASE_URL);
  });

  it("已有模型名且仍在返回列表 → 不覆盖", async () => {
    const current = "second.gguf";
    useTranslateStore.setState({ localModel: current });
    ipc.probeLocalLlm.mockResolvedValue(["first.gguf", current]);

    await useLlamaStore.getState().start();

    expect(useTranslateStore.getState().localModel).toBe(current);
    expect(ipc.dbSaveSetting).not.toHaveBeenCalledWith("translate_local_model", expect.anything());
  });

  it("已有模型名但不在返回列表 → 改成第一个", async () => {
    useTranslateStore.setState({ localModel: "stale.gguf" });
    ipc.probeLocalLlm.mockResolvedValue([MODEL, "other.gguf"]);

    await useLlamaStore.getState().start();

    expect(useTranslateStore.getState().localModel).toBe(MODEL);
    expect(ipc.dbSaveSetting).toHaveBeenCalledWith("translate_local_model", MODEL);
  });

  it("probe 抛错 → 启动仍成功，不抛", async () => {
    ipc.probeLocalLlm.mockRejectedValue(new Error("connection refused"));

    await expect(useLlamaStore.getState().start()).resolves.toBeUndefined();

    const s = useLlamaStore.getState();
    expect(s.status).toEqual({ running: true, port: PORT });
    expect(s.starting).toBe(false);
    expect(s.autoFilledUrl).toBe(BASE_URL);
    expect(useTranslateStore.getState().localModel).toBe("");
  });
});
