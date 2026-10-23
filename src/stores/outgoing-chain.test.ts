// @vitest-environment jsdom
// stores/outgoing-chain.test.ts — Wave C2 三条链路接入的集成证据
//
// 这里验证的是「链路真的接上了」，不是纯函数本身：
//   1. 工作模式 / 推演模式发送前都会走 prepareOutgoingMessages：
//      placement=2 的规则清理的是**待发副本**，conv.messages 原样不动。
//   2. 三个 summarizeIfNeeded 只在 runSummarize 返回 complete=true 且摘要非空时落盘；
//      流中断（半截内容）不得覆盖已有摘要。
//   3. 工作模式 onToken 的 rAF 合帧：token 在 onDone 之前就应出现在 streamingContent。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  CharacterCard,
  Conversation,
  ModelConfig,
  SimulationConversation,
  TavernConversation,
} from "@/types";

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
import { useSimulationStore } from "./useSimulationStore";
import { useTavernStore } from "./useTavernStore";
import { useCharacterStore } from "./useCharacterStore";
import type { RegexRule } from "@/lib/regex-format";

// jsdom 不一定开 rAF；没有就补一个 0ms 的等价实现
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

/** placement=2：只清出站，不动显示 */
const TAG_RULE: RegexRule = {
  id: "out-tag",
  name: "出站清理",
  pattern: "\\s*<internal_states>[\\s\\S]*?</internal_states>",
  replacement: "",
  enabled: true,
  flags: "g",
  placement: [2],
};

function nowISO(): string {
  return new Date().toISOString();
}

function makeConv(content: string, messageCount = 1): Conversation {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    id: `u${i}`,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: i === 0 ? content : `历史消息 ${i}`,
    timestamp: nowISO(),
  }));
  return {
    id: "c1",
    title: "t",
    created_at: nowISO(),
    updated_at: nowISO(),
    model_name: "m1",
    messages,
  };
}

function makeSimConv(content: string, messageCount = 1): SimulationConversation {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    id: `s${i}`,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: i === 0 ? content : `推演内容 ${i}`,
    timestamp: nowISO(),
  }));
  return {
    id: "s1",
    title: "sim",
    created_at: nowISO(),
    updated_at: nowISO(),
    messages,
    type: "story",
    stateMode: "none",
    pacing: "turn",
    stateUpdate: "inline",
    autoRounds: 1,
    setup: "",
    worldState: "",
    stateTable: {},
    timeLabel: "",
    timeline: [],
    model_name: "m1",
  };
}

function makeTavernConv(content: string, messageCount = 1): TavernConversation {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    id: `t${i}`,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: i === 0 ? content : `角色回复 ${i}`,
    timestamp: nowISO(),
  }));
  return {
    id: "tavern1",
    character_id: "char1",
    character_name: "角色",
    model_name: "m1",
    title: "tavern",
    created_at: nowISO(),
    updated_at: nowISO(),
    messages,
  };
}

beforeEach(() => {
  streamChat.mockReset();
  vi.mocked(tauri.getAppDir).mockResolvedValue("C:/tmp/app");
  vi.mocked(tauri.listDir).mockResolvedValue([]);
  vi.mocked(tauri.writeFile).mockResolvedValue(undefined);
  vi.mocked(tauri.memSearch).mockResolvedValue([]);

  useSettingsStore.setState({
    models: [MODEL],
    activeModel: "m1",
    regexRules: [TAG_RULE],
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
    workAutoSummarize: false,
    workTempMode: false,
  });
  useConversationStore.setState({ conversations: [], activeId: null, tabIds: [], loaded: true });
  useSimulationStore.setState({
    conversations: [],
    activeId: null,
    isStreaming: false,
    isSyncing: false,
    activeRequestId: null,
    autoSummarize: false,
    cancelRounds: false,
    loaded: true,
  });
  useTavernStore.setState({
    conversations: [],
    activeId: null,
    isStreaming: false,
    activeRequestId: null,
    autoSummarize: false,
    loaded: true,
  });
});

describe("出站正则接入：工作模式 / 推演模式", () => {
  it("工作模式：placement=2 规则清理待发副本，conv.messages 原样保留", async () => {
    const conv = makeConv("旧回复 <internal_states>不该发给模型</internal_states>");
    useConversationStore.setState({ conversations: [conv], activeId: "c1", tabIds: ["c1"] });

    const sentContents: string[] = [];
    let sawFlushedToken = false;
    streamChat.mockImplementation(async (req, rid, h) => {
      sentContents.push(...req.messages.map((m) => m.content));
      h.onToken("回答");
      // rAF 合帧：onDone 之前 streamingContent 应已更新（若合帧被删，这里为 false）
      await new Promise((r) => setTimeout(r, 40));
      sawFlushedToken = (useChatStore.getState().streamingContent[rid] || "").includes("回答");
      h.onDone();
    });

    await useChatStore.getState().sendMessage("继续", [MODEL]);

    expect(sentContents[0]).toBe("旧回复");
    expect(sentContents[0]).not.toContain("internal_states");
    // 显示侧（会话原文）不受影响
    const stored = useConversationStore.getState().conversations[0]?.messages[0]?.content;
    expect(stored).toContain("internal_states");
    expect(sawFlushedToken).toBe(true);
  });

  it("推演模式：placement=2 规则清理待发副本，conv.messages 原样保留", async () => {
    const conv = makeSimConv("世界 <internal_states>状态泄漏</internal_states>");
    useSimulationStore.setState({ conversations: [conv], activeId: "s1" });

    const sentContents: string[] = [];
    streamChat.mockImplementation(async (req, _rid, h) => {
      sentContents.push(...req.messages.map((m) => m.content));
      h.onToken("推进");
      h.onDone();
    });

    await useSimulationStore.getState().sendMessage("行动");

    const history = sentContents.find((c) => c.startsWith("世界"));
    expect(history).toBe("世界");
    const stored = useSimulationStore.getState().conversations[0]?.messages[0]?.content;
    expect(stored).toContain("internal_states");
  });
});

