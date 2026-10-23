// @vitest-environment jsdom
// stores/tavern-stream-batch.test.ts — SRC-03 回归:酒馆/推演流式 rAF 合帧
//
// 背景(2026-10-23 审计):工作模式 useChatStore 已有 pendingStreams +
// scheduleFlush,但酒馆/推演在每个 onToken 里直接 set({ conversations })
// → 高 token 速率下每帧多次重渲染。
//
// 本文件钉住的契约(与实现无关):
//   1. 同一帧内 50 个 token 只产生 1 次「可见内容变化」;
//   2. 帧回调之前,store 里的消息内容仍是空串(token 只在待写缓冲里);
//   3. finish/onDone 会 flush 挂起帧,最终内容不丢。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  CharacterCard,
  ModelConfig,
  SimulationConversation,
  TavernConversation,
} from "@/types";

/** 全量 mock tauri:所有 IPC 都是 vi.fn(),避免真实 invoke */
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
import { useSimulationStore } from "./useSimulationStore";
import { useSettingsStore } from "./useSettingsStore";
import { useCharacterStore } from "./useCharacterStore";

const streamChat = vi.mocked(tauri.streamChat);

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

function makeTavernConv(): TavernConversation {
  return {
    id: "tav1",
    character_id: "char1",
    character_name: "角色",
    model_name: "m1",
    title: "t",
    created_at: nowISO(),
    updated_at: nowISO(),
    messages: [],
  };
}

function makeSimConv(): SimulationConversation {
  return {
    id: "sim1",
    title: "t",
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
    created_at: nowISO(),
    updated_at: nowISO(),
    messages: [],
  } as SimulationConversation;
}

/** 可手动驱动的 rAF:回调排队,测试显式跑帧 */
let rafQueue: Array<() => void> = [];
function tickFrame() {
  const q = rafQueue.splice(0, rafQueue.length);
  for (const cb of q) cb();
}

beforeEach(() => {
  streamChat.mockReset();
  vi.mocked(tauri.getAppDir).mockResolvedValue("C:/tmp/app");
  vi.mocked(tauri.listDir).mockResolvedValue([]);
  vi.mocked(tauri.writeFile).mockResolvedValue(undefined);
  vi.mocked(tauri.memSearch).mockResolvedValue([]);

  rafQueue = [];
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(() => cb(0));
    return rafQueue.length;
  }) as typeof requestAnimationFrame;

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
    loaded: true,
  });
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
});

afterEach(() => {
  rafQueue = [];
});

/** 统计酒馆会话「最后一条消息内容变化且非空」的次数(=可见内容更新) */
function countTavernUpdates() {
  let updates = 0;
  const unsub = useTavernStore.subscribe((s, prev) => {
    const cur = s.conversations.find((c) => c.id === "tav1")?.messages.at(-1)?.content ?? "";
    const old = prev.conversations.find((c) => c.id === "tav1")?.messages.at(-1)?.content ?? "";
    if (cur !== old && cur.length > 0) updates += 1;
  });
  return {
    get updates() {
      return updates;
    },
    unsub,
  };
}

describe("酒馆流式合帧", () => {
  it("同一帧 50 个 token → 只 1 次可见内容更新,且帧前内容为空", async () => {
    useTavernStore.setState({ conversations: [makeTavernConv()], activeId: "tav1" });

    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    let release!: () => void;

    streamChat.mockImplementation(async (_req, _rid, h) => {
      for (let i = 0; i < 50; i += 1) h.onToken("x");
      started();
      await new Promise<void>((r) => {
        release = () => {
          h.onDone();
          r();
        };
      });
    });

    const counter = countTavernUpdates();

    const sendP = useTavernStore.getState().sendMessage("你好");
    await startedP;

    // 帧还没跑:50 个 token 都还在待写缓冲里
    const before = useTavernStore.getState().conversations[0]?.messages.at(-1)?.content;
    expect(before).toBe("");
    expect(counter.updates).toBe(0);

    tickFrame();

    const after = useTavernStore.getState().conversations[0]?.messages.at(-1)?.content;
    expect(after).toBe("x".repeat(50));
    expect(counter.updates).toBe(1);

    release();
    await sendP;
    counter.unsub();
  });
});

describe("推演流式合帧", () => {
  it("同一帧 50 个 token → 只 1 次可见内容更新", async () => {
    useSimulationStore.setState({ conversations: [makeSimConv()], activeId: "sim1" });

    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    let release!: () => void;

    streamChat.mockImplementation(async (_req, _rid, h) => {
      for (let i = 0; i < 50; i += 1) h.onToken("y");
      started();
      await new Promise<void>((r) => {
        release = () => {
          h.onDone();
          r();
        };
      });
    });

    let updates = 0;
    const unsub = useSimulationStore.subscribe((s, prev) => {
      const cur = s.conversations.find((c) => c.id === "sim1")?.messages.at(-1)?.content ?? "";
      const old = prev.conversations.find((c) => c.id === "sim1")?.messages.at(-1)?.content ?? "";
      if (cur !== old && cur.length > 0) updates += 1;
    });

    const sendP = useSimulationStore.getState().sendMessage("行动");
    await startedP;

    expect(useSimulationStore.getState().conversations[0]?.messages.at(-1)?.content).toBe("");
    expect(updates).toBe(0);

    tickFrame();

    expect(useSimulationStore.getState().conversations[0]?.messages.at(-1)?.content).toBe(
      "y".repeat(50)
    );
    expect(updates).toBe(1);

    release();
    await sendP;
    unsub();
  });
});
