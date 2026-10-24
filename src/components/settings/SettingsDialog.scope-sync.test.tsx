// @vitest-environment jsdom
//
// 设置弹窗的「跨子模式串值」回归测试（2026-10-23）。
//
// 复现路径（另一代理实测）：
//   Header 常驻挂载 <SettingsDialog key={mode}>，弹窗关闭时组件也一直活着；
//   active / temperature / max_tokens 是 useState 在挂载那一刻捕获的。
//   用户启动后切过 对话/工作 子模式、再打开设置，输入框还是启动时那套值，
//   点保存就把旧 scope 的采样参数写进了新 scope。
//
// 本文件钉四件事：
//   1. 切换 workSubMode 后重新打开设置 -> 表单值来自新 scope；
//   2. 点「保存」写回的是新 scope 的值（断言 setDefaultParameters 的实参）；
//   3. 弹窗打开期间用户改的值，不会因为无关重渲染被 store 覆盖；
//   4. 关闭再打开会丢弃未保存的编辑，重新回到 store 值。
//
// 前提：真实切换路径是 setWorkSubMode() + useSettingsStore.applyScope()（ChatView
// handleSwitchSubMode 同步调用两者），这里照抄，不假设 applyScope 会自动发生。

import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { SettingsDialog } from "./SettingsDialog";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import type { ModelConfig } from "@/types";

afterEach(cleanup);

function mkModel(name: string): ModelConfig {
  return {
    name,
    provider: "openai",
    api_url: "https://example.invalid/v1",
    api_key: "k",
    model: name,
  };
}

/** 一个字段完整的 scope 值（缺字段会让 zustand state 类型不成立） */
function scoped(activeModel: string, temperature: number, max_tokens: number) {
  return {
    activeModel,
    defaultParameters: { temperature, max_tokens },
    budgetConfig: { mode: "auto" as const, usage_pct: 90, default_context_window: 8192 },
    globalInstruction: "",
    thinkingEnabled: true,
    reasoningEffort: "high" as const,
    stoppingStrings: [],
  };
}

const WORK = scoped("work-model", 0.2, 111);
const CHAT = scoped("chat-model", 0.95, 950);

beforeEach(() => {
  useAppModeStore.setState({ mode: "work", workSubMode: "work", tavernSubMode: "rp" });
  useSettingsStore.setState({
    models: [mkModel("work-model"), mkModel("chat-model")],
    scope: "work",
    scopes: { work: WORK, chat: CHAT },
    activeModel: WORK.activeModel,
    defaultParameters: { ...WORK.defaultParameters },
  });
});

/** 模拟用户在 ChatView 里切子模式：写子模式 + 切设置 scope（真实路径） */
function switchSubMode(m: "chat" | "work") {
  act(() => {
    useAppModeStore.getState().setWorkSubMode(m);
    useSettingsStore.getState().applyScope(m);
  });
}

function openGeneralTab(container: HTMLElement) {
  fireEvent.click(screen.getByText("通用", { selector: "button" }));
  const range = container.querySelector('input[type="range"]') as HTMLInputElement | null;
  const num = container.querySelector('input[type="number"]') as HTMLInputElement | null;
  if (!range || !num) throw new Error("通用面板缺少 temperature / max_tokens 输入框");
  return { range, num };
}

describe("切换 workSubMode 后重新打开设置，表单同步到新 scope", () => {
  it("active / temperature / max_tokens 都是新 scope 的 store 值", () => {
    const onClose = vi.fn();
    // Header 的常驻挂载方式：弹窗关闭但组件活着
    const { rerender, container } = render(<SettingsDialog open={false} onClose={onClose} />);
    expect(container.innerHTML).toBe("");

    switchSubMode("chat");
    rerender(<SettingsDialog open onClose={onClose} />);

    const select = container.querySelector("select") as HTMLSelectElement | null;
    expect(select?.value).toBe("chat-model");

    const { range, num } = openGeneralTab(container);
    expect(range.value).toBe("0.95");
    expect(num.value).toBe("950");
  });

  it("保存时写回的是新 scope 的值（不是启动时捕获的旧值）", async () => {
    const setDefaultParameters = vi.fn();
    useSettingsStore.setState({ setDefaultParameters });
    const onClose = vi.fn();

    const { rerender } = render(<SettingsDialog open={false} onClose={onClose} />);
    switchSubMode("chat");
    rerender(<SettingsDialog open onClose={onClose} />);

    fireEvent.click(screen.getByText("保存", { selector: "button" }));

    await waitFor(() => {
      expect(setDefaultParameters).toHaveBeenCalledWith({ temperature: 0.95, max_tokens: 950 });
    });
  });

  it("弹窗打开期间用户改的值，不会因为无关重渲染被 store 覆盖", () => {
    const onClose = vi.fn();
    const { rerender, container } = render(<SettingsDialog open onClose={onClose} />);
    const { range } = openGeneralTab(container);

    fireEvent.change(range, { target: { value: "1.8" } });
    expect(range.value).toBe("1.8");

    // store 变了但 scope / open 没变（例如别的地方更新了模型列表）
    act(() => {
      useSettingsStore.setState({ models: [...useSettingsStore.getState().models] });
    });
    rerender(<SettingsDialog open onClose={onClose} />);

    const again = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(again.value).toBe("1.8");
  });

  it("关闭再打开会丢弃未保存的编辑，重新回到 store 值", () => {
    const onClose = vi.fn();
    const { rerender, container } = render(<SettingsDialog open onClose={onClose} />);
    const { range } = openGeneralTab(container);
    fireEvent.change(range, { target: { value: "1.8" } });

    rerender(<SettingsDialog open={false} onClose={onClose} />);
    rerender(<SettingsDialog open onClose={onClose} />);

    const reopened = openGeneralTab(container);
    expect(reopened.range.value).toBe("0.2");
  });
});
