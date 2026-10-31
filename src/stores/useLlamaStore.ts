import { create } from "zustand";
import {
  dbGetSetting,
  dbSaveSetting,
  llamaStart,
  llamaStop,
  llamaStatus,
  probeLocalLlm,
} from "@/lib/tauri";
import { useTranslateStore } from "@/stores/useTranslateStore";
import type { LlamaConfig, LlamaStatus } from "@/types";

/** 设置键全部全局（无 scope）：运行时是机器级服务配置，与对话/模型 scope 无关。 */
const KEY_SERVER_PATH = "llama_server_path";
const KEY_MODEL_PATH = "llama_model_path";
const KEY_CTX_SIZE = "llama_ctx_size";
const KEY_N_GPU_LAYERS = "llama_n_gpu_layers";
const KEY_PORT = "llama_port";

const IDLE_STATUS: LlamaStatus = { running: false };

/** 空串 / 非数字一律视为「未配置」（null = 交给后端默认值）。 */
function parseOptionalNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function numberToSetting(v: number | null): string {
  return v === null ? "" : String(v);
}

/**
 * 启动成功后把 llama-server 暴露的模型 id 写进翻译设置，免去用户手抄。
 * llama.cpp 的 /v1/models 返回的 id 通常是 .gguf 的完整路径，不一定是用户
 * 能猜到的短名，因此配置为空时优先自动填。
 * 已有且仍在返回列表里的模型名不覆盖；探测失败只吞掉 —— 运行时本身已启动成功，
 * /v1/models 偶尔未就绪不应把「启动成功」改写成失败。
 */
async function autoFillLocalModel(baseUrl: string): Promise<void> {
  try {
    const models = await probeLocalLlm(baseUrl, useTranslateStore.getState().localApiKey);
    const first = models[0];
    if (!first) return;
    const current = useTranslateStore.getState().localModel;
    if (!current || !models.includes(current)) {
      await useTranslateStore.getState().setLocalModel(first);
    }
  } catch {
    // 探测失败（尚未就绪 / 鉴权 / 网络）不影响启动结果，用户仍可手动拉取模型
  }
}

