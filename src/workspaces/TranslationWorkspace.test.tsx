// @vitest-environment jsdom
//
// workspaces/TranslationWorkspace.test.tsx — 工作区切换状态保留(T-150)
//
// AppShell 用条件渲染切工作区,离开即卸载。契约:
//   1. 卸载再挂载后,源文本/译文仍在(模块级 uiCache);
//   2. 卸载时取消在途翻译流,不让它继续在后台生成。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const H = vi.hoisted(() => ({
  streamChat: vi.fn(),
  cancelChat: vi.fn(),
  MODEL: {
    name: "m1",
    provider: "openai",
    api_url: "https://api.example/v1",
    api_key: "sk-test",
    model: "m1-model",
  },
}));

vi.mock("@/lib/tauri", () => ({
  streamChat: H.streamChat,
  cancelChat: H.cancelChat,
}));
vi.mock("@/stores/useSettingsStore", () => ({
  useSettingsStore: (sel?: (s: Record<string, unknown>) => unknown) => {
    const state = { models: [H.MODEL], activeModel: H.MODEL.name };
    return sel ? sel(state) : state;
  },
}));
vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key }));

import { TranslationWorkspace } from "./TranslationWorkspace";

function srcBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("trans.srcPlaceholder") as HTMLTextAreaElement;
}
function outBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("trans.outPlaceholder") as HTMLTextAreaElement;
}
function translateButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "trans.button" }) as HTMLButtonElement;
}

beforeEach(() => {
  H.streamChat.mockReset();
  H.cancelChat.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("T-150 切换工作区不丢输入/结果", () => {
  it("卸载再挂载后源文本与译文仍在", async () => {
    H.streamChat.mockImplementation(
      async (
        _req: unknown,
        _rid: string,
        h: { onToken: (d: string) => void; onDone: () => void }
      ) => {
        h.onToken("Hello");
        h.onDone();
      }
    );

    const first = render(<TranslationWorkspace />);
    fireEvent.change(srcBox(), { target: { value: "你好" } });
    fireEvent.click(translateButton());
    await waitFor(() => expect(outBox().value).toBe("Hello"));
    first.unmount();

    render(<TranslationWorkspace />);
    expect(srcBox().value).toBe("你好");
    expect(outBox().value).toBe("Hello");
  });

  it("卸载时取消在途流", async () => {
    let requestId = "";
    H.streamChat.mockImplementation((_req: unknown, rid: string) => {
      requestId = rid;
      return new Promise<void>(() => {
        /* 永不结束:模拟仍在生成的流 */
      });
    });

    const view = render(<TranslationWorkspace />);
    fireEvent.change(srcBox(), { target: { value: "待翻译" } });
    fireEvent.click(translateButton());
    await waitFor(() => expect(H.streamChat).toHaveBeenCalledTimes(1));
    view.unmount();

    expect(requestId).toBeTruthy();
    expect(H.cancelChat).toHaveBeenCalledWith(requestId);
  });
});
