// @vitest-environment jsdom
//
// stores/tavern-background-patch.test.ts — T-002 回归:
// 酒馆后台摘要/翻译不得用 await 前的旧快照整对象回写。
//
// 旧实现(summarizeIfNeeded / translateMessage)在 await 前取 conv 快照,
// 完成后 `saveConv({ ...conv, ... })` 整对象回写 → await 期间新到的消息、
// 另一个后台任务的结果被内存+磁盘一起抹掉;会话被删后还会被写回来。
//
// 本文件钉住的契约(与实现无关):
//   1. await 期间新到的消息,任务完成后仍在内存与磁盘里;
//   2. summary_msg_count 记的是任务开始时的消息数(本次摘要覆盖范围),
//      不是完成时的总数 —— 期间新增的消息下一轮必须还能被摘要;
//   3. await 期间会话被删除:放弃写回,不得重新创建文件;
//   4. 摘要与翻译同时完成:两个结果都保留,互不覆盖。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SummarizeResult } from "@/lib/summarize";

/** 全量 mock tauri:所有 IPC 都是 vi.fn(),避免任何真实 invoke */
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const mocked: Record<string, unknown> = { ...actual };
  for (const key of Object.keys(actual)) {
    if (typeof (actual as Record<string, unknown>)[key] === "function") mocked[key] = vi.fn();
  }
  return mocked;
});

// 用可控 deferred 取代真实摘要/翻译调用,精确制造 await 窗口
vi.mock("@/lib/summarize", () => ({
  SUMMARIZE_THRESHOLD: 15,
  runSummarize: vi.fn(),
}));
vi.mock("@/lib/translate", () => ({
  translateText: vi.fn(),
}));

import * as tauri from "@/lib/tauri";
import { runSummarize } from "@/lib/summarize";
import { translateText } from "@/lib/translate";
import { useTavernStore } from "./useTavernStore";
import { useSettingsStore } from "./useSettingsStore";
import type { Message, ModelConfig, TavernConversation } from "@/types";

const MODEL: ModelConfig = {
  name: "m1",
  provider: "openai",
  api_url: "http://127.0.0.1:1",
  api_key: "k",
  model: "m1",
};
const CONV_ID = "tav-race";
const APP_DIR = "C:/app";

function nowISO() {
  return new Date().toISOString();
}

function makeMessages(count = 15): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `消息 ${i}`,
    timestamp: nowISO(),
  }));
}