describe("摘要落盘守卫：complete=true 且非空", () => {
  it("工作模式：完整摘要落盘并记账消息数", async () => {
    useChatStore.setState({ workAutoSummarize: true, workTempMode: false });
    const conv = makeConv("x", 15);
    useConversationStore.setState({ conversations: [conv], activeId: "c1", tabIds: ["c1"] });

    streamChat.mockImplementation(async (_req, _rid, h) => {
      h.onToken(" 新摘要 ");
      h.onDone();
    });

    await useChatStore.getState().summarizeIfNeeded("c1");

    const after = useConversationStore.getState().conversations.find((c) => c.id === "c1");
    expect(after?.summary).toBe("新摘要");
    expect(after?.summary_msg_count).toBe(15);
  });

  it("工作模式：流中断（半截内容）不落盘，旧摘要不被覆盖", async () => {
    useChatStore.setState({ workAutoSummarize: true, workTempMode: false });
    const conv = { ...makeConv("x", 15), summary: "旧摘要", summary_msg_count: 0 };
    useConversationStore.setState({ conversations: [conv], activeId: "c1", tabIds: ["c1"] });

    streamChat.mockImplementation(async (_req, _rid, h) => {
      h.onToken("半截");
      h.onError("stream aborted");
    });

    await useChatStore.getState().summarizeIfNeeded("c1");

    const after = useConversationStore.getState().conversations.find((c) => c.id === "c1");
    expect(after?.summary).toBe("旧摘要");
    expect(after?.summary_msg_count).toBe(0);
    expect(vi.mocked(tauri.logDiag)).toHaveBeenCalled();
  });

  it("酒馆：完整摘要落盘；中断时不落盘", async () => {
    useTavernStore.setState({
      autoSummarize: true,
      conversations: [makeTavernConv("y", 15)],
      activeId: "tavern1",
    });

    streamChat.mockImplementation(async (_req, _rid, h) => {
      h.onToken("酒馆摘要");
      h.onDone();
    });
    await useTavernStore.getState().summarizeIfNeeded("tavern1");
    expect(useTavernStore.getState().conversations[0]?.summary).toBe("酒馆摘要");

    // 再来一次中断：不应覆盖
    streamChat.mockReset();
    streamChat.mockImplementation(async (_req, _rid, h) => {
      h.onToken("半截");
      h.onError("boom");
    });
    const conv = useTavernStore.getState().conversations[0];
    if (!conv) throw new Error("酒馆会话缺失");
    useTavernStore.setState({
      conversations: [{ ...conv, summary_msg_count: 0 }],
    });
    await useTavernStore.getState().summarizeIfNeeded("tavern1");
    expect(useTavernStore.getState().conversations[0]?.summary).toBe("酒馆摘要");
  });

  it("推演：完整摘要落盘；中断时不落盘", async () => {
    useSimulationStore.setState({
      autoSummarize: true,
      conversations: [makeSimConv("z", 15)],
      activeId: "s1",
    });

    streamChat.mockImplementation(async (_req, _rid, h) => {
      h.onToken("推演摘要");
      h.onDone();
    });
    await useSimulationStore.getState().summarizeIfNeeded("s1");
    expect(useSimulationStore.getState().conversations[0]?.summary).toBe("推演摘要");

    streamChat.mockReset();
    streamChat.mockImplementation(async (_req, _rid, h) => {
      h.onToken("半截");
      h.onError("boom");
    });
    const conv = useSimulationStore.getState().conversations[0];
    if (!conv) throw new Error("推演会话缺失");
    useSimulationStore.setState({ conversations: [{ ...conv, summary_msg_count: 0 }] });
    await useSimulationStore.getState().summarizeIfNeeded("s1");
    expect(useSimulationStore.getState().conversations[0]?.summary).toBe("推演摘要");
  });
});

