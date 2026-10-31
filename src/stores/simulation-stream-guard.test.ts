// @vitest-environment jsdom
//
// stores/simulation-stream-guard.test.ts — 推演流并发/轮数回归(T-089 / T-107)
//
// T-089:旧实现把 isStreaming=true 与 activeRequestId 写在 `await memSearch` 之后,
//   两次快速触发都能通过函数开头的守卫并各起一条流,而 activeRequestId 只记后者,
//   cancelGeneration 只能停掉其中一条。契约:
//     1. memSearch 挂起期间第二次 sendMessage 直接返回,只起一条流;
//     2. memSearch 挂起期间取消:取消当前请求 id,且不再发起流式请求;
//     3. 取消后可再次发送并正常起流。
//
// T-107:autoRounds 此前只写不读,是死选项。契约:
//     4. continueRounds() 省略轮数时按当前会话的 autoRounds 执行;
//     5. 显式传参仍可覆盖 autoRounds。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelConfig, SimulationConversation } from "@/types";

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
import { useSimulationStore } from "./useSimulationStore";
import { useSettingsStore } from "./useSettingsStore";

const MODEL: ModelConfig = {
  name: "m1",
  provider: "openai",
  api_url: "https://api.example/v1",
  api_key: "sk-test",
  model: "m1-model",
};

function nowISO(): string {
  return new Date().toISOString();
}

function makeSimConv(): SimulationConversation {
  return {
    id: "s1",
    title: "sim",
    created_at: nowISO(),
    updated_at: nowISO(),
    messages: [{ id: "u0", role: "user", content: "开场", timestamp: nowISO() }],
    type: "story",
    stateMode: "none",
    pacing: "turn",
    stateUpdate: "inline",
    autoRounds: 3,
    setup: "",
    worldState: "",
    stateTable: {},
    timeLabel: "",
    timeline: [],
    model_name: MODEL.name,
  };
}

type MemoryHit = { id: string; content: string; score: number };

/** 手动控制 resolve 的 promise:模拟 memSearch(IPC)挂起 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(tauri.streamChat).mockReset();
  vi.mocked(tauri.memSearch).mockReset();
  vi.mocked(tauri.cancelChat).mockReset();
  vi.mocked(tauri.getAppDir).mockResolvedValue("C:/tmp/app");
  vi.mocked(tauri.listDir).mockResolvedValue([]);
  vi.mocked(tauri.writeFile).mockResolvedValue(undefined);

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

describe("T-089 并发触发守卫", () => {
  it("memSearch 挂起时第二次触发直接返回,只起一条流", async () => {
    const conv = makeSimConv();
    useSimulationStore.setState({ conversations: [conv], activeId: conv.id });
    const gate = deferred<MemoryHit[]>();
    vi.mocked(tauri.memSearch).mockReturnValue(gate.promise);
    vi.mocked(tauri.streamChat).mockImplementation(async (_req, _rid, h) => {
      h.onToken("推进");
      h.onDone();
    });

    const first = useSimulationStore.getState().sendMessage("第一");
    const second = useSimulationStore.getState().sendMessage("第二");

    // 第二次必须立即返回:isStreaming 在任何 await 之前就已置位
    await second;
    await vi.waitFor(() => expect(tauri.memSearch).toHaveBeenCalledTimes(1));
    expect(useSimulationStore.getState().isStreaming).toBe(true);
    expect(useSimulationStore.getState().activeRequestId).toBeTruthy();
    expect(tauri.streamChat).not.toHaveBeenCalled();

    gate.resolve([]);
    await first;
    await vi.waitFor(() => expect(useSimulationStore.getState().isStreaming).toBe(false));

    // 只起了一条流、只追加了一组 user+assistant(原有 1 条用户消息 + 本轮 1 条)
    expect(tauri.streamChat).toHaveBeenCalledTimes(1);
    const messages = useSimulationStore.getState().conversations[0]?.messages ?? [];
    expect(messages.filter((m) => m.role === "user")).toHaveLength(2);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("memSearch 挂起时取消:不再起流,取消的是当前请求", async () => {
    const conv = makeSimConv();
    useSimulationStore.setState({ conversations: [conv], activeId: conv.id });
    const gate = deferred<MemoryHit[]>();
    vi.mocked(tauri.memSearch).mockReturnValue(gate.promise);

    const first = useSimulationStore.getState().sendMessage("第一");
    await vi.waitFor(() => expect(tauri.memSearch).toHaveBeenCalledTimes(1));
    const requestId = useSimulationStore.getState().activeRequestId;
    expect(requestId).toBeTruthy();

    useSimulationStore.getState().cancelGeneration();
    expect(tauri.cancelChat).toHaveBeenCalledWith(requestId);

    gate.resolve([]);
    await first;
    expect(tauri.streamChat).not.toHaveBeenCalled();
    expect(useSimulationStore.getState().isStreaming).toBe(false);
  });

  it("取消后可再次发送并正常起流", async () => {
    const conv = makeSimConv();
    useSimulationStore.setState({ conversations: [conv], activeId: conv.id });
    const gate = deferred<MemoryHit[]>();
    vi.mocked(tauri.memSearch).mockReturnValue(gate.promise);
    vi.mocked(tauri.streamChat).mockImplementation(async (_req, _rid, h) => {
      h.onDone();
    });

    const first = useSimulationStore.getState().sendMessage("第一");
    await vi.waitFor(() => expect(tauri.memSearch).toHaveBeenCalledTimes(1));
    useSimulationStore.getState().cancelGeneration();
    gate.resolve([]);
    await first;

    await useSimulationStore.getState().sendMessage("再来");
    await vi.waitFor(() => expect(useSimulationStore.getState().isStreaming).toBe(false));
    expect(tauri.streamChat).toHaveBeenCalledTimes(1);
  });
});

describe("T-107 autoRounds 不再是死选项", () => {
  it("continueRounds() 省略轮数时按会话 autoRounds 执行", async () => {
    const conv = makeSimConv();
    conv.autoRounds = 3;
    useSimulationStore.setState({ conversations: [conv], activeId: conv.id });
    vi.mocked(tauri.streamChat).mockImplementation(async (_req, _rid, h) => {
      h.onToken("推进");
      h.onDone();
    });

    await useSimulationStore.getState().continueRounds();

    expect(tauri.streamChat).toHaveBeenCalledTimes(3);
  });

  it("显式传参覆盖 autoRounds", async () => {
    const conv = makeSimConv();
    conv.autoRounds = 5;
    useSimulationStore.setState({ conversations: [conv], activeId: conv.id });
    vi.mocked(tauri.streamChat).mockImplementation(async (_req, _rid, h) => {
      h.onDone();
    });

    await useSimulationStore.getState().continueRounds(1);

    expect(tauri.streamChat).toHaveBeenCalledTimes(1);
  });
});
