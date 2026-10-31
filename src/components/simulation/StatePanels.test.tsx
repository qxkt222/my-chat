// @vitest-environment jsdom
//
// StatePanels 草稿同步回归(T-023 / FE-UR StatePanels.tsx:24-25)。
//
// 旧实现:wsDraft/tableDraft 只在挂载时初始化。默认 stateUpdate=every,
// 推演一轮后 afterTurn → updateStateAndTimeline 改了 conv.worldState /
// conv.stateTable,面板仍显示旧值,点「保存」会把旧文本整段写回,覆盖自动
// 同步的结果。
//
// 契约(这里逐条钉住):
//   1. 未聚焦且草稿未 dirty 时,外部值变化要同步进草稿;
//   2. 聚焦编辑中 / 已 dirty 的草稿不能被外部值覆盖;
//   3. 切换 convId 时草稿重置为新会话内容(不串会话);
//   4. 自动同步后保存写的是新值,不是旧草稿。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// StatePanels 只用到 store 上的这三个动作,整个 store 用替身即可
const H = vi.hoisted(() => ({
  patch: vi.fn(async () => {}),
  addTimelineEntry: vi.fn(async () => {}),
  removeTimelineEntry: vi.fn(async () => {}),
}));

vi.mock("@/stores/useSimulationStore", () => ({
  useSimulationStore: () => ({
    patch: H.patch,
    addTimelineEntry: H.addTimelineEntry,
    removeTimelineEntry: H.removeTimelineEntry,
  }),
}));
vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key }));

import { StatePanels } from "./StatePanels";
import type { SimulationConversation } from "@/types";

function makeConv(over: Partial<SimulationConversation> = {}): SimulationConversation {
  return {
    id: "c1",
    title: "会话一",
    created_at: "",
    updated_at: "",
    messages: [],
    type: "story",
    stateMode: "text",
    pacing: "turn",
    stateUpdate: "every",
    autoRounds: 1,
    setup: "",
    worldState: "初始世界状态",
    stateTable: { hp: "10" },
    timeLabel: "",
    timeline: [],
    ...over,
  };
}

function renderPanels(conv: SimulationConversation) {
  return render(<StatePanels conv={conv} showState showTimeline={false} />);
}

function wsInput(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("sim.worldStatePlaceholder") as HTMLTextAreaElement;
}

function tableValues(): string[] {
  return screen
    .getAllByPlaceholderText("sim.tableValue")
    .map((el) => (el as HTMLInputElement).value);
}

afterEach(() => {
  cleanup();
  H.patch.mockClear();
});

describe("StatePanels 草稿跟随外部状态", () => {
  it("未聚焦时 conv.worldState 变化 → 草稿更新为新值", () => {
    const { rerender } = renderPanels(makeConv());
    expect(wsInput().value).toBe("初始世界状态");

    rerender(
      <StatePanels
        conv={makeConv({ worldState: "自动同步后的状态" })}
        showState
        showTimeline={false}
      />
    );

    expect(wsInput().value).toBe("自动同步后的状态");
  });

  it("未聚焦时 conv.stateTable 变化 → 表草稿同步新增/删除的键", () => {
    const { rerender } = renderPanels(makeConv({ stateMode: "table" }));
    expect(tableValues()).toEqual(["10"]);

    rerender(
      <StatePanels
        conv={makeConv({ stateMode: "table", stateTable: { hp: "8", mp: "3" } })}
        showState
        showTimeline={false}
      />
    );

    expect(tableValues()).toEqual(["8", "3"]);
  });

  it("聚焦编辑中 conv.worldState 变化 → 草稿不被覆盖", () => {
    const { rerender } = renderPanels(makeConv());
    const ta = wsInput();
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "用户正在编辑" } });

    rerender(
      <StatePanels
        conv={makeConv({ worldState: "自动同步后的状态" })}
        showState
        showTimeline={false}
      />
    );

    expect(wsInput().value).toBe("用户正在编辑");
  });

  it("失焦但仍有未保存编辑(dirty)→ 外部值不覆盖", () => {
    const { rerender } = renderPanels(makeConv());
    const ta = wsInput();
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: "未保存的编辑" } });
    fireEvent.blur(ta);

    rerender(
      <StatePanels
        conv={makeConv({ worldState: "自动同步后的状态" })}
        showState
        showTimeline={false}
      />
    );

    expect(wsInput().value).toBe("未保存的编辑");
  });

  it("切换 convId → 草稿重置为新会话内容(不串会话)", () => {
    const { rerender } = renderPanels(makeConv());
    fireEvent.change(wsInput(), { target: { value: "会话一的未保存编辑" } });

    rerender(
      <StatePanels
        conv={makeConv({
          id: "c2",
          title: "会话二",
          worldState: "会话二世界状态",
          stateTable: { mp: "20" },
        })}
        showState
        showTimeline={false}
      />
    );

    expect(wsInput().value).toBe("会话二世界状态");
  });

  it("自动同步后点保存 → patch 写入的是新值而不是旧草稿", async () => {
    const { rerender } = renderPanels(makeConv());

    rerender(
      <StatePanels
        conv={makeConv({ worldState: "自动同步后的状态" })}
        showState
        showTimeline={false}
      />
    );

    fireEvent.click(screen.getByText("sim.saveState"));

    await waitFor(() =>
      expect(H.patch).toHaveBeenCalledWith("c1", { worldState: "自动同步后的状态" })
    );
  });
});
