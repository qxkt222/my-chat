// @vitest-environment jsdom
//
// T-027 — 停止串 textarea 必须能输入多行，且输入期间不写盘。
//
// 复现路径（FE-US 审查报告）：
//   原实现 value 直接取 store 数组 join("\n")，onChange 立刻 split+trim+filter。
//   用户敲完第一行按 Enter，尾随换行在 onChange 里被 filter(Boolean) 吃掉，
//   join 回来的 value 没有换行 —— 第二行永远输入不进去；且每个按键都写一次 sled。
//
// 契约：
//   1. 输入期间 textarea 保留原始文本（含换行）—— 先敲 "A\n" 换行不能消失；
//   2. 输入期间不调用 save_setting（无逐键写盘）；
//   3. blur 时解析成数组落盘（每行一个，去空白、丢空行）；
//   4. 未 blur 直接点「保存」也必须提交解析结果（不能丢用户刚敲的内容）。

import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const invokeMock = vi.hoisted(() =>
  vi.fn((_cmd: string, _args?: Record<string, unknown>) => Promise.resolve())
);

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { SettingsDialog } from "./SettingsDialog";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { useSettingsStore } from "@/stores/useSettingsStore";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAppModeStore.setState({ mode: "work", workSubMode: "work", tavernSubMode: "rp" });
  const scoped = {
    activeModel: "",
    defaultParameters: { temperature: 0.7, max_tokens: 2048 },
    budgetConfig: { mode: "auto" as const, usage_pct: 90, default_context_window: 8192 },
    globalInstruction: "",
    thinkingEnabled: true,
    reasoningEffort: "high" as const,
    stoppingStrings: [],
  };
  useSettingsStore.setState({
    models: [],
    activeModel: "",
    scope: "work",
    scopes: { work: scoped, chat: { ...scoped } },
    defaultParameters: { temperature: 0.7, max_tokens: 2048 },
    stoppingStrings: [],
  });
});

/** 打开设置 → 通用 tab → 拿到停止串 textarea */
function openGeneralTab() {
  render(<SettingsDialog open onClose={vi.fn()} />);
  fireEvent.click(screen.getByText("通用", { selector: "button" }));
  return screen.getByPlaceholderText(/每行一个停止串/) as HTMLTextAreaElement;
}

/** 只取写停止串的 save_setting 调用（保存按钮还会写 scope 其它 key） */
function stoppingStringSaves(): unknown[][] {
  return invokeMock.mock.calls.filter(
    ([cmd, args]) =>
      cmd === "save_setting" &&
      (args as Record<string, unknown> | undefined)?.key === "stopping_strings"
  );
}

describe("T-027 停止串 textarea 多行输入", () => {
  it("敲完第一行按回车，换行保留（不被当场吞掉）；输入期间不写盘", () => {
    const ta = openGeneralTab();

    // 用户输入第一行 + 回车：旧实现此时 value 会立刻变回 "A"
    fireEvent.change(ta, { target: { value: "A\n" } });
    expect(ta.value).toBe("A\n");

    // 继续输入第二行
    fireEvent.change(ta, { target: { value: "A\nB" } });
    expect(ta.value).toBe("A\nB");

    // 输入期间一个字节都不落盘
    expect(stoppingStringSaves()).toHaveLength(0);
  });

  it("blur 时解析成数组落盘：两行 → 两个元素", async () => {
    const ta = openGeneralTab();

    fireEvent.change(ta, { target: { value: "</s>\n<|im_end|>" } });
    fireEvent.blur(ta);

    await waitFor(() => expect(stoppingStringSaves()).toHaveLength(1));
    expect(stoppingStringSaves()[0]?.[1]).toEqual({
      key: "stopping_strings",
      value: JSON.stringify(["</s>", "<|im_end|>"]),
    });
    expect(useSettingsStore.getState().stoppingStrings).toEqual(["</s>", "<|im_end|>"]);
  });

  it("未 blur 直接点「保存」也提交两行（不丢刚敲的内容）", async () => {
    const ta = openGeneralTab();

    fireEvent.change(ta, { target: { value: "</s>\n\n  <|im_end|>  " } });
    fireEvent.click(screen.getByText("保存", { selector: "button" }));

    await waitFor(() => expect(stoppingStringSaves()).toHaveLength(1));
    expect(stoppingStringSaves()[0]?.[1]).toEqual({
      key: "stopping_strings",
      value: JSON.stringify(["</s>", "<|im_end|>"]),
    });
  });

  it("blur 时内容没变不重复写盘（避免每次点过 textarea 都写一次）", () => {
    const ta = openGeneralTab();

    fireEvent.change(ta, { target: { value: "A" } });
    fireEvent.blur(ta);
    return waitFor(() => expect(stoppingStringSaves()).toHaveLength(1)).then(() => {
      fireEvent.focus(ta);
      fireEvent.blur(ta);
      expect(stoppingStringSaves()).toHaveLength(1);
    });
  });
});
