// @vitest-environment jsdom
//
// stores/chat-compress-regenerate.test.ts — T-019 / T-020 回归。
//
// T-019 压缩上下文期间:
//   1. compressContext 必须置忙碌状态（compressingConvIds），期间 sendMessage
//      对该会话直接拒绝并提示；
//   2. 压缩完成时若消息数已变化，replaceMessages 只替换被压缩的基线区间，
//      压缩期间新增的消息不得被清空。
//
// T-020 重新生成:
//   3. isStreaming 时 regenerate 直接返回，不产生第二条流、不删活跃占位；
//      （含带 msgId 的路径）
//   4. 模型为空时先校验再删：上一条回复原样保留；
//   5. regenerate(msgId) 只删除/重生成目标 assistant 消息，其他消息不受影响。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Conversation, Message, ModelConfig } from "@/types";
import type { SummarizeResult } from "@/lib/summarize";

/** 全量 mock tauri：所有 IPC 都是 vi.fn()，避免任何真实 invoke */
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const mocked: Record<string, unknown> = { ...actual };
  for (const key of Object.keys(actual)) {
    if (typeof (actual as Record<string, unknown>)[key] === "function") mocked[key] = vi.fn();
  }
  return mocked;
});

// 可控摘要调用：制造「压缩进行中」的 await 窗口
vi.mock("@/lib/summarize", () => ({
  SUMMARIZE_THRESHOLD: 15,
  runSummarize: vi.fn(),
}));

// Toast 只做提示，测试里断言调用即可（避免真实 DOM 依赖）
vi.mock("@/components/ui/Toast", () => ({ showToast: vi.fn() }));

import * as tauri from "@/lib/tauri";
import { runSummarize } from "@/lib/summarize";
import { showToast } from "@/components/ui/Toast";
import { useChatStore } from "./useChatStore";
import { useConversationStore } from "./useConversationStore";
import { useSettingsStore } from "./useSettingsStore";
import { t } from "@/lib/i18n";

// jsdom 不一定开 rAF；没有就补一个 0ms 的等价实现（sendMessage 合帧用）
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number) as typeof requestAnimationFrame;
}

const CONV_ID = "conv-hotfix";
const MODEL: ModelConfig = {
  name: "m1",
  provider: "openai",
  api_url: "http://127.0.0.1:1",
  api_key: "k",
  model: "m1-model",
};
const MODEL2: ModelConfig = { ...MODEL, name: "m2", model: "m2-model" };

function nowISO(): string {
  return new Date().toISOString();
}

function msg(id: string, role: Message["role"], content: string, model?: string): Message {
  return { id, role, content, timestamp: nowISO(), ...(model ? { model } : {}) };
}

function makeConv(messages: Message[]): Conversation {
  return {
    id: CONV_ID,
    title: "t",
    created_at: nowISO(),
    updated_at: nowISO(),
    model_name: MODEL.name,
    messages,
    work_mode: "work",
  };
}

function seed(conv: Conversation) {
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
}

function currentConv(): Conversation {
  const conv = useConversationStore.getState().allConversations.find((c) => c.id === CONV_ID);
  if (!conv) throw new Error("会话不存在");
  return conv;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(tauri.dbAddMsg).mockResolvedValue(undefined);
  vi.mocked(tauri.dbCreateConv).mockResolvedValue(undefined);
  vi.mocked(tauri.dbBatchAddMessages).mockResolvedValue(undefined);
  vi.mocked(tauri.dbClearMessages).mockResolvedValue(undefined);
  vi.mocked(tauri.dbRenameConv).mockResolvedValue(undefined);
  vi.mocked(tauri.dbDeleteLastAsmMsg).mockResolvedValue(undefined);
  vi.mocked(tauri.dbUpdateMsgContent).mockResolvedValue(undefined);
  vi.mocked(tauri.dbUpdateMsgReasoning).mockResolvedValue(undefined);
  vi.mocked(tauri.dbUpdateMsgError).mockResolvedValue(undefined);
  vi.mocked(runSummarize).mockReset();

  useSettingsStore.setState({
    models: [MODEL, MODEL2],
    activeModel: MODEL.name,
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
  useConversationStore.setState({
    allConversations: [],
    conversations: [],
    activeId: null,
    tabIds: [],
    activeByMode: { chat: null, work: null },
    tabsByMode: { chat: [], work: [] },
    workSubMode: "work",
    loaded: true,
  });
});

describe("T-019 压缩上下文期间的并发保护", () => {
  it("压缩进行中 sendMessage 被拒绝，且不产生新流/新消息", async () => {
    seed(makeConv([msg("u1", "user", "问题一"), msg("a1", "assistant", "回答一")]));
    const gate = deferred<SummarizeResult>();
    vi.mocked(runSummarize).mockReturnValue(gate.promise);

    const compressing = useChatStore.getState().compressContext();
    // 忙碌标志在进入 runSummarize 之前就已置位
    expect(useChatStore.getState().compressingConvIds).toContain(CONV_ID);

    await useChatStore.getState().sendMessage("压缩期间发送", [MODEL]);

    expect(tauri.streamChat).not.toHaveBeenCalled();
    expect(tauri.dbBatchAddMessages).not.toHaveBeenCalled();
    // 压缩开始的提示 + 拒绝发送的提示
    expect(
      vi.mocked(showToast).mock.calls.filter((c) => c[1] === t("chat.compressing"))
    ).toHaveLength(2);

    gate.resolve({ summary: "压缩摘要", complete: true });
    await compressing;
    expect(useChatStore.getState().compressingConvIds).not.toContain(CONV_ID);
  });

  it("压缩完成时消息数已变化：新消息合并保留，不被 replaceMessages 清空", async () => {
    seed(makeConv([msg("u1", "user", "问题一"), msg("a1", "assistant", "回答一")]));
    const gate = deferred<SummarizeResult>();
    vi.mocked(runSummarize).mockReturnValue(gate.promise);

    const compressing = useChatStore.getState().compressContext();
    expect(useChatStore.getState().compressingConvIds).toContain(CONV_ID);

    // 模拟压缩期间斜杠命令直接落库（sendMessage 已被拒绝，但 addMessage 仍可达）
    await useConversationStore.getState().addMessage(CONV_ID, msg("u2", "user", "压缩中新消息"));
    expect(currentConv().messages).toHaveLength(3);

    gate.resolve({ summary: "压缩摘要", complete: true });
    await compressing;

    const messages = currentConv().messages;
    // 摘要种子 + 压缩期间新增的消息，两者都在
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]?.content).toContain("压缩摘要");
    expect(messages.some((m) => m.content === "压缩中新消息")).toBe(true);
    expect(messages).toHaveLength(2);

    // 落库 payload 同样包含新消息（不是只写摘要种子）
    const rewrite = vi
      .mocked(tauri.dbBatchAddMessages)
      .mock.calls.find((c) => c[1]?.some((m) => m.content === "压缩中新消息"));
    expect(rewrite).toBeTruthy();
    expect(rewrite?.[1]).toHaveLength(2);
    expect(vi.mocked(tauri.dbClearMessages)).toHaveBeenCalledWith(CONV_ID);
  });
});

