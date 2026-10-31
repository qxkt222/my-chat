// @vitest-environment jsdom
//
// ChatInput 发送门闩 + 会话钉死（T-034）回归。
//
// 旧实现：RAG / rerank / 技能工具等 await 都发生在 isStreaming 置位之前，
// 预处理期间输入框仍可编辑，用户可以并发进入两条 sendMessage；第二条按
// 「当前」activeId 取会话 —— 期间切过会话就会把消息写进另一个会话。
//
// 契约：
//   1. handleSend 起始同步置 sendingRef 门闩，预处理期间第二次发送直接拒绝；
//   2. 预处理期间输入框禁用（用户改不了内容、点不了发送）；
//   3. 预处理开始时钉住 convId 并传给 sendMessage —— 期间切换 activeId
//      不影响消息落点，也不影响本轮 system prompt。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

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
import { ChatInput } from "./ChatInput";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { useChatStore } from "@/stores/useChatStore";
import { useConversationStore } from "@/stores/useConversationStore";
import { useKnowledgeStore } from "@/stores/useKnowledgeStore";
import { useMemoryStore } from "@/stores/useMemoryStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useSkillStore } from "@/stores/useSkillStore";
import { t } from "@/lib/i18n";
import type { Conversation, ModelConfig } from "@/types";
import type { RagResult } from "@/lib/tauri";

const MODEL: ModelConfig = {
  name: "m1",
  provider: "openai",
  api_url: "http://127.0.0.1:1",
  api_key: "k",
  model: "m1",
};

function nowISO(): string {
  return "2026-10-31T00:00:00.000Z";
}

function makeConv(id: string, systemPrompt = ""): Conversation {
  return {
    id,
    title: id,
    created_at: nowISO(),
    updated_at: nowISO(),
    model_name: "m1",
    system_prompt: systemPrompt,
    messages: [],
    work_mode: "work",
  };
}

function seedConversations(...convs: Conversation[]) {
  const first = convs[0];
  if (!first) throw new Error("至少一个会话");
  useConversationStore.setState({
    allConversations: convs,
    conversations: convs,
    activeId: first.id,
    tabIds: convs.map((c) => c.id),
    activeByMode: { chat: null, work: first.id },
    tabsByMode: { chat: [], work: convs.map((c) => c.id) },
    workSubMode: "work",
    loaded: true,
  });
}

function convOf(id: string): Conversation | undefined {
  return useConversationStore.getState().allConversations.find((c) => c.id === id);
}

/** 可手动放行的 RAG 检索 —— 把「预处理期间」这个时间窗拉长 */
function deferredRag() {
  let release: (v: RagResult[]) => void = () => {};
  vi.mocked(tauri.ragSearch).mockImplementation(
    () =>
      new Promise<RagResult[]>((resolve) => {
        release = resolve;
      })
  );
  return (v: RagResult[] = []) => release(v);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  // jsdom 没有实现 Element.scrollTo（@ 菜单挂载时会用到）
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;

  vi.mocked(tauri.ragSearch).mockReset().mockResolvedValue([]);
  vi.mocked(tauri.ragRerank).mockReset().mockResolvedValue([]);
  vi.mocked(tauri.mcpListServers).mockReset().mockResolvedValue([]);
  vi.mocked(tauri.mcpListLiteTools).mockReset().mockResolvedValue([]);
  vi.mocked(tauri.dbCreateConv).mockResolvedValue(undefined);
  vi.mocked(tauri.dbBatchAddMessages).mockResolvedValue(undefined);
  vi.mocked(tauri.dbAddMsg).mockResolvedValue(undefined);
  vi.mocked(tauri.dbUpdateMsgContent).mockResolvedValue(undefined);
  vi.mocked(tauri.dbUpdateMsgReasoning).mockResolvedValue(undefined);
  vi.mocked(tauri.dbUpdateMsgError).mockResolvedValue(undefined);
  vi.mocked(tauri.streamChat).mockImplementation(async (_req, _rid, h) => {
    h.onToken("回答");
    h.onDone();
  });

  useAppModeStore.setState({ mode: "work", workSubMode: "work" } as never);
  useSettingsStore.setState({
    models: [MODEL],
    activeModel: MODEL.name,
    globalInstruction: "",
    projectInstructions: [],
    modelWrappers: [],
    defaultParameters: {},
    budgetConfig: { mode: "manual", usage_pct: 90, default_context_window: 8192 },
    regexRules: [],
    stoppingStrings: [],
    thinkingEnabled: false,
    reasoningEffort: "high",
  } as never);
  useSkillStore.setState({ skills: [], activeSkillId: null } as never);
  useKnowledgeStore.setState({
    activeBaseId: "kb1",
    bases: [{ id: "kb1", name: "KB", description: "", created_at: nowISO() }],
  } as never);
  useMemoryStore.setState({ memories: [], byTags: () => "" } as never);
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
});

afterEach(cleanup);

async function enableRagAndType(text: string) {
  fireEvent.click(screen.getByTitle(t("chat.ragOff")));
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value: text } });
  return box;
}

describe("T-034 发送门闩", () => {
  it("预处理期间并发两次 handleSend：第二次被门闩拒绝", async () => {
    seedConversations(makeConv("c1"));
    const release = deferredRag();
    render(<ChatInput />);
    const box = await enableRagAndType("第一句");

    // 同一渲染周期内连按两次 Enter：第二次必须被同步门闩挡下
    await act(async () => {
      const enter = () => new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
      box.dispatchEvent(enter());
      box.dispatchEvent(enter());
    });

    await waitFor(() => expect(tauri.ragSearch).toHaveBeenCalledTimes(1));
    // 预处理期间输入框禁用（用户无法改内容再发）
    expect((box as HTMLTextAreaElement).disabled).toBe(true);

    await act(async () => {
      release([]);
    });

    await waitFor(() => expect(tauri.streamChat).toHaveBeenCalledTimes(1));
    // 只发出了一轮：一条 user + 一条 assistant
    const conv = convOf("c1");
    expect(conv?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(tauri.ragSearch).toHaveBeenCalledTimes(1);
  });

  it("预处理期间切换 activeId：消息仍写入钉住的 convId", async () => {
    seedConversations(makeConv("c1", "PROMPT_C1"), makeConv("c2", "PROMPT_C2"));
    const release = deferredRag();
    const sent: { system: string | undefined; lastUser: string | undefined }[] = [];
    vi.mocked(tauri.streamChat).mockImplementation(async (req, _rid, h) => {
      const last = req.messages[req.messages.length - 1];
      sent.push({ system: req.system_prompt, lastUser: last?.content });
      h.onToken("回答");
      h.onDone();
    });

    render(<ChatInput />);
    const box = await enableRagAndType("问题");

    fireEvent.click(screen.getByTitle(t("chat.sendTitle")));
    await waitFor(() => expect(tauri.ragSearch).toHaveBeenCalledTimes(1));

    // 预处理还在进行，用户切到另一个会话
    act(() => {
      useConversationStore.getState().setActive("c2");
    });
    expect(useConversationStore.getState().activeId).toBe("c2");

    await act(async () => {
      release([]);
    });

    await waitFor(() => expect(tauri.streamChat).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(convOf("c1")?.messages).toHaveLength(2));

    // 落点在钉住的 c1，而不是当前 activeId=c2
    expect(convOf("c1")?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(convOf("c2")?.messages).toHaveLength(0);
    // 本轮 system prompt 也来自钉住的会话
    expect(sent[0]?.system).toBe("PROMPT_C1");
    expect(sent[0]?.lastUser).toBe("问题");
    expect((box as HTMLTextAreaElement).value).toBe("");
  });
});
