// @vitest-environment jsdom
//
// stores/auto-summarize-submode.test.ts — 自动摘要不得依赖「当前子模式可见列表」
//
// 缺陷背景：`useConversationStore.conversations` 只是 `allConversations` 按当前
// 子模式过滤后的**可见视图**。用户在一个会话流式途中切到另一个子模式后，
// 该会话仍在 `allConversations` 里，但已不在 `conversations` 中。
// 旧实现的 `summarizeIfNeeded` 只查可见列表 → 摘要被静默跳过。
//
// 契约：
//   1. 会话只在 allConversations（不在可见 conversations）时，仍触发摘要并落盘；
//   2. allConversations 为空时回退可见列表（兼容测试/旧调用方注入方式）；
//   3. 两种路径都必须真的走到 updateSummary（完整流结束才落盘）。

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
import { useChatStore } from "./useChatStore";
import { useConversationStore } from "./useConversationStore";
import { useSettingsStore } from "./useSettingsStore";
import { useTaskStore } from "./useTaskStore";
import type { Conversation, ModelConfig } from "@/types";

const MODEL: ModelConfig = {
  name: "m1",
  provider: "openai",
  api_url: "http://127.0.0.1:1",
  api_key: "k",
  model: "m1",
};

const CONV_ID = "conv-lite";

function makeConv(messageCount = 15): Conversation {
  return {
    id: CONV_ID,
    title: "t",
    created_at: "2026-10-23T00:00:00.000Z",
    updated_at: "2026-10-23T00:00:00.000Z",
    model_name: MODEL.name,
    messages: Array.from({ length: messageCount }, (_, i) => ({
      id: `m${i}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `历史消息 ${i}`,
      timestamp: "2026-10-23T00:00:00.000Z",
    })),
  };
}

function streamOk(text: string) {
  vi.mocked(tauri.streamChat).mockImplementation(async (_req, _rid, h) => {
    h.onToken(text);
    h.onDone();
  });
}

beforeEach(() => {
  vi.mocked(tauri.streamChat).mockReset();
  vi.mocked(tauri.logDiag).mockReset();

  useSettingsStore.setState({ models: [MODEL], activeModel: MODEL.name } as never);
  useChatStore.setState({ workAutoSummarize: true, workTempMode: false } as never);
  // 任务队列替换为同步执行，避免真实 FIFO 的 120ms 轮询和跨用例 running 残留
  useTaskStore.setState({
    enqueue: async (
      _title: string,
      runner: (report: (pct: number, label?: string) => void) => Promise<string>
    ) => {
      await runner(() => {});
    },
  } as never);
  useConversationStore.setState({
    allConversations: [],
    conversations: [],
    workSubMode: "work",
    activeId: null,
    tabIds: [],
  } as never);
});

describe("summarizeIfNeeded 读取全量会话", () => {
  it("会话只在 allConversations（用户已切到另一子模式）时仍触发摘要", async () => {
    const conv = makeConv();
    useConversationStore.setState({
      allConversations: [conv],
      // 关键：可见列表为空 —— 模拟切到另一个子模式后的状态
      conversations: [],
    } as never);

    streamOk("跨模式摘要");

    await useChatStore.getState().summarizeIfNeeded(CONV_ID);

    const after = useConversationStore.getState().allConversations.find((c) => c.id === CONV_ID);
    expect(after?.summary).toBe("跨模式摘要");
    expect(after?.summary_msg_count).toBe(15);
  });

  it("allConversations 为空时回退可见列表（旧注入方式仍可用）", async () => {
    const conv = makeConv();
    useConversationStore.setState({
      allConversations: [],
      conversations: [conv],
    } as never);

    streamOk("回退摘要");

    await useChatStore.getState().summarizeIfNeeded(CONV_ID);

    const after = useConversationStore.getState().conversations.find((c) => c.id === CONV_ID);
    expect(after?.summary).toBe("回退摘要");
    expect(after?.summary_msg_count).toBe(15);
  });

  it("两个列表都没有该会话时不会发起摘要请求", async () => {
    useConversationStore.setState({
      allConversations: [makeConv()],
      conversations: [],
    } as never);
    streamOk("不该出现");

    await useChatStore.getState().summarizeIfNeeded("missing-id");

    expect(tauri.streamChat).not.toHaveBeenCalled();
  });
});
