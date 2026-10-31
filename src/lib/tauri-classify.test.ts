// lib/tauri-classify.test.ts — 错误分类与 done 载荷兜底的回归测试
//
// T-012：Rust 的真实超时文案是中文（net.rs: "首字节超时（180 秒无响应）" /
//        "响应超时（60 秒无数据）"），旧 classifyError 只认英文 → kind=unknown
//        → 没有超时标题/提示，也没有重试按钮。
// T-029：非 SSE 模板（sse_enabled 缺省 false）把整段回复放进 done 事件；
//        done 分支必须先交付 content，再 onDone，否则正文不显示、不落库。
//
// 这里 mock 掉 @tauri-apps/api/{core,event}，不依赖真实 Tauri 运行时。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatRequest } from "@/types";

type StreamPayload = Record<string, unknown>;
type ListenCallback = (event: { payload: StreamPayload }) => void;

const shared = vi.hoisted(() => ({
  listeners: new Set<ListenCallback>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_event: string, cb: ListenCallback) => {
    shared.listeners.add(cb);
    return () => {
      shared.listeners.delete(cb);
    };
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => undefined,
}));

beforeEach(() => {
  // 每个用例拿到全新的 tauri.ts 模块（streams / 已终止集合都是模块级状态）。
  vi.resetModules();
  shared.listeners.clear();
});

async function loadTauri(): Promise<typeof import("@/lib/tauri")> {
  return import("@/lib/tauri");
}

function emit(payload: StreamPayload): void {
  for (const cb of [...shared.listeners]) cb({ payload });
}

function makeRequest(): ChatRequest {
  return {
    model_config: {
      name: "test",
      provider: "openai",
      api_url: "http://127.0.0.1:9/v1",
      api_key: "",
      model: "test-model",
    },
    messages: [{ role: "user", content: "hi" }],
  };
}

describe("classifyError（T-012）", () => {
  it("Rust 中文首字节超时 → timeout", async () => {
    const { classifyError } = await loadTauri();
    expect(classifyError("首字节超时（180 秒无响应）").kind).toBe("timeout");
  });

  it("Rust 中文响应超时 → timeout", async () => {
    const { classifyError } = await loadTauri();
    expect(classifyError("响应超时（60 秒无数据）").kind).toBe("timeout");
  });

  it("英文超时文案仍然 → timeout", async () => {
    const { classifyError } = await loadTauri();
    expect(classifyError("operation timed out").kind).toBe("timeout");
    expect(classifyError("deadline exceeded").kind).toBe("timeout");
  });

  it("429 → rate_limit（结构化状态码与裸码都识别）", async () => {
    const { classifyError } = await loadTauri();
    expect(classifyError("API error 429: rate limit exceeded").kind).toBe("rate_limit");
    expect(classifyError("429 Too Many Requests").kind).toBe("rate_limit");
  });

  it("500 → overload（现有枚举中最接近的服务端错误类）", async () => {
    const { classifyError } = await loadTauri();
    expect(classifyError("API error 500: Internal Server Error").kind).toBe("overload");
  });

  it("504 按服务端错误而非客户端超时分类", async () => {
    const { classifyError } = await loadTauri();
    expect(classifyError("API error 504: Gateway Timeout").kind).toBe("overload");
    expect(classifyError("504 Gateway Timeout").kind).toBe("overload");
  });

  it("4xx 正文里的 500 不会被模糊匹配误判为 5xx 服务错误", async () => {
    const { classifyError } = await loadTauri();
    expect(classifyError("API error 400: invalid max_tokens 500").kind).toBe("unknown");
  });
});

describe("done 事件正文兜底（T-029）", () => {
  it("done 携带 content 时先 onToken 再 onDone", async () => {
    const { streamChat } = await loadTauri();
    const onToken = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    await streamChat(makeRequest(), "req-done-content", { onToken, onDone, onError });

    emit({
      request_id: "req-done-content",
      done: true,
      content: "整段回复",
      cache_hit_tokens: 9,
      cache_miss_tokens: 1,
    });

    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith("整段回复");
    expect(onDone).toHaveBeenCalledTimes(1);
    // cache 统计不能因正文兜底而丢
    expect(onDone).toHaveBeenCalledWith({ hit: 9, miss: 1 });
    expect(onError).not.toHaveBeenCalled();

    const tokenOrder = onToken.mock.invocationCallOrder[0] ?? -1;
    const doneOrder = onDone.mock.invocationCallOrder[0] ?? -1;
    expect(tokenOrder).toBeGreaterThan(-1);
    expect(tokenOrder).toBeLessThan(doneOrder);
  });

  it("done 同时带 reasoning 时先交付思考内容再结束", async () => {
    const { streamChat } = await loadTauri();
    const onToken = vi.fn();
    const onReasoning = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    await streamChat(makeRequest(), "req-done-reasoning", {
      onToken,
      onReasoning,
      onDone,
      onError,
    });

    emit({
      request_id: "req-done-reasoning",
      done: true,
      content: "答",
      reasoning: "想一想",
    });

    expect(onReasoning).toHaveBeenCalledWith("想一想");
    expect(onToken).toHaveBeenCalledWith("答");
    expect(onDone).toHaveBeenCalledTimes(1);
    const reasoningOrder = onReasoning.mock.invocationCallOrder[0] ?? -1;
    const doneOrder = onDone.mock.invocationCallOrder[0] ?? -1;
    expect(reasoningOrder).toBeGreaterThan(-1);
    expect(reasoningOrder).toBeLessThan(doneOrder);
  });
});
