// @vitest-environment jsdom
//
// stores/tavern-cancel-persist.test.ts — T-026 回归:
// 酒馆 regenerate 先清空 content 并落盘、取消时 cancelChat 立刻删 handler,
// Rust 取消后补发的 done 到不了 onDone → finish 永不执行,磁盘留下
// content:"" 而 variants 还是旧文;普通生成取消时半截正文只留在内存。
//
// 本文件钉住的契约(与实现无关):
//   1. regenerate 起流时不得把空 content 写到磁盘;
//   2. 生成中取消:已生成的半截正文落盘,content 与 variants[variantIndex]
//      一致(操作栏依赖非空内容);
//   3. 取消得太早(一点新内容都没有):恢复旧版本,绝不把旧回复清空。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CharacterCard, Message, ModelConfig, TavernConversation } from "@/types";

/** 全量 mock tauri:所有 IPC 都是 vi.fn(),避免任何真实 invoke */
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const mocked: Record<string, unknown> = { ...actual };
  for (const key of Object.keys(actual)) {
    if (typeof (actual as Record<string, unknown>)[key] === "function") mocked[key] = vi.fn();
  }
  return mocked;
});

import * as tauri from "@/lib/tauri";
import { useTavernStore } from "./useTavernStore";
import { useSettingsStore } from "./useSettingsStore";
import { useCharacterStore } from "./useCharacterStore";

const MODEL: ModelConfig = {
  name: "m1",
  provider: "openai",
  api_url: "https://api.example/v1",
  api_key: "sk-test",
  model: "m1-model",
};