interface LlamaState {
  /** llama-server.exe 绝对路径 */
  serverPath: string;
  /** .gguf 模型绝对路径 */
  modelPath: string;
  /** 上下文长度；null = 后端默认 4096 */
  ctxSize: number | null;
  /** 卸载到 GPU 的层数；null = 后端默认 0（纯 CPU） */
  nGpuLayers: number | null;
  /** 端口；null = 自动分配 */
  port: number | null;
  status: LlamaStatus;
  starting: boolean;
  /** 最近一次启动成功后自动写入翻译设置的 /v1 地址；null = 尚未自动填入 */
  autoFilledUrl: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  /** 把当前表单值全部写回设置（启动前调用，保证下次启动即恢复配置） */
  saveConfig: () => Promise<void>;
  setServerPath: (p: string) => Promise<void>;
  setModelPath: (p: string) => Promise<void>;
  setCtxSize: (v: number | null) => Promise<void>;
  setNGpuLayers: (v: number | null) => Promise<void>;
  setPort: (v: number | null) => Promise<void>;
  /**
   * 启动运行时；成功后把 translate_local_url 指向 http://127.0.0.1:<port>/v1，
   * 并从 /v1/models 自动补全 translate_local_model（已有有效值不覆盖）。
   */
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

/**
 * 内置 llama.cpp 运行时。生命周期由 Rust `commands/llama.rs` 托管；
 * 本 store 只负责配置持久化、启停调用，以及启动成功后把本地翻译的
 * Base URL 自动指向新分配的端口（否则用户还得手动抄端口）。
 */
export const useLlamaStore = create<LlamaState>((set, get) => ({
  serverPath: "",
  modelPath: "",
  ctxSize: null,
  nGpuLayers: null,
  port: null,
  status: IDLE_STATUS,
  starting: false,
  autoFilledUrl: null,
  loaded: false,

  load: async () => {
    try {
      const [serverPath, modelPath, ctxSize, nGpuLayers, port, status] = await Promise.all([
        dbGetSetting(KEY_SERVER_PATH),
        dbGetSetting(KEY_MODEL_PATH),
        dbGetSetting(KEY_CTX_SIZE),
        dbGetSetting(KEY_N_GPU_LAYERS),
        dbGetSetting(KEY_PORT),
        // 应用重启后进程已消失，这里主要是把上一次的失败原因带回来；
        // llama_status 不可用时不应拖垮整个设置加载。
        llamaStatus().catch(() => IDLE_STATUS),
      ]);
      set({
        serverPath: serverPath || "",
        modelPath: modelPath || "",
        ctxSize: parseOptionalNumber(ctxSize),
        nGpuLayers: parseOptionalNumber(nGpuLayers),
        port: parseOptionalNumber(port),
        status,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  saveConfig: async () => {
    const { serverPath, modelPath, ctxSize, nGpuLayers, port } = get();
    await Promise.all([
      dbSaveSetting(KEY_SERVER_PATH, serverPath),
      dbSaveSetting(KEY_MODEL_PATH, modelPath),
      dbSaveSetting(KEY_CTX_SIZE, numberToSetting(ctxSize)),
      dbSaveSetting(KEY_N_GPU_LAYERS, numberToSetting(nGpuLayers)),
      dbSaveSetting(KEY_PORT, numberToSetting(port)),
    ]);
  },

  setServerPath: async (p) => {
    set({ serverPath: p });
    await dbSaveSetting(KEY_SERVER_PATH, p);
  },
  setModelPath: async (p) => {
    set({ modelPath: p });
    await dbSaveSetting(KEY_MODEL_PATH, p);
  },
  setCtxSize: async (v) => {
    set({ ctxSize: v });
    await dbSaveSetting(KEY_CTX_SIZE, numberToSetting(v));
  },
  setNGpuLayers: async (v) => {
    set({ nGpuLayers: v });
    await dbSaveSetting(KEY_N_GPU_LAYERS, numberToSetting(v));
  },
  setPort: async (v) => {
    set({ port: v });
    await dbSaveSetting(KEY_PORT, numberToSetting(v));
  },

  start: async () => {
    if (get().starting) return;
    const { serverPath, modelPath, ctxSize, nGpuLayers, port } = get();
    const server = serverPath.trim();
    const model = modelPath.trim();
    if (!server || !model) {
      set({ status: { running: false, error: "llama-server / 模型路径未配置" } });
      return;
    }

    set({ starting: true });
    try {
      await get().saveConfig();
      const cfg: LlamaConfig = { serverPath: server, modelPath: model };
      if (ctxSize !== null) cfg.ctxSize = ctxSize;
      if (nGpuLayers !== null) cfg.nGpuLayers = nGpuLayers;
      if (port !== null) cfg.port = port;

      const status = await llamaStart(cfg);
      const baseUrl =
        status.running && typeof status.port === "number"
          ? `http://127.0.0.1:${status.port}/v1`
          : null;
      if (baseUrl) await useTranslateStore.getState().setLocalBaseUrl(baseUrl);
      // 先落「启动成功」状态：模型探测长则 30s，不应让界面卡在「启动中」。
      set({ status, starting: false, autoFilledUrl: baseUrl });
      if (baseUrl) await autoFillLocalModel(baseUrl);
    } catch (e) {
      // 后端启动失败走 Err(String)（路径不存在 / 120s 未就绪 / 进程提前退出）
      set({ status: { running: false, error: String(e) }, starting: false, autoFilledUrl: null });
    }
  },

  stop: async () => {
    try {
      await llamaStop();
      set({ status: { ...IDLE_STATUS }, autoFilledUrl: null });
    } catch (e) {
      set({ status: { running: false, error: String(e) } });
    } finally {
      set({ starting: false });
    }
  },

  refreshStatus: async () => {
    try {
      set({ status: await llamaStatus() });
    } catch (e) {
      set({ status: { running: false, error: String(e) } });
    }
  },
}));
