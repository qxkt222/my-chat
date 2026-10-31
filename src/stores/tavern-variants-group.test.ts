// @vitest-environment jsdom
//
// stores/tavern-variants-group.test.ts — T-025 + T-024 回归。
//
// T-025(variants 与 content 双真源):
//   · swipe 切到第 2 版旧实现只写 variantIndex → 界面显示 B,但发送/摘要/翻译
//     读 content 拿到的还是 A;
//   · 编辑旧实现只写 content → MessageBubble 渲染取 variants[variantIndex],
//     改了正文界面却没变化。
//   本文件钉住的契约:variants 是版本的展示真源,content 永远同步为当前版本;
//   编辑正文同步写回 variants[variantIndex]。
//
// T-024(群聊重试/继续走错链路):
//   群聊里点重试/继续,旧实现固定取 conv.character_id 的单卡 + buildRpSystemParts
//   → prompt 里没有其他在场角色。本文件钉住:群聊分支走 buildGroupSystemParts,
//   发言者取 activeCharId(手动)或说话队列队首(自动);单聊链路保持不变。

import { describe, it, expect, vi, beforeEach } from "vitest";
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

function nowISO() {
  return new Date().toISOString();
}

function makeCard(id: string, name: string, description: string): CharacterCard {
  return {
    id,
    specVersion: "2",
    name,
    description,
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

const CARD_A = makeCard("charA", "阿雅", "阿雅的描述");
const CARD_B = makeCard("charB", "小北", "小北的描述");

function makeConv(
  messages: Message[],
  extra: Partial<TavernConversation> = {}
): TavernConversation {
  return {
    id: "tav1",
    character_id: CARD_A.id,
    character_name: CARD_A.name,
    model_name: MODEL.name,
    title: "t",
    created_at: nowISO(),
    updated_at: nowISO(),
    messages,
    ...extra,
  };
}

function makeGroupConv(extra: Partial<TavernConversation> = {}): TavernConversation {
  return makeConv(
    [
      { id: "u1", role: "user", content: "你们好", timestamp: nowISO() },
      {
        id: "a1",
        role: "assistant",
        content: "旧的群聊回复",
        timestamp: nowISO(),
        model: CARD_A.name,
      },
    ],
    {
      id: "group1",
      character_name: `${CARD_A.name}、${CARD_B.name}`,
      groupCharIds: [CARD_A.id, CARD_B.id],
      activeCharId: CARD_B.id,
      autoRespond: false,
      ...extra,
    }
  );
}

/** 让 streamChat 立即回一段正文并结束,返回捕获到的请求列表 */
function mockStream(reply: string) {
  const requests: Parameters<typeof tauri.streamChat>[0][] = [];
  vi.mocked(tauri.streamChat).mockImplementation(async (req, _requestId, handlers) => {
    requests.push(req);
    handlers.onToken(reply);
    handlers.onDone();
  });
  return requests;
}

function latestConv(): TavernConversation {
  const conv = useTavernStore.getState().conversations[0];
  if (!conv) throw new Error("会话不存在");
  return conv;
}

function messageById(id: string): Message {
  const msg = latestConv().messages.find((m) => m.id === id);
  if (!msg) throw new Error(`消息 ${id} 不存在`);
  return msg;
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
    characters: [CARD_A, CARD_B],
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

describe("T-025 variants 是当前版本的真源", () => {
  it("swipe 切到第 2 版时 content 同步为 variants[1](内存与落盘)", async () => {
    useTavernStore.setState({
      conversations: [
        makeConv([
          { id: "u1", role: "user", content: "你好", timestamp: nowISO() },
          {
            id: "a1",
            role: "assistant",
            content: "版本 A",
            timestamp: nowISO(),
            variants: ["版本 A", "版本 B"],
            variantIndex: 0,
          },
        ]),
      ],
      activeId: "tav1",
    });

    await useTavernStore.getState().swipe("a1", 1);

    const msg = messageById("a1");
    expect(msg.variantIndex).toBe(1);
    // 发送/摘要/翻译都读 content —— 必须同步为当前版本 B
    expect(msg.content).toBe("版本 B");

    const written = lastWrittenConv();
    expect(written.messages.find((m) => m.id === "a1")?.content).toBe("版本 B");
    expect(written.messages.find((m) => m.id === "a1")?.variantIndex).toBe(1);
  });

  it("编辑正文同步写回 variants[variantIndex],其他版本不动", async () => {
    useTavernStore.setState({
      conversations: [
        makeConv([
          {
            id: "a1",
            role: "assistant",
            content: "版本 B",
            timestamp: nowISO(),
            variants: ["版本 A", "版本 B"],
            variantIndex: 1,
          },
        ]),
      ],
      activeId: "tav1",
    });

    await useTavernStore.getState().editMessage("a1", "改过的 B");

    const msg = messageById("a1");
    expect(msg.content).toBe("改过的 B");
    expect(msg.variants?.[1]).toBe("改过的 B");
    // 历史版本不能被编辑连带改写
    expect(msg.variants?.[0]).toBe("版本 A");

    const written = lastWrittenConv();
    expect(written.messages[0]?.content).toBe("改过的 B");
    expect(written.messages[0]?.variants?.[1]).toBe("改过的 B");
  });

  it("没有 variants 的消息(用户消息/冒充回复)编辑只改 content", async () => {
    useTavernStore.setState({
      conversations: [makeConv([{ id: "u1", role: "user", content: "原话", timestamp: nowISO() }])],
      activeId: "tav1",
    });

    await useTavernStore.getState().editMessage("u1", "改过的话");

    const msg = messageById("u1");
    expect(msg.content).toBe("改过的话");
    expect(msg.variants).toBeUndefined();
  });
});

describe("T-024 群聊重试/继续走群聊 prompt", () => {
  it("群聊手动模式重试:prompt 含全部在场角色,发言者为 activeChar", async () => {
    useTavernStore.setState({ conversations: [makeGroupConv()], activeId: "group1" });
    const requests = mockStream("新的群聊回复");

    await useTavernStore.getState().swipeGenerate("a1");
    await vi.waitFor(() => expect(useTavernStore.getState().isStreaming).toBe(false));

    expect(requests).toHaveLength(1);
    const system = String(requests[0]?.messages[0]?.content ?? "");
    // 群聊组装特征(单角色 buildRpSystemParts 不会出现)
    expect(system).toContain("这是群聊角色扮演场景");
    expect(system).toContain(CARD_A.name);
    expect(system).toContain(CARD_B.name);
    // 手动模式:activeCharId = 小北
    expect(system).toContain("这一轮轮到 小北 发言");

    const msg = messageById("a1");
    expect(msg.content).toBe("新的群聊回复");
    expect(msg.model).toBe(CARD_B.name);
    // 新版本同时进 variants
    expect(msg.variants?.at(-1)).toBe("新的群聊回复");
    expect(msg.content).toBe(msg.variants?.[msg.variantIndex ?? 0]);
  });

  it("群聊自动模式重试:取说话队列队首角色", async () => {
    // queueIndex=0 → 阿雅;activeCharId 故意设为小北,确认走的是队列而不是 activeChar
    useTavernStore.setState({
      conversations: [makeGroupConv({ autoRespond: true, queueIndex: 0 })],
      activeId: "group1",
    });
    const requests = mockStream("自动模式回复");

    await useTavernStore.getState().swipeGenerate("a1");
    await vi.waitFor(() => expect(useTavernStore.getState().isStreaming).toBe(false));

    const system = String(requests[0]?.messages[0]?.content ?? "");
    expect(system).toContain("这一轮轮到 阿雅 发言");
    expect(messageById("a1").model).toBe(CARD_A.name);
  });

  it("群聊继续生成:同样使用群聊 prompt 与当前发言角色", async () => {
    useTavernStore.setState({ conversations: [makeGroupConv()], activeId: "group1" });
    const requests = mockStream("续写内容");

    await useTavernStore.getState().continueMessage("a1");
    await vi.waitFor(() => expect(useTavernStore.getState().isStreaming).toBe(false));

    const system = String(requests[0]?.messages[0]?.content ?? "");
    expect(system).toContain("这是群聊角色扮演场景");
    expect(system).toContain(CARD_A.name);
    expect(system).toContain(CARD_B.name);

    const msg = messageById("a1");
    expect(msg.content).toBe("旧的群聊回复续写内容");
    expect(msg.model).toBe(CARD_B.name);
    expect(msg.content).toBe(msg.variants?.[msg.variantIndex ?? 0]);
  });

  it("单聊重试保持原链路:不使用群聊 prompt", async () => {
    useTavernStore.setState({
      conversations: [
        makeConv([
          { id: "u1", role: "user", content: "你好", timestamp: nowISO() },
          { id: "a1", role: "assistant", content: "旧回复", timestamp: nowISO() },
        ]),
      ],
      activeId: "tav1",
    });
    const requests = mockStream("单聊新回复");

    await useTavernStore.getState().swipeGenerate("a1");
    await vi.waitFor(() => expect(useTavernStore.getState().isStreaming).toBe(false));

    const system = String(requests[0]?.messages[0]?.content ?? "");
    expect(system).not.toContain("这是群聊角色扮演场景");
    expect(system).toContain(CARD_A.name);

    const msg = messageById("a1");
    expect(msg.content).toBe("单聊新回复");
    expect(msg.variants?.at(-1)).toBe("单聊新回复");
  });
});
