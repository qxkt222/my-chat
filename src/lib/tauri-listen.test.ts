// lib/tauri-listen.test.ts — chat-stream 监听注册与 requestId 去重的回归测试
//
// 复现 P0（T-003）：useChatStore 在多模型对比时用 Promise.all 在同一 tick
// 并发调用 streamChat；旧实现只有 listen() resolve 后才写 chatUnlisten，
// 并发调用各自注册一个 chat-stream 监听 —— 同一 token 被回调 N 次、正文重复
// N 倍落库，且只有最后一个 unlisten 被保存。
//
// 这里 mock 掉 @tauri-apps/api/{core,event}，不依赖真实 Tauri 运行时。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatRequest } from "@/types";

type StreamPayload = Record<string, unknown>;
type ListenCallback = (event: { payload: StreamPayload }) => void;

const shared = vi.hoisted(() => ({
  listeners: new Set<ListenCallback>(),
  listenCalls: 0,
  failNextListen: false,
  invokeCalls: [] as string[],
  failNextInvoke: false,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_event: string, cb: ListenCallback) => {
    shared.listenCalls += 1;
    if (shared.failNextListen) {
      shared.failNextListen = false;
      throw new Error("listen boom");
    }
    shared.listeners.add(cb);
    return () => {
      shared.listeners.delete(cb);
    };
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    shared.invokeCalls.push(cmd);
    if (shared.failNextInvoke) {
      shared.failNextInvoke = false;
      throw new Error("invoke boom");
    }
    return undefined;
  },
}));

beforeEach(() => {
  // 每个用例拿到一份全新的 tauri.ts 模块（chatUnlisten / listenPromise /
  // streams / 已终止集合都是模块级状态）。
  vi.resetModules();
  shared.listeners.clear();
  shared.listenCalls = 0;
  shared.failNextListen = false;
  shared.invokeCalls = [];
  shared.failNextInvoke = false;
});

async function loadTauri(): Promise<typeof import("@/lib/tauri")> {
  return import("@/lib/tauri");
}

function emit(payload: StreamPayload): void {
  for (const cb of [...shared.listeners]) cb({ payload });
}

function makeHandlers() {
  return {
    onToken: vi.fn(),
    onReasoning: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  };
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

function streamChatInvocations(): number {
  return shared.invokeCalls.filter((c) => c === "stream_chat").length;
}

describe("chat-stream 监听注册", () => {
  it("并发两次 streamChat 只注册一个监听，token 按 requestId 只送达对应请求", async () => {
    const { streamChat } = await loadTauri();
    const a = makeHandlers();
    const b = makeHandlers();

    // 同一 tick 并发启动（多模型对比首发的真实调用形态）
    const p1 = streamChat(makeRequest(), "req-a", a);
    const p2 = streamChat(makeRequest(), "req-b", b);
    await Promise.all([p1, p2]);

    expect(shared.listenCalls).toBe(1);
    expect(streamChatInvocations()).toBe(2);

    emit({ request_id: "req-a", done: false, content: "A" });
    emit({ request_id: "req-b", done: false, content: "B" });

    // 每个 token 只应用一次（旧实现每个监听都会命中同一 handler）
    expect(a.onToken).toHaveBeenCalledTimes(1);
    expect(a.onToken).toHaveBeenCalledWith("A");
    expect(b.onToken).toHaveBeenCalledTimes(1);
    expect(b.onToken).toHaveBeenCalledWith("B");
  });

  it("done 后 handler 被删除：同 requestId 的迟到事件不再触发，重复 done 只回调一次", async () => {
    const { streamChat } = await loadTauri();
    const h = makeHandlers();
    await streamChat(makeRequest(), "req-a", h);

    emit({ request_id: "req-a", done: true, cache_hit_tokens: 12, cache_miss_tokens: 3 });
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledWith({ hit: 12, miss: 3 });

    // 迟到 token 与重复 done（Rust 在部分路径会发两次 done）
    emit({ request_id: "req-a", done: false, content: "late" });
    emit({ request_id: "req-a", done: true });

    expect(h.onToken).not.toHaveBeenCalled();
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it("后续流复用已注册的监听（chatUnlisten 快速路径），不会再次 listen", async () => {
    const { streamChat } = await loadTauri();
    const first = makeHandlers();
    await streamChat(makeRequest(), "req-1", first);
    emit({ request_id: "req-1", done: true });

    const second = makeHandlers();
    await streamChat(makeRequest(), "req-2", second);
    expect(shared.listenCalls).toBe(1);

    emit({ request_id: "req-2", done: false, content: "second" });
    expect(second.onToken).toHaveBeenCalledWith("second");
  });

  it("listen 失败上报 onError，清掉缓存 promise，后续流可重试", async () => {
    const { streamChat } = await loadTauri();
    shared.failNextListen = true;

    const failed = makeHandlers();
    await streamChat(makeRequest(), "req-a", failed);

    expect(failed.onError).toHaveBeenCalledTimes(1);
    expect(failed.onError.mock.calls[0]?.[0]).toContain("listen boom");
    expect(streamChatInvocations()).toBe(0);

    const retried = makeHandlers();
    await streamChat(makeRequest(), "req-b", retried);

    expect(shared.listenCalls).toBe(2);
    expect(streamChatInvocations()).toBe(1);
    expect(retried.onError).not.toHaveBeenCalled();
  });

  it("invoke 失败后 handler 被移除，迟到事件不再触发", async () => {
    const { streamChat } = await loadTauri();
    shared.failNextInvoke = true;

    const h = makeHandlers();
    await streamChat(makeRequest(), "req-a", h);
    expect(h.onError).toHaveBeenCalledTimes(1);

    emit({ request_id: "req-a", done: false, content: "late" });
    expect(h.onToken).not.toHaveBeenCalled();
  });
});

// T-026：取消时不能立刻删 handler。Rust 的流循环在下一个检查点看到取消标记后
// 仍会补发一次 done（chat.rs 的 run_sse_stream），旧实现同一 tick 就丢 handler，
// 那次 done 永远到不了 onDone —— 酒馆的 finish() 不执行，磁盘留下空正文。
describe("cancelChat 取消宽限窗口", () => {
  it("取消后短窗口内到达的 done 仍回调 onDone（半截内容有机会落盘）", async () => {
    vi.useFakeTimers();
    try {
      const { streamChat, cancelChat } = await loadTauri();
      const h = makeHandlers();
      await streamChat(makeRequest(), "req-a", h);

      cancelChat("req-a");
      expect(shared.invokeCalls).toContain("cancel_chat");

      // Rust 收到取消标记后补发的 done
      emit({ request_id: "req-a", done: true, cache_hit_tokens: 7, cache_miss_tokens: 2 });

      expect(h.onDone).toHaveBeenCalledTimes(1);
      expect(h.onDone).toHaveBeenCalledWith({ hit: 7, miss: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("宽限窗口过期后丢弃迟到事件，不回调已取消请求的 handler", async () => {
    vi.useFakeTimers();
    try {
      const { streamChat, cancelChat } = await loadTauri();
      const h = makeHandlers();
      await streamChat(makeRequest(), "req-a", h);

      cancelChat("req-a");
      vi.advanceTimersByTime(1000);

      emit({ request_id: "req-a", done: true });
      emit({ request_id: "req-a", done: false, content: "late" });

      expect(h.onDone).not.toHaveBeenCalled();
      expect(h.onToken).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
