// @vitest-environment jsdom
//
// components/chat/MessageBubble.cancel-actions.test.tsx — T-026 回归:
// 旧实现 regenerate 取消后磁盘留下 content:"",而操作栏按 message.content
// 决定是否渲染 → 该消息从此无法复制/编辑/滑卡。
// 本文件钉住:只要当前版本(variants[variantIndex])有内容,操作栏就可用,
// 不再因为 content 字段暂时为空而消失。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { MessageBubble } from "./MessageBubble";
import { useSettingsStore } from "@/stores/useSettingsStore";
import type { Message } from "@/types";

afterEach(cleanup);

const MESSAGE: Message = {
  id: "a1",
  role: "assistant",
  content: "",
  timestamp: "2026-01-01T00:00:00.000Z",
  model: "角色",
  variants: ["旧版本"],
  variantIndex: 0,
};

beforeEach(() => {
  useSettingsStore.setState({ regexRules: [] });
});

describe("T-026 取消后操作栏仍可用", () => {
  it("content 为空但 variants 有旧文时仍渲染复制/编辑/滑卡", () => {
    render(
      <MessageBubble
        message={MESSAGE}
        streaming={false}
        onEdit={vi.fn()}
        onSwipe={vi.fn()}
        onTranslate={vi.fn()}
      />
    );

    expect(screen.getByTitle("复制")).toBeTruthy();
    expect(screen.getByTitle("编辑消息")).toBeTruthy();
    // 滑卡计数取 variants,当前版本 1/1
    expect(screen.getByText("1/1")).toBeTruthy();
  });
});
