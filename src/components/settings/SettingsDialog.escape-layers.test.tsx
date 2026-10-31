// @vitest-environment jsdom
//
// T-102 — 设置弹窗 + 模型向导的 Esc 层级回归。
//
// 场景:设置开着 → 点「添加模型」打开向导 → 按一次 Esc。
// 期望:只关向导,设置弹窗仍在,且不触发全局「停止生成」。
// 旧实现两层各挂一个 window keydown,一次 Esc 两层全关。

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { SettingsDialog } from "./SettingsDialog";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { useSettingsStore } from "@/stores/useSettingsStore";

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useAppModeStore.setState({ mode: "work", workSubMode: "work", tavernSubMode: "rp" });
  useSettingsStore.setState({
    models: [],
    activeModel: "",
    scope: "work",
    loaded: true,
  });
});

describe("T-102 Esc 只关最上层", () => {
  it("向导内按 Esc 只关向导，设置弹窗保留；再按一次才关设置", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} />);

    fireEvent.click(screen.getByText("添加模型", { selector: "button" }));
    expect(screen.getByText("选择 AI 服务商")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByText("选择 AI 服务商")).toBeNull());
    // 设置弹窗还在 —— 一次 Esc 不能关两层
    expect(screen.getByText("设置 · 工作")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    // 第二层现在是最上层，Esc 关设置
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
