// @vitest-environment jsdom
//
// Header「设置」按钮的开关语义测试。
//
// 为什么单独钉这一条（2026-09-25 开发者反馈）：
//   原话 ——「我再重新点击设置结果又来到了原来那个窗口又没进入到原来设置的窗口」。
//   根因：那个按钮只有 onOpenSettings，点它永远是「开」；
//   弹窗已经开着时点它毫无反应，用户就以为界面卡住了、退不出去。
//   现在改成开关：开着再点 = 关。
//
// ⚠️ 口径：这里测的是**回调被调用**（行为），不是像素或样式。

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, screen, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { Header } from "./Header";
import { useAppModeStore } from "@/stores/useAppModeStore";

afterEach(cleanup);

/** 取头部那个「设置」按钮（用 title 定位，避免和侧栏里的同名入口混淆） */
function settingsButton(): HTMLElement {
  const btns = Array.from(document.querySelectorAll("button"));
  const hit = btns.find((b) => {
    const title = b.getAttribute("title") || "";
    return title === "设置" || title === "酒馆设置";
  });
  if (!hit) throw new Error("头部应有一个 title 为「设置」/「酒馆设置」的按钮");
  return hit;
}

describe("Header「设置」按钮是开关", () => {
  it("弹窗关着时点它 → 调 onOpenSettings", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<Header settingsOpen={false} onOpenSettings={onOpen} onCloseSettings={onClose} />);
    fireEvent.click(settingsButton());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("弹窗开着时点它 → 调 onCloseSettings（这就是「再点一次设置」该有的行为）", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<Header settingsOpen onOpenSettings={onOpen} onCloseSettings={onClose} />);
    fireEvent.click(settingsButton());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// 2026-10-23 跨 scope 串值修复的 Header 侧断言：
//   原先 key={mode} 只在 工作/酒馆 之间重挂，切换 对话/工作 子模式时弹窗不重挂，
//   表单里 useState 捕获的仍是旧 scope 值（SettingsDialog 侧的补丁见
//   SettingsDialog.scope-sync.test.tsx）。
//   这里用「切换子模式后 tab 回到默认『模型』」证明弹窗确实重挂载了 ——
//   tab 是组件内部 state，不重挂就不会自己回去。
describe("Header 常驻挂载的设置弹窗随工作子模式重挂载", () => {
  it("切到对话子模式后，弹窗重挂、tab 回到默认「模型」", () => {
    useAppModeStore.setState({ mode: "work", workSubMode: "work", tavernSubMode: "rp" });
    render(<Header settingsOpen onOpenSettings={vi.fn()} onCloseSettings={vi.fn()} />);

    fireEvent.click(screen.getByText("通用", { selector: "button" }));
    const selected = () =>
      Array.from(document.querySelectorAll("button")).find((b) =>
        b.className.includes("border-primary")
      )?.textContent;
    expect(selected()).toBe("通用");

    act(() => useAppModeStore.getState().setWorkSubMode("chat"));

    expect(selected()).toBe("模型");
  });
});
