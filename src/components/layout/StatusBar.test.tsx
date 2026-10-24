// @vitest-environment jsdom
//
// StatusBar 的工作子模式显示规则(对话 / 工作):
//   1. 工作模式:子模式是更高层,先显示;翻译/绘图工作区是具体视图,附在其后;
//      纯对话区(view=chat)不重复显示视图名。
//   2. 酒馆模式:只显示酒馆子模式(角色扮演/推演),不受工作子模式影响。

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { StatusBar } from "./StatusBar";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { useViewStore } from "@/stores/useViewStore";

function statusText(): string {
  const footer = document.querySelector("footer");
  if (!footer) throw new Error("StatusBar 应渲染 footer");
  return footer.textContent || "";
}

beforeEach(() => {
  useAppModeStore.setState({ mode: "work", workSubMode: "work", tavernSubMode: "rp" });
  useViewStore.setState({ view: "chat" });
});

afterEach(cleanup);

describe("StatusBar 工作子模式", () => {
  it("工作模式 + 工作子模式 + 对话视图 → 只显示「工作」", () => {
    render(<StatusBar />);
    expect(statusText()).toContain("就绪 · 工作");
    expect(statusText()).not.toContain("对话");
  });

  it("工作模式 + 对话子模式 + 对话视图 → 只显示「对话」", () => {
    useAppModeStore.setState({ workSubMode: "chat" });
    render(<StatusBar />);
    expect(statusText()).toContain("就绪 · 对话");
  });

  it("工作模式 + 对话子模式 + 翻译视图 → 子模式在前,视图名在后", () => {
    useAppModeStore.setState({ workSubMode: "chat" });
    useViewStore.setState({ view: "translation" });
    render(<StatusBar />);
    expect(statusText()).toContain("对话 · 翻译工作区");
  });

  it("工作模式 + 工作子模式 + 绘图视图 → 子模式在前,视图名在后", () => {
    useViewStore.setState({ view: "drawing" });
    render(<StatusBar />);
    expect(statusText()).toContain("工作 · 绘图工作区");
  });

  it("酒馆模式只显示酒馆子模式,不受工作子模式影响", () => {
    useAppModeStore.setState({ mode: "tavern", workSubMode: "chat", tavernSubMode: "simulate" });
    useViewStore.setState({ view: "drawing" });
    render(<StatusBar />);
    expect(statusText()).toContain("就绪 · 推演");
    expect(statusText()).not.toContain("对话");
    expect(statusText()).not.toContain("绘图");
  });

  it("酒馆模式 + 角色扮演子模式 → 显示「角色扮演」", () => {
    useAppModeStore.setState({ mode: "tavern", tavernSubMode: "rp" });
    render(<StatusBar />);
    expect(statusText()).toContain("就绪 · 角色扮演");
  });
});
