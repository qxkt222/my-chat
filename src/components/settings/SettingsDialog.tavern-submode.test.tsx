// @vitest-environment jsdom
//
// T-133 — tavernSubMode rp ↔ simulate 切换时，设置弹窗必须重挂/同步。
//
// 旧实现 Header 的 key 只有 `${mode}:${workSubMode}`，内部 scopeKey 也没有
// tavernSubMode。rp 的 tab 集合（角色/世界书/预设/样式…）与 simulate（推演）
// 完全不同：切了子模式后旧 tab 既无高亮，还会渲染错误面板。
//
// 本文件钉两条真实路径：
//   1. Header 常驻挂载 + key 重挂（真实使用路径）；
//   2. SettingsDialog 自身的 scopeKey effect 同步（无 key 时也能自愈）。

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { SettingsDialog } from "./SettingsDialog";
import { Header } from "@/components/layout/Header";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { useSettingsStore } from "@/stores/useSettingsStore";

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ models: [], activeModel: "", scope: "work", loaded: true });
  useAppModeStore.setState({ mode: "tavern", workSubMode: "work", tavernSubMode: "rp" });
});

/** 当前高亮的 tab 文本 */
function selectedTab(): string | undefined {
  return Array.from(document.querySelectorAll("button"))
    .find((b) => b.className.includes("border-primary"))
    ?.textContent?.trim();
}

describe("T-133 酒馆子模式切换后的设置面板", () => {
  it("Header 的 key 含 tavernSubMode：rp → simulate 后 tab 回到「推演」", () => {
    render(<Header settingsOpen onOpenSettings={vi.fn()} onCloseSettings={vi.fn()} />);

    // rp 首页 = 角色；先切到另一个 rp 专属 tab，证明后续是重挂而非碰巧
    fireEvent.click(screen.getByText("样式", { selector: "button" }));
    expect(selectedTab()).toBe("样式");

    act(() => useAppModeStore.getState().setTavernSubMode("simulate"));

    expect(selectedTab()).toBe("推演");
    expect(screen.getByText("推演设置")).toBeTruthy();
  });

  it("SettingsDialog 自身同步：simulate → rp 后 tab 回到「角色」", () => {
    useAppModeStore.setState({ tavernSubMode: "simulate" });
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} />);

    expect(selectedTab()).toBe("推演");
    expect(screen.getByText("推演设置")).toBeTruthy();

    act(() => useAppModeStore.getState().setTavernSubMode("rp"));

    expect(selectedTab()).toBe("角色");
    expect(screen.getByText("酒馆设置")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
