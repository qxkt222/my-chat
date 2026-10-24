// @vitest-environment jsdom
//
// stores/conversation-isolation.test.ts — 对话/工作两套会话列表完全隔离
//
// 契约:
//   1. 旧会话（无 work_mode）归到「工作」；前端兜底不因缺字段丢会话。
//   2. 会话列表只显示当前子模式的会话；两种模式各自记住 activeId。
//   3. 无历史 activeId 时选中该子模式「最近更新」的会话，没有则为 null。
//   4. create() 按当前子模式写入 work_mode（并透传给 Rust DTO）。
//   5. 删除/重命名/tabIds 不跨模式泄漏。

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const mocked: Record<string, unknown> = { ...actual };
  for (const key of Object.keys(actual)) {
    if (typeof (actual as Record<string, unknown>)[key] === "function") mocked[key] = vi.fn();
  }
  return mocked;
});

import * as tauri from "@/lib/tauri";
import { useConversationStore, convWorkMode } from "./useConversationStore";
import type { Conversation, WorkSubMode } from "@/types";

function makeConv(
  id: string,
  workMode: WorkSubMode | undefined,
  updatedAt: string,
  extra: Partial<Conversation> = {}
): Conversation {
  return {
    id,
    title: id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: updatedAt,
    model_name: "",
    messages: [],
    work_mode: workMode,
    ...extra,
  };
}

function reset(all: Conversation[] = [], mode: WorkSubMode = "work") {
  useConversationStore.setState({
    allConversations: all,
    conversations: [],
    activeId: null,
    tabIds: [],
    activeByMode: { chat: null, work: null },
    tabsByMode: { chat: [], work: [] },
    workSubMode: mode,
    loaded: true,
  });
}

const ids = () =>
  useConversationStore
    .getState()
    .conversations.map((c) => c.id)
    .sort();

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  reset();
});

describe("旧数据兼容", () => {
  it("convWorkMode: 缺字段/陌生值一律按 work", () => {
    expect(convWorkMode({})).toBe("work");
    expect(convWorkMode({ work_mode: undefined })).toBe("work");
    expect(convWorkMode({ work_mode: "chat" })).toBe("chat");
    expect(convWorkMode({ work_mode: "work" })).toBe("work");
  });

  it("load(): DTO 缺 work_mode 时归到 work，chat 会话不进 work 列表", async () => {
    vi.mocked(tauri.dbLoadAll).mockResolvedValue({
      conversations: [
        {
          id: "old",
          title: "old",
          model_name: "",
          system_prompt: "",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "chat1",
          title: "chat1",
          model_name: "",
          system_prompt: "",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-03T00:00:00.000Z",
          work_mode: "chat",
        },
      ],
      messages: {},
    });

    await useConversationStore.getState().load();

    const st = useConversationStore.getState();
    expect(st.allConversations.map((c) => c.id).sort()).toEqual(["chat1", "old"]);
    expect(st.allConversations.find((c) => c.id === "old")?.work_mode).toBe("work");
    expect(ids()).toEqual(["old"]); // 当前子模式 = work
  });
});

describe("列表隔离与 activeId 记忆", () => {
  it("applyWorkSubMode 切换可见列表，并按各自历史恢复 activeId", () => {
    reset(
      [
        makeConv("c-old", "chat", "2026-01-02T00:00:00.000Z"),
        makeConv("c-new", "chat", "2026-01-05T00:00:00.000Z"),
        makeConv("w1", "work", "2026-01-03T00:00:00.000Z"),
      ],
      "work"
    );
    const st = () => useConversationStore.getState();

    // 无历史 → 选该模式最近更新的会话
    st().applyWorkSubMode("work");
    expect(st().activeId).toBe("w1");
    expect(ids()).toEqual(["w1"]);

    st().applyWorkSubMode("chat");
    expect(st().activeId).toBe("c-new");
    expect(ids()).toEqual(["c-new", "c-old"]);

    // 用户切到较旧的 chat 会话，切走再切回 → 恢复的是它，而不是最近更新的
    st().setActive("c-old");
    st().applyWorkSubMode("work");
    expect(st().activeId).toBe("w1");

    st().applyWorkSubMode("chat");
    expect(st().activeId).toBe("c-old");
  });

  it("空模式 → activeId 为 null", () => {
    reset([makeConv("w1", "work", "2026-01-03T00:00:00.000Z")], "work");
    useConversationStore.getState().applyWorkSubMode("chat");
    const st = useConversationStore.getState();
    expect(st.conversations).toEqual([]);
    expect(st.activeId).toBeNull();
    expect(st.tabIds).toEqual([]);
  });

  it("tabIds 按模式隔离，不把另一模式的会话带进当前标签栏", () => {
    reset(
      [
        makeConv("c1", "chat", "2026-01-02T00:00:00.000Z"),
        makeConv("w1", "work", "2026-01-03T00:00:00.000Z"),
      ],
      "chat"
    );
    const st = () => useConversationStore.getState();

    st().openTab("c1");
    expect(st().tabIds).toEqual(["c1"]);

    st().applyWorkSubMode("work");
    expect(st().tabIds).not.toContain("c1");
    expect(st().tabIds).toEqual(["w1"]); // activeId 自动补进 tab（与既有行为一致）

    st().applyWorkSubMode("chat");
    expect(st().tabIds).toEqual(["c1"]);
  });
});

describe("create() 按当前子模式落库", () => {
  it("chat 子模式新建：conv 与 IPC 参数都写 work_mode=chat，且不出现在 work 列表", async () => {
    reset([], "chat");
    vi.mocked(tauri.dbCreateConv).mockResolvedValue(undefined);

    const conv = await useConversationStore.getState().create();

    expect(conv.work_mode).toBe("chat");
    expect(tauri.dbCreateConv).toHaveBeenCalledWith(expect.objectContaining({ work_mode: "chat" }));
    const st = () => useConversationStore.getState();
    expect(st().conversations.map((c) => c.id)).toEqual([conv.id]);
    expect(st().activeId).toBe(conv.id);

    st().applyWorkSubMode("work");
    expect(st().conversations).toEqual([]);
    expect(st().activeId).toBeNull();
  });
});

describe("删除/重命名不受隔离影响", () => {
  it("重命名与删除只作用于当前模式的会话，另一模式原样保留", async () => {
    reset(
      [
        makeConv("c1", "chat", "2026-01-02T00:00:00.000Z"),
        makeConv("w1", "work", "2026-01-03T00:00:00.000Z"),
      ],
      "chat"
    );
    vi.mocked(tauri.dbRenameConv).mockResolvedValue(undefined);
    vi.mocked(tauri.dbDeleteConv).mockResolvedValue(undefined);
    const st = () => useConversationStore.getState();

    await st().rename("c1", "改名了");
    expect(st().conversations.find((c) => c.id === "c1")?.title).toBe("改名了");
    expect(st().conversations.find((c) => c.id === "w1")).toBeUndefined();

    await st().remove("c1");
    expect(st().conversations).toEqual([]);
    expect(st().allConversations.map((c) => c.id)).toEqual(["w1"]);

    st().applyWorkSubMode("work");
    expect(st().conversations.map((c) => c.id)).toEqual(["w1"]);
  });
});
