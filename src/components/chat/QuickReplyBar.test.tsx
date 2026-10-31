// @vitest-environment jsdom
// components/chat/QuickReplyBar.test.tsx — 自定义按钮删除入口可见性契约
//
// T-128:删除按钮用 opacity-0 group-hover:opacity-100，但按钮的父级 span
// 和组件根都没有 `group`，hover 永远触发不了 → 删除入口不可见也不可点。
// 这里锁定父级必须有 group（Tailwind group-hover 的宿主），且删除链路可点。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

const lib = vi.hoisted(() => ({
  loadQuickReplies: vi.fn(),
  saveQuickReplies: vi.fn(),
  renderQuickReply: vi.fn(() => ({ text: "rendered", ask: null })),
}));

vi.mock("@/lib/quick-reply", () => ({
  loadQuickReplies: lib.loadQuickReplies,
  saveQuickReplies: lib.saveQuickReplies,
  renderQuickReply: lib.renderQuickReply,
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  askPrompt: vi.fn(async () => null),
}));

vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key }));

import { QuickReplyBar } from "./QuickReplyBar";

afterEach(() => cleanup());

function renderBar() {
  return render(<QuickReplyBar input="" onSend={vi.fn()} vars={{ char: "角色", user: "我" }} />);
}

describe("QuickReplyBar 删除入口", () => {
  it("自定义按钮的父级带 group，删除按钮的 hover 类才有宿主", () => {
    lib.loadQuickReplies.mockReturnValue([{ id: "custom-1", name: "自定义", template: "hi" }]);
    const { container } = renderBar();

    const wrapper = container.querySelector("span.group");
    expect(wrapper).toBeTruthy();
    const del = wrapper?.querySelector("button.absolute");
    expect(del).toBeTruthy();
    expect(del?.className).toContain("group-hover:opacity-100");
  });

  it("删除按钮可点击，移除自定义按钮并写回存储", () => {
    lib.loadQuickReplies.mockReturnValue([{ id: "custom-1", name: "自定义", template: "hi" }]);
    const { container } = renderBar();

    const del = container.querySelector("span.group button.absolute");
    if (!del) throw new Error("找不到删除按钮");
    fireEvent.click(del);

    expect(lib.saveQuickReplies).toHaveBeenCalledWith([]);
  });

  it("内置按钮（qr-）不渲染删除入口", () => {
    lib.loadQuickReplies.mockReturnValue([
      { id: "qr-roll", name: "掷骰", template: "[roll D100 65]" },
    ]);
    const { container } = renderBar();

    expect(container.querySelector("span.group")).toBeTruthy();
    expect(container.querySelector("button.absolute")).toBeNull();
  });
});
