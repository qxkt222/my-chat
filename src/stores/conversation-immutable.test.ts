// @vitest-environment jsdom
//
// stores/conversation-immutable.test.ts — T-035 回归:
// 会话消息必须走不可变更新。
//
// 旧实现 addMessage / addMessagesBatch 用 `conv.messages.push(...)` 原地改数组，
// 只替换 conversations 外层数组。ChatView 的
// messages → displayMessages → filteredMessages → rows 全链 useMemo 依赖
// `conv.messages` 引用，引用没变 → 斜杠命令 / 分叉后的消息不进 rows，
// 界面要等到下一次流式或切会话才补显示。
//
// 契约：每次写消息后
//   - conversations（以及 allConversations）是新数组；
//   - 目标 conv 对象是新对象；
//   - conv.messages 是新数组，旧数组内容不被原地修改。

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
import { useConversationStore } from "./useConversationStore";
import type { Conversation, Message } from "@/types";

function nowISO(): string {
  return "2026-10-31T00:00:00.000Z";
}

function msg(id: string, role: Message["role"], content: string): Message {
  return { id, role, content, timestamp: nowISO() };
}

function seed(messages: Message[] = []): Conversation {
  const conv: Conversation = {
    id: "c1",
    title: "标题",
    created_at: nowISO(),
    updated_at: nowISO(),
    model_name: "m1",
    messages,
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

function convById(id = "c1"): Conversation | undefined {
  return useConversationStore.getState().conversations.find((c) => c.id === id);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(tauri.dbCreateConv).mockResolvedValue(undefined);
  vi.mocked(tauri.dbBatchAddMessages).mockResolvedValue(undefined);
  vi.mocked(tauri.dbAddMsg).mockResolvedValue(undefined);
  vi.mocked(tauri.dbUpdateMsgContent).mockResolvedValue(undefined);
  vi.mocked(tauri.dbClearMessages).mockResolvedValue(undefined);
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

describe("T-035 store 不可变更新", () => {
  it("addMessagesBatch：conv.messages 换新引用，旧数组不被原地 push", async () => {
    const before = seed();
    const beforeMessages = before.messages;
    const beforeConvs = useConversationStore.getState().conversations;

    await useConversationStore
      .getState()
      .addMessagesBatch("c1", [msg("u1", "user", "问题"), msg("a1", "assistant", "回答")]);

    const after = convById();
    expect(after).toBeDefined();
    if (!after) throw new Error("会话丢失");
    expect(after).not.toBe(before);
    expect(after.messages).not.toBe(beforeMessages);
    expect(beforeMessages).toHaveLength(0); // 旧数组未被原地修改
    expect(useConversationStore.getState().conversations).not.toBe(beforeConvs);
    expect(useConversationStore.getState().allConversations[0]).toBe(after);
    // seq 连续、标题按首条 user 生成
    expect(after.messages.map((m) => [m.id, m.seq])).toEqual([
      ["u1", 1],
      ["a1", 2],
    ]);
    expect(after.title).toBe("问题");
  });

  it("addMessage：conv.messages 换新引用，旧数组不被原地 push", async () => {
    const before = seed([msg("old", "assistant", "旧消息")]);
    const beforeMessages = before.messages;

    await useConversationStore.getState().addMessage("c1", msg("u2", "user", "新消息"));

    const after = convById();
    if (!after) throw new Error("会话丢失");
    expect(after).not.toBe(before);
    expect(after.messages).not.toBe(beforeMessages);
    expect(beforeMessages.map((m) => m.id)).toEqual(["old"]);
    expect(after.messages.map((m) => m.id)).toEqual(["old", "u2"]);
    expect(after.messages[1]?.seq).toBe(1);
  });

  it("updateMessage：messages 换新引用且只替换目标消息", async () => {
    const before = seed([msg("a1", "assistant", "旧正文"), msg("a2", "assistant", "别的")]);
    const beforeMessages = before.messages;
    const untouched = beforeMessages[1];

    await useConversationStore.getState().updateMessage("c1", "a1", "新正文");

    const after = convById();
    if (!after) throw new Error("会话丢失");
    expect(after.messages).not.toBe(beforeMessages);
    expect(after.messages[0]?.content).toBe("新正文");
    expect(after.messages[1]).toBe(untouched); // 非目标消息保持原引用
  });

  it("replaceMessages：messages 换新引用且内容被摘要种子替换", async () => {
    const before = seed([msg("a1", "assistant", "旧正文"), msg("u1", "user", "旧问题")]);
    const beforeMessages = before.messages;

    const ok = await useConversationStore
      .getState()
      .replaceMessages("c1", [msg("s1", "system", "【摘要】")], 2);

    expect(ok).toBe(true);
    const after = convById();
    if (!after) throw new Error("会话丢失");
    expect(after.messages).not.toBe(beforeMessages);
    expect(beforeMessages).toHaveLength(2); // 旧数组未变
    expect(after.messages.map((m) => m.content)).toEqual(["【摘要】"]);
  });

  it("ChatView 链路：写入后能沿着新引用看到新消息（store 层断言）", async () => {
    seed();
    // ChatView 的 conv 查找 + messages useMemo 依赖的就是这两个引用
    const convBefore = convById();
    const messagesBefore = convBefore?.messages;

    // 斜杠命令路径：先 addMessage(user) 再 addMessage(assistant)
    await useConversationStore.getState().addMessage("c1", msg("u1", "user", "/search 关键词"));
    await useConversationStore.getState().addMessage("c1", msg("a1", "assistant", "搜索结果"));

    const convAfter = convById();
    if (!convAfter) throw new Error("会话丢失");
    expect(convAfter).not.toBe(convBefore);
    expect(convAfter.messages).not.toBe(messagesBefore);
    expect(convAfter.messages.map((m) => m.content)).toEqual(["/search 关键词", "搜索结果"]);
  });
});