describe("工作模式：当前用户输入必须进入待发 payload", () => {
  type Sent = { role: string; content: string }[];

  function captureSends(): Sent[] {
    const payloads: Sent[] = [];
    streamChat.mockImplementation(async (req, _rid, h) => {
      payloads.push(req.messages.map((m) => ({ role: m.role, content: m.content })));
      h.onToken("ok");
      h.onDone();
    });
    return payloads;
  }

  function card(): CharacterCard {
    return {
      id: "char1",
      specVersion: "2",
      name: "角色",
      description: "一个角色",
      personality: "",
      scenario: "",
      first_mes: "",
      mes_example: "",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: [],
      creator: "",
      character_version: "",
      avatarPath: "",
      created_at: nowISO(),
      updated_at: nowISO(),
    };
  }

  it("普通会话：payload 末尾恰好一条当前 user 消息", async () => {
    const conv = makeConv("历史一");
    useConversationStore.setState({ conversations: [conv], activeId: "c1", tabIds: ["c1"] });
    const payloads = captureSends();

    await useChatStore.getState().sendMessage("本次输入", [MODEL]);

    expect(payloads).toHaveLength(1);
    const msgs = payloads[0] ?? [];
    const current = msgs.filter((m) => m.role === "user" && m.content === "本次输入");
    expect(current).toHaveLength(1); // 不能重复追加
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "本次输入" });
    // 历史仍然在
    expect(msgs.some((m) => m.content === "历史一")).toBe(true);
  });

  it("普通会话：内部标签被出站正则清理后再发送（用 processedContent）", async () => {
    const conv = makeConv("历史一");
    useConversationStore.setState({ conversations: [conv], activeId: "c1", tabIds: ["c1"] });
    const payloads = captureSends();

    await useChatStore
      .getState()
      .sendMessage("本次<internal_states>泄漏</internal_states>输入", [MODEL]);

    const msgs = payloads[0] ?? [];
    expect(msgs[msgs.length - 1]?.content).toBe("本次输入");
  });

  it("RP 会话：当前 user 消息在三段式之后，且不破坏世界书/摘要位置", async () => {
    const conv = {
      ...makeConv("历史一"),
      character_id: "char1",
      summary: "旧摘要",
    };
    useConversationStore.setState({ conversations: [conv], activeId: "c1", tabIds: ["c1"] });
    useCharacterStore.setState({ characters: [card()], personas: [] });
    const payloads = captureSends();

    await useChatStore.getState().sendMessage("RP本次输入", [MODEL]);

    const msgs = payloads[0] ?? [];
    const userIdx = msgs.findIndex((m) => m.role === "user" && m.content === "RP本次输入");
    const summaryIdx = msgs.findIndex((m) => m.content.startsWith("【对话摘要】"));
    expect(userIdx).toBeGreaterThan(-1);
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(summaryIdx); // 历史/摘要都在当前输入之前
    expect(userIdx).toBe(msgs.length - 1); // 没有变量尾段时位于末尾
  });

  it("skipUserAppend（重新生成）：不额外追加，历史中的那条只出现一次", async () => {
    const conv = {
      ...makeConv("历史一"),
      messages: [
        { id: "u0", role: "user" as const, content: "历史一", timestamp: nowISO() },
        { id: "u1", role: "assistant" as const, content: "回复", timestamp: nowISO() },
        { id: "u2", role: "user" as const, content: "上一轮", timestamp: nowISO() },
      ],
    };
    useConversationStore.setState({ conversations: [conv], activeId: "c1", tabIds: ["c1"] });
    const payloads = captureSends();

    await useChatStore.getState().sendMessage("上一轮", [MODEL], undefined, undefined, {
      skipUserAppend: true,
    });

    const msgs = payloads[0] ?? [];
    expect(msgs.filter((m) => m.role === "user" && m.content === "上一轮")).toHaveLength(1);
  });

  it("多模型（一问多答）：每个模型的 payload 都含当前 user", async () => {
    const conv = makeConv("历史一");
    useConversationStore.setState({ conversations: [conv], activeId: "c1", tabIds: ["c1"] });
    const model2: ModelConfig = { ...MODEL, name: "m2", model: "m2-model" };
    const payloads = captureSends();

    await useChatStore.getState().sendMessage("并发输入", [MODEL, model2]);

    expect(payloads).toHaveLength(2);
    for (const msgs of payloads) {
      expect(msgs.filter((m) => m.role === "user" && m.content === "并发输入")).toHaveLength(1);
      expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "并发输入" });
    }
  });

  it("知识库上下文仍在当前 user 之后（变量尾）", async () => {
    const conv = makeConv("历史一");
    useConversationStore.setState({ conversations: [conv], activeId: "c1", tabIds: ["c1"] });
    const payloads = captureSends();

    await useChatStore.getState().sendMessage("知识问题", [MODEL], undefined, "知识片段");

    const msgs = payloads[0] ?? [];
    const userIdx = msgs.findIndex((m) => m.role === "user" && m.content === "知识问题");
    const kbIdx = msgs.findIndex((m) => m.content === "Reference Knowledge:\n知识片段");
    expect(userIdx).toBeGreaterThan(-1);
    expect(kbIdx).toBe(userIdx + 1); // user 之后紧跟变量尾段
    expect(msgs[msgs.length - 1]?.content).toContain("知识片段");
  });
});
