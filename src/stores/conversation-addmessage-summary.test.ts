// @vitest-environment jsdom
//
// stores/conversation-addmessage-summary.test.ts — T-018 回归:
// addMessage 不得因整条重写会话把磁盘摘要清空。
//
// 旧实现用 dbCreateConv 全量覆盖，却不带 summary / summary_msg_count；
// Rust create_conv 是全量 insert，ConvDto.summary 又是 #[serde(default)]，
// 于是「有摘要的会话执行任意斜杠命令」后，磁盘摘要被写成 ""/0。
//
// 契约:
//   1. addMessage 写回会话时，payload 必须带当前摘要与记账数；
//   2. await dbAddMsg 期间摘要被 updateSummary 更新 → 用最新值，不用旧快照。

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

const CONV_ID = "conv-summary";

function nowISO(): string {
  return "2026-10-31T00:00:00.000Z";
}

function makeConv(extra: Partial<Conversation> = {}): Conversation {
  return {
    id: CONV_ID,
    title: "旧标题",
    created_at: nowISO(),
    updated_at: nowISO(),
    model_name: "m1",
    messages: [],
    work_mode: "work",
    ...extra,
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

function userMsg(id = "u-new", content = "斜杠命令"): Message {
  return { id, role: "user", content, timestamp: nowISO() };
}

function lastCreatePayload(): Record<string, unknown> {
  const calls = vi.mocked(tauri.dbCreateConv).mock.calls;
  const last = calls[calls.length - 1]?.[0];
  if (!last) throw new Error("dbCreateConv 未被调用");
  return last as unknown as Record<string, unknown>;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(tauri.dbAddMsg).mockResolvedValue(undefined);
  vi.mocked(tauri.dbCreateConv).mockResolvedValue(undefined);
  vi.mocked(tauri.dbUpdateConvSummary).mockResolvedValue(undefined);
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

describe("T-018 addMessage 保留会话摘要", () => {
  it("写回会话的 create 载荷带上 summary / summary_msg_count", async () => {
    seed(makeConv({ summary: "关键事实：用户喜欢简洁", summary_msg_count: 7 }));

    await useConversationStore.getState().addMessage(CONV_ID, userMsg());

    expect(tauri.dbCreateConv).toHaveBeenCalledTimes(1);
    expect(lastCreatePayload()).toMatchObject({
      id: CONV_ID,
      summary: "关键事实：用户喜欢简洁",
      summary_msg_count: 7,
      work_mode: "work",
    });
  });

  it("await 期间摘要被更新：写回用最新值，不用旧快照", async () => {
    seed(makeConv({ summary: "旧摘要", summary_msg_count: 3 }));
    // 模拟后台自动摘要恰好落在 dbAddMsg 与整条写回之间
    vi.mocked(tauri.dbAddMsg).mockImplementation(async () => {
      await useConversationStore.getState().updateSummary(CONV_ID, "新摘要", 9);
    });

    await useConversationStore.getState().addMessage(CONV_ID, userMsg());

    expect(lastCreatePayload().summary).toBe("新摘要");
    expect(lastCreatePayload().summary_msg_count).toBe(9);
  });

  it("addMessage 仍把消息与标题写进会话（原有行为不退化）", async () => {
    seed(makeConv());

    await useConversationStore.getState().addMessage(CONV_ID, userMsg("u1", "第一条用户消息"));

    const conv = useConversationStore.getState().allConversations[0];
    expect(conv?.messages.map((m) => m.id)).toEqual(["u1"]);
    expect(conv?.title).toBe("第一条用户消息");
    expect(tauri.dbAddMsg).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1", conv_id: CONV_ID, role: "user" })
    );
  });
});