function makeConv(messages = makeMessages()): TavernConversation {
  return {
    id: CONV_ID,
    character_id: "char1",
    character_name: "角色",
    model_name: MODEL.name,
    title: "t",
    created_at: nowISO(),
    updated_at: nowISO(),
    messages,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function latestConv(): TavernConversation {
  const conv = useTavernStore.getState().conversations.find((c) => c.id === CONV_ID);
  if (!conv) throw new Error("会话不存在");
  return conv;
}

/** 追加一条消息(模拟 await 期间的新 user/assistant 落库) */
function appendMessage(id: string) {
  const base = latestConv();
  useTavernStore.setState({
    conversations: [
      {
        ...base,
        messages: [
          ...base.messages,
          { id, role: "user", content: `新消息 ${id}`, timestamp: nowISO() },
        ],
        updated_at: nowISO(),
      },
    ],
  } as never);
}

/** 最近一次落盘的内容(解析 JSON) */
function lastWrittenConv(): TavernConversation {
  const calls = vi.mocked(tauri.writeFile).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const last = calls[calls.length - 1];
  if (!last) throw new Error("没有落盘调用");
  return JSON.parse(String(last[1])) as TavernConversation;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(tauri.getAppDir).mockResolvedValue(APP_DIR);
  vi.mocked(tauri.writeFile).mockResolvedValue(undefined);
  vi.mocked(tauri.deleteItem).mockResolvedValue(undefined);
  useSettingsStore.setState({ models: [MODEL], activeModel: MODEL.name } as never);
  useTavernStore.setState({
    conversations: [makeConv()],
    activeId: CONV_ID,
    isStreaming: false,
    activeRequestId: null,
    autoSummarize: true,
    autoTranslate: true,
    translatingIds: [],
  } as never);
});

describe("summarizeIfNeeded 的 await 后合并", () => {
  it("await 期间新到的消息完成后仍在，summary_msg_count 记开始时的条数", async () => {
    const summaryD = deferred<SummarizeResult>();
    vi.mocked(runSummarize).mockReturnValue(summaryD.promise);

    const started = useTavernStore.getState().summarizeIfNeeded(CONV_ID);

    // 后台摘要等待期间:继续发送并落库两条消息
    appendMessage("new0");
    appendMessage("new1");
    expect(latestConv().messages).toHaveLength(17);

    summaryD.resolve({ summary: "摘要A", complete: true });
    await started;

    const after = latestConv();
    // 新消息不能被旧快照抹掉
    expect(after.messages).toHaveLength(17);
    expect(after.messages.some((m) => m.id === "new1")).toBe(true);
    expect(after.summary).toBe("摘要A");
    // 记账是「本次摘要覆盖到的 15 条」,不是完成时的 17 条
    expect(after.summary_msg_count).toBe(15);

    const written = lastWrittenConv();
    expect(written.summary).toBe("摘要A");
    expect(written.summary_msg_count).toBe(15);
    expect(written.messages).toHaveLength(17);
    expect(written.messages.some((m) => m.id === "new1")).toBe(true);
  });

  it("await 期间会话被删除：放弃写回，不重新创建文件", async () => {
    const summaryD = deferred<SummarizeResult>();
    vi.mocked(runSummarize).mockReturnValue(summaryD.promise);

    const started = useTavernStore.getState().summarizeIfNeeded(CONV_ID);
    await useTavernStore.getState().removeConv(CONV_ID);
    expect(useTavernStore.getState().conversations).toHaveLength(0);

    summaryD.resolve({ summary: "不该落盘", complete: true });
    await started;

    // 会话仍是删除状态,磁盘也没有被重新写出来
    expect(useTavernStore.getState().conversations).toHaveLength(0);
    expect(tauri.writeFile).not.toHaveBeenCalled();
  });
});

describe("translateMessage 的 await 后合并", () => {
  it("译文只合并进对应消息，await 期间新增的消息不丢", async () => {
    const translateD = deferred<string>();
    vi.mocked(translateText).mockReturnValue(translateD.promise);

    const started = useTavernStore.getState().translateMessage(CONV_ID, "m1");

    appendMessage("new0");
    expect(latestConv().messages).toHaveLength(16);

    translateD.resolve("译文B");
    await started;

    const after = latestConv();
    expect(after.messages).toHaveLength(16);
    expect(after.messages.some((m) => m.id === "new0")).toBe(true);
    expect(after.messages.find((m) => m.id === "m1")?.translation).toBe("译文B");
    // 其他消息不受影响
    expect(after.messages.find((m) => m.id === "m0")?.translation).toBeUndefined();

    const written = lastWrittenConv();
    expect(written.messages).toHaveLength(16);
    expect(written.messages.some((m) => m.id === "new0")).toBe(true);
    expect(written.messages.find((m) => m.id === "m1")?.translation).toBe("译文B");
  });

  it("await 期间会话被删除：放弃写回，不重新创建文件", async () => {
    const translateD = deferred<string>();
    vi.mocked(translateText).mockReturnValue(translateD.promise);

    const started = useTavernStore.getState().translateMessage(CONV_ID, "m1");
    await useTavernStore.getState().removeConv(CONV_ID);

    translateD.resolve("不该落盘");
    await started;

    expect(useTavernStore.getState().conversations).toHaveLength(0);
    expect(tauri.writeFile).not.toHaveBeenCalled();
  });
});

describe("摘要与翻译同时完成", () => {
  it("两个结果都保留，互不覆盖", async () => {
    const summaryD = deferred<SummarizeResult>();
    const translateD = deferred<string>();
    vi.mocked(runSummarize).mockReturnValue(summaryD.promise);
    vi.mocked(translateText).mockReturnValue(translateD.promise);

    // 第一次写盘挂起:制造「翻译已合并、尚未落盘」的窗口
    const firstWrite = deferred<void>();
    vi.mocked(tauri.writeFile)
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(undefined);

    const translating = useTavernStore.getState().translateMessage(CONV_ID, "m1");
    const summarizing = useTavernStore.getState().summarizeIfNeeded(CONV_ID);

    translateD.resolve("译文C");
    await vi.waitFor(() => expect(tauri.writeFile).toHaveBeenCalledTimes(1));

    // 摘要此时完成:必须排在翻译写回之后,不能抢跑覆盖
    summaryD.resolve({ summary: "摘要C", complete: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(tauri.writeFile).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await Promise.all([translating, summarizing]);

    const after = latestConv();
    expect(after.summary).toBe("摘要C");
    expect(after.messages.find((m) => m.id === "m1")?.translation).toBe("译文C");

    // 最后一份落盘同时包含摘要与译文
    const written = lastWrittenConv();
    expect(written.summary).toBe("摘要C");
    expect(written.messages.find((m) => m.id === "m1")?.translation).toBe("译文C");
  });
});
