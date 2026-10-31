// @vitest-environment jsdom
//
// lib/prompt-chain.test.ts — T-021 回归:
// prompt 链每一步的 {{input}} 必须换成上一步的**最终正文**。
//
// 旧实现：runPromptChain 在 `await send(...)` 后立刻读会话里最后一条 assistant
// 消息；而 sendMessage 的 Promise 在 finish() 调用的 updateMessage（先 await
// DB IPC 再 set）之前就 resolve 了 → 读到的是空占位，acc 不前进，第二步又把
// 第一步的输入发出去。
//
// 契约（新）：
//   1. sendMessage 只在最终正文写入会话 store 之后 resolve；
//   2. runPromptChain 直接使用 send 的返回值，不再猜「最后一条 assistant」。

import { describe, it, expect, vi, beforeEach } from "vitest";

/** 全量 mock tauri：所有 IPC 都是 vi.fn()，避免任何真实 invoke */
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const mocked: Record<string, unknown> = { ...actual };
  for (const key of Object.keys(actual)) {
    if (typeof (actual as Record<string, unknown>)[key] === "function") mocked[key] = vi.fn();
  }
  return mocked;
});

import * as tauri from "@/lib/tauri";
import { runPromptChain, type PromptChain } from "./prompt-chain";
import { useChatStore } from "@/stores/useChatStore";
import { useConversationStore } from "@/stores/useConversationStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import type { Conversation, ModelConfig } from "@/types";

// jsdom 不一定开 rAF；没有就补一个 0ms 的等价实现（流式合帧用）
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number) as typeof requestAnimationFrame;
}

const streamChat = vi.mocked(tauri.streamChat);

const MODEL: ModelConfig = {
  name: "m1",
  provider: "openai",
  api_url: "https://api.example/v1",
  api_key: "sk-test",
  model: "m1-model",
};

const CHAIN: PromptChain = {
  id: "two-step",
  name: "两步",
  description: "",
  steps: ["第一步：{{input}}", "第二步：{{input}}"],
};

function nowISO(): string {
  return "2026-10-31T00:00:00.000Z";
}

function seedConversation(): Conversation {
  const conv: Conversation = {
    id: "c1",
    title: "旧会话",
    created_at: nowISO(),
    updated_at: nowISO(),
    model_name: "m1",
    messages: [],
    work_mode: "work",
  };
  useConversationStore.setState({
    allConversations: [conv],
    conversations: [conv],
    activeId: conv.id,
    tabIds: [conv.id],
    activeByMode: { chat: null, work: conv.id },
    tabsByMode: { chat: [], work: [conv.id] },
    workSubMode: "work",
    loaded: true,
  });
  return conv;
}

function assistantContents(): string[] {
  const conv = useConversationStore.getState().allConversations.find((c) => c.id === "c1");
  return (conv?.messages ?? []).filter((m) => m.role === "assistant").map((m) => m.content);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  streamChat.mockReset();
  // 落库 IPC：正文写入故意延迟 10ms —— 旧实现「未 await 就 resolve」在此必现空占位
  vi.mocked(tauri.dbCreateConv).mockResolvedValue(undefined);
  vi.mocked(tauri.dbBatchAddMessages).mockResolvedValue(undefined);
  vi.mocked(tauri.dbAddMsg).mockResolvedValue(undefined);
  vi.mocked(tauri.dbUpdateMsgContent).mockImplementation(
    () => new Promise((resolve) => setTimeout(resolve, 10))
  );
  vi.mocked(tauri.dbUpdateMsgReasoning).mockResolvedValue(undefined);
  vi.mocked(tauri.dbUpdateMsgError).mockResolvedValue(undefined);

  useSettingsStore.setState({
    models: [MODEL],
    activeModel: "m1",
    regexRules: [],
    budgetConfig: { mode: "manual", usage_pct: 90, default_context_window: 8192 },
    defaultParameters: {},
    samplerPresets: [],
    stoppingStrings: [],
    thinkingEnabled: false,
    reasoningEffort: "high",
  });
  useChatStore.setState({
    isStreaming: false,
    streamingContent: {},
    streamingReasoning: {},
    streamErrors: {},
    streamErrorKinds: {},
    activeStreams: [],
    streamMsgMap: {},
    compressingConvIds: [],
    workAutoSummarize: false,
    workTempMode: false,
  });
  seedConversation();
});

describe("T-021 prompt 链取上一步最终正文", () => {
  it("第二步的 {{input}} 是第一步的最终正文（不是空占位）", async () => {
    const sent: string[] = [];
    streamChat.mockImplementation(async (req, _rid, h) => {
      const last = req.messages[req.messages.length - 1];
      sent.push(last?.content ?? "");
      h.onToken(sent.length === 1 ? "第一段回答" : "第二段回答");
      h.onDone();
    });

    const result = await runPromptChain(CHAIN, "原始输入", (content) =>
      useChatStore.getState().sendMessage(content, [MODEL])
    );

    expect(sent[0]).toBe("第一步：原始输入");
    expect(sent[1]).toBe("第二步：第一段回答");
    expect(result).toBe("第二段回答");
    // 发送 Promise resolve 时正文已经进 store（不是空占位）
    expect(assistantContents()).toEqual(["第一段回答", "第二段回答"]);
  });

  it("sendMessage 的 Promise 在正文落库完成后才 resolve", async () => {
    streamChat.mockImplementation(async (_req, _rid, h) => {
      h.onToken("最终正文");
      h.onDone();
    });

    const text = await useChatStore.getState().sendMessage("问", [MODEL]);

    expect(text).toBe("最终正文");
    expect(assistantContents()).toEqual(["最终正文"]);
  });

  it("某步没有正文时 {{input}} 保持上一步输入（不变成空字符串）", async () => {
    const sent: string[] = [];
    const result = await runPromptChain(CHAIN, "原始", async (content) => {
      sent.push(content);
      return "";
    });

    expect(sent[0]).toBe("第一步：原始");
    expect(sent[1]).toBe("第二步：原始");
    expect(result).toBe("原始");
  });
});