const CARD: CharacterCard = {
  id: "char1",
  specVersion: "2",
  name: "角色",
  description: "描述",
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
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function nowISO() {
  return new Date().toISOString();
}

const OLD_A = "旧版本 A";
const OLD_B = "旧版本 B";

function makeConv(messages: Message[]): TavernConversation {
  return {
    id: "tav1",
    character_id: CARD.id,
    character_name: CARD.name,
    model_name: MODEL.name,
    title: "t",
    created_at: nowISO(),
    updated_at: nowISO(),
    messages,
  };
}

/** 已有两版回复、当前停在第二版的历史会话(regenerate 的典型状态) */
function makeRegenConv(): TavernConversation {
  return makeConv([
    { id: "u1", role: "user", content: "你好", timestamp: nowISO() },
    {
      id: "a1",
      role: "assistant",
      content: OLD_B,
      timestamp: nowISO(),
      model: CARD.name,
      variants: [OLD_A, OLD_B],
      variantIndex: 1,
    },
  ]);
}

interface PendingStream {
  handlers: Parameters<typeof tauri.streamChat>[2] | null;
  release: () => void;
}

/** 起一条永不自动结束的流:返回句柄,由测试手动送 token / 结束 */
function mockPendingStream(): PendingStream {
  const state: PendingStream = { handlers: null, release: () => {} };
  vi.mocked(tauri.streamChat).mockImplementation(async (_req, _requestId, handlers) => {
    state.handlers = handlers;
    await new Promise<void>((resolve) => {
      state.release = resolve;
    });
  });
  return state;
}

function writtenConvs(): TavernConversation[] {
  return vi
    .mocked(tauri.writeFile)
    .mock.calls.map((call) => JSON.parse(String(call[1])) as TavernConversation);
}

function lastWrittenConv(): TavernConversation {
  const all = writtenConvs();
  const last = all[all.length - 1];
  if (!last) throw new Error("没有落盘调用");
  return last;
}

function messageById(conv: TavernConversation, id: string): Message {
  const msg = conv.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`消息 ${id} 不存在`);
  return msg;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(tauri.getAppDir).mockResolvedValue("C:/tmp/app");
  vi.mocked(tauri.writeFile).mockResolvedValue(undefined);
  vi.mocked(tauri.listDir).mockResolvedValue([]);
  vi.mocked(tauri.logDiag).mockResolvedValue(undefined);

  useSettingsStore.setState({
    models: [MODEL],
    activeModel: MODEL.name,
    regexRules: [],
    budgetConfig: { mode: "manual", usage_pct: 90, default_context_window: 8192 },
    defaultParameters: {},
    samplerPresets: [],
    stoppingStrings: [],
    thinkingEnabled: false,
    reasoningEffort: "high",
  });
  useCharacterStore.setState({
    characters: [CARD],
    personas: [],
    enabledLorebookIds: [],
    lorebooks: {},
    presets: [],
  });
  useTavernStore.setState({
    conversations: [],
    activeId: null,
    isStreaming: false,
    activeRequestId: null,
    autoSummarize: false,
    autoTranslate: false,
    autoSwipe: false,
    translatingIds: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("T-026 regenerate 不再先清空落盘", () => {
  it("起流后磁盘上没有任何 content 为空的版本", async () => {
    useTavernStore.setState({ conversations: [makeRegenConv()], activeId: "tav1" });
    const stream = mockPendingStream();

    const p = useTavernStore.getState().swipeGenerate("a1");
    await vi.waitFor(() => expect(stream.handlers).not.toBeNull());

    // 旧实现这里已经 saveConv({content:""}) 了:取消/崩溃即永久丢旧回复
    for (const conv of writtenConvs()) {
      expect(messageById(conv, "a1").content).not.toBe("");
      expect(messageById(conv, "a1").variants).toEqual([OLD_A, OLD_B]);
    }

    // 结束本次生成,避免遗留挂起 promise / 未完成的异步收尾
    stream.handlers?.onDone?.();
    stream.release();
    await p;
    await vi.waitFor(() => expect(useTavernStore.getState().isStreaming).toBe(false));
  });
});

describe("T-026 生成中取消要落盘半截回复", () => {
  it("regenerate 取消:半截正文落盘且 content 与 variants 一致", async () => {
    useTavernStore.setState({ conversations: [makeRegenConv()], activeId: "tav1" });
    const stream = mockPendingStream();

    const p = useTavernStore.getState().swipeGenerate("a1");
    await vi.waitFor(() => expect(stream.handlers).not.toBeNull());
    stream.handlers?.onToken("新的半截");

    useTavernStore.getState().cancelGeneration();
    await vi.waitFor(() => expect(useTavernStore.getState().isStreaming).toBe(false));

    const written = lastWrittenConv();
    const asm = messageById(written, "a1");
    expect(asm.content).toBe("新的半截");
    expect(asm.variants).toEqual([OLD_A, OLD_B, "新的半截"]);
    expect(asm.variantIndex).toBe(2);
    // 界面显示与发送上下文必须同源(T-025)
    expect(asm.content).toBe(asm.variants?.[asm.variantIndex ?? 0]);
    // 操作栏依赖非空内容(T-026):取消后仍能复制/编辑/滑卡
    expect(asm.content.length).toBeGreaterThan(0);

    stream.release();
    await p;
  });

  it("普通发送取消:已生成正文落盘,不再是只留在内存", async () => {
    useTavernStore.setState({
      conversations: [makeConv([{ id: "u1", role: "user", content: "你好", timestamp: nowISO() }])],
      activeId: "tav1",
    });
    const stream = mockPendingStream();

    const p = useTavernStore.getState().sendMessage("继续聊");
    await vi.waitFor(() => expect(stream.handlers).not.toBeNull());
    stream.handlers?.onToken("半截回复");

    useTavernStore.getState().cancelGeneration();
    await vi.waitFor(() => expect(useTavernStore.getState().isStreaming).toBe(false));

    const written = lastWrittenConv();
    const asm = written.messages[written.messages.length - 1];
    expect(asm?.role).toBe("assistant");
    expect(asm?.content).toBe("半截回复");
    expect(asm?.variants).toEqual(["半截回复"]);

    stream.release();
    await p;
  });

  it("取消得太早(零 token):恢复旧版本而不是留空", async () => {
    useTavernStore.setState({ conversations: [makeRegenConv()], activeId: "tav1" });
    const stream = mockPendingStream();

    const p = useTavernStore.getState().swipeGenerate("a1");
    await vi.waitFor(() => expect(stream.handlers).not.toBeNull());

    useTavernStore.getState().cancelGeneration();
    await vi.waitFor(() => expect(useTavernStore.getState().isStreaming).toBe(false));

    const asm = messageById(lastWrittenConv(), "a1");
    expect(asm.content).toBe(OLD_B);
    expect(asm.variants).toEqual([OLD_A, OLD_B]);
    expect(asm.variantIndex).toBe(1);

    stream.release();
    await p;
  });
});