describe("T-020 regenerate 守卫与消息定位", () => {
  it("isStreaming 时 regenerate（含 msgId）不产生新流、不删占位", async () => {
    seed(makeConv([msg("u1", "user", "问题一"), msg("a1", "assistant", "回答一")]));
    useChatStore.setState({ isStreaming: true });

    await useChatStore.getState().regenerate();
    await useChatStore.getState().regenerate("a1");

    expect(tauri.streamChat).not.toHaveBeenCalled();
    expect(tauri.dbDeleteLastAsmMsg).not.toHaveBeenCalled();
    expect(tauri.dbClearMessages).not.toHaveBeenCalled();
    expect(currentConv().messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("模型为空时 regenerate 先校验再删：上一条回复原样保留", async () => {
    seed(makeConv([msg("u1", "user", "问题一"), msg("a1", "assistant", "回答一")]));
    useSettingsStore.setState({ models: [], activeModel: "" });

    await useChatStore.getState().regenerate();
    await useChatStore.getState().regenerate("a1");

    expect(tauri.streamChat).not.toHaveBeenCalled();
    expect(tauri.dbDeleteLastAsmMsg).not.toHaveBeenCalled();
    expect(tauri.dbClearMessages).not.toHaveBeenCalled();
    expect(currentConv().messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("regenerate(msgId) 只删除/重生成目标 assistant，其余消息不受影响", async () => {
    seed(
      makeConv([
        msg("u1", "user", "问题一"),
        msg("a1", "assistant", "回答一", "m1"),
        msg("u2", "user", "问题二"),
        msg("a2", "assistant", "回答二", "m2"),
      ])
    );
    const requests: { model_config: { model: string } }[] = [];
    vi.mocked(tauri.streamChat).mockImplementation(async (req, _rid, h) => {
      requests.push(req as unknown as { model_config: { model: string } });
      h.onToken("新回答");
      h.onDone();
    });

    await useChatStore.getState().regenerate("a1");

    const messages = currentConv().messages;
    expect(messages.some((m) => m.id === "a1")).toBe(false);
    expect(messages.some((m) => m.id === "a2")).toBe(true);
    expect(messages.some((m) => m.id === "u1")).toBe(true);
    expect(messages.some((m) => m.id === "u2")).toBe(true);
    expect(messages.find((m) => m.id === "a2")?.content).toBe("回答二");

    // 用目标气泡自己的模型重新生成
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model_config.model).toBe(MODEL.model);
    expect(messages[messages.length - 1]?.role).toBe("assistant");
    expect(messages[messages.length - 1]?.content).toBe("新回答");

    // 非尾部消息走「重写剩余消息」：payload 含 a2、不含 a1
    const rewrite = vi
      .mocked(tauri.dbBatchAddMessages)
      .mock.calls.find((c) => c[1]?.some((m) => m.id === "a2"));
    expect(rewrite).toBeTruthy();
    expect(rewrite?.[1]?.some((m) => m.id === "a1")).toBe(false);
  });

  it("无 msgId 保持旧行为：只重生成最后一轮 assistant", async () => {
    seed(
      makeConv([
        msg("u1", "user", "问题一"),
        msg("a1", "assistant", "回答一", "m1"),
        msg("u2", "user", "问题二"),
        msg("a2", "assistant", "回答二", "m1"),
      ])
    );
    vi.mocked(tauri.streamChat).mockImplementation(async (_req, _rid, h) => {
      h.onToken("重生成");
      h.onDone();
    });

    await useChatStore.getState().regenerate();

    const messages = currentConv().messages;
    expect(messages.some((m) => m.id === "a1")).toBe(true); // 上一轮保留
    expect(messages.some((m) => m.id === "a2")).toBe(false); // 最后一轮被替换
    expect(tauri.dbDeleteLastAsmMsg).toHaveBeenCalledWith(CONV_ID);
  });
});
