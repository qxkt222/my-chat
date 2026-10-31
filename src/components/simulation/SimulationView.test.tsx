// @vitest-environment jsdom
//
// components/simulation/SimulationView.test.tsx — 自动滚动 / 轮数默认值回归
//
// T-106:旧 effect 只依赖 messages.length 与 isStreaming。流式追加时消息条数不变,
//   内容增长不会触发滚动,长回复会滚出视口。契约:末条消息内容变长(条数不变)
//   仍要再次滚到底部。
//
// T-107:控制条的「继续推演 N 轮」默认值此前固定 3,与新建会话时设置的
//   autoRounds 无关。契约:默认显示当前会话的 autoRounds。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

// 所有替身状态放在 vi.hoisted 里(vi.mock 会被提升到 import 之前)
const H = vi.hoisted(() => {
  function mk(initial: Record<string, unknown>) {
    const box: {
      state: Record<string, unknown>;
      subs: Set<() => void>;
      set: (patch: Record<string, unknown>) => void;
    } = {
      state: initial,
      subs: new Set(),
      set(patch) {
        box.state = { ...box.state, ...patch };
        for (const f of box.subs) f();
      },
    };
    return box;
  }

  const simBox = mk({});
  const settingsBox = mk({ models: [], activeModel: "", samplerPresets: [] });
  return { simBox, settingsBox };
});

/** 把 hoisted 的 state 盒包成 zustand 风格的 hook(支持选择器与整店订阅) */
async function hookFor(box: typeof H.simBox) {
  const { useSyncExternalStore } = await import("react");
  const useStore = (sel?: (s: Record<string, unknown>) => unknown) =>
    useSyncExternalStore(
      (cb: () => void) => {
        box.subs.add(cb);
        return () => box.subs.delete(cb);
      },
      () => (sel ? sel(box.state) : box.state),
      () => (sel ? sel(box.state) : box.state)
    );
  return Object.assign(useStore, { getState: () => box.state });
}

vi.mock("@/stores/useSimulationStore", async () => ({
  useSimulationStore: await hookFor(H.simBox),
}));
vi.mock("@/stores/useSettingsStore", async () => ({
  useSettingsStore: await hookFor(H.settingsBox),
}));
vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key }));
// 子组件与本用例无关,替身成空渲染,避免 markdown/快捷栏把测试拖慢
vi.mock("@/components/chat/MessageBubble", () => ({ MessageBubble: () => null }));
vi.mock("@/components/chat/QuickReplyBar", () => ({ QuickReplyBar: () => null }));
vi.mock("./StatePanels", () => ({ StatePanels: () => null }));
vi.mock("./NewSimulationModal", () => ({ NewSimulationModal: () => null }));

import type { SimulationConversation } from "@/types";
import { SimulationView } from "./SimulationView";

function nowISO(): string {
  return new Date().toISOString();
}

function makeConv(over: Partial<SimulationConversation> = {}): SimulationConversation {
  return {
    id: "s1",
    title: "sim",
    created_at: nowISO(),
    updated_at: nowISO(),
    messages: [{ id: "m1", role: "assistant", content: "短回复", timestamp: nowISO() }],
    type: "story",
    stateMode: "none",
    pacing: "turn",
    stateUpdate: "inline",
    autoRounds: 4,
    setup: "",
    worldState: "",
    stateTable: {},
    timeLabel: "",
    timeline: [],
    ...over,
  };
}

const scrollTo = vi.fn();
const originalScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: scrollTo,
  });
  scrollTo.mockClear();

  H.settingsBox.set({ models: [], activeModel: "", samplerPresets: [] });
  const conv = makeConv();
  H.simBox.set({
    conversations: [conv],
    activeId: conv.id,
    isStreaming: false,
    isSyncing: false,
    autoSummarize: false,
    activeRequestId: null,
    load: vi.fn(async () => {}),
    setActive: vi.fn(),
    patch: vi.fn(async () => {}),
    removeConv: vi.fn(async () => {}),
    addTimelineEntry: vi.fn(async () => {}),
    removeTimelineEntry: vi.fn(async () => {}),
    setNote: vi.fn(async () => {}),
    setPinned: vi.fn(async () => {}),
    setObserverMode: vi.fn(async () => {}),
    anchorNow: vi.fn(async () => {}),
    setAutoSummarize: vi.fn(),
    resolveModel: () => undefined,
    sendMessage: vi.fn(async () => {}),
    continueRounds: vi.fn(async () => {}),
    afterTurn: vi.fn(async () => {}),
    timeStep: vi.fn(async () => {}),
    updateStateAndTimeline: vi.fn(async () => {}),
    summarizeIfNeeded: vi.fn(async () => {}),
    cancelGeneration: vi.fn(),
  });
  // getActive 动态读盒内状态:set 之后重渲染能看到新会话
  H.simBox.state.getActive = () =>
    (H.simBox.state.conversations as SimulationConversation[]).find(
      (c) => c.id === H.simBox.state.activeId
    );
});

afterEach(() => {
  cleanup();
  if (originalScrollTo) Object.defineProperty(Element.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(Element.prototype, "scrollTo");
});

describe("T-106 自动滚动跟随流式内容", () => {
  it("消息条数不变、末条内容变长时仍再次滚到底部", async () => {
    render(<SimulationView onOpenSettings={() => {}} />);
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    scrollTo.mockClear();

    const conv = (H.simBox.state.conversations as SimulationConversation[])[0];
    const firstMsg = conv?.messages[0];
    if (!conv || !firstMsg) throw new Error("测试夹具缺少会话/消息");
    // 模拟流式追加:条数仍是 1,只有末条内容增长
    H.simBox.set({
      conversations: [
        {
          ...conv,
          messages: [{ ...firstMsg, content: "很长的流式回复".repeat(200) }],
        },
      ],
    });

    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
  });
});

describe("T-107 控制条轮数默认值", () => {
  it("默认显示当前会话的 autoRounds", async () => {
    render(<SimulationView onOpenSettings={() => {}} />);
    const input = (await screen.findByRole("spinbutton")) as HTMLInputElement;
    expect(input.value).toBe("4");
  });
});
