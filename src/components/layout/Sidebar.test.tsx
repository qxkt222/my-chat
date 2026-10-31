// @vitest-environment jsdom
//
// T-148 回归：Sidebar 的 remove / removeMany / toggleArchiveMany 都是异步操作。
// 旧实现 `remove(conv.id)` 不 await，DB 删除失败 → unhandled rejection，
// 列表不更新也没有任何提示。这里注入 DB 失败，钉住三件事：
//   1. 出现可见 toast；
//   2. 会话列表保持原样（不被半截状态搅乱）；
//   3. 失败不冒泡成未处理 rejection（有 catch）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("@/lib/i18n", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  t: (key: string) => key,
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  askConfirm: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/components/ui/Toast", () => ({ showToast: vi.fn() }));

// 只把两个删除 IPC 打坏，其余 tauri 导出保持原样（store 模块初始化需要）
vi.mock("@/lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...mod,
    dbDeleteConv: vi.fn(() => Promise.reject(new Error("db delete failed"))),
    dbBatchDeleteConvs: vi.fn(() => Promise.reject(new Error("db batch delete failed"))),
  };
});

import { Sidebar } from "./Sidebar";
import { showToast } from "@/components/ui/Toast";
import { useConversationStore } from "@/stores/useConversationStore";
import type { Conversation } from "@/types";

const conv: Conversation = {
  id: "c1",
  title: "会话一",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  model_name: "test-model",
  messages: [],
};

let setItemSpy: { mockRestore: () => void } | null = null;

beforeEach(() => {
  useConversationStore.setState({
    conversations: [conv],
    allConversations: [conv],
    tabIds: [conv.id],
    activeId: conv.id,
    favorites: [],
    archived: [],
  });
});

afterEach(() => {
  cleanup();
  setItemSpy?.mockRestore();
  setItemSpy = null;
  vi.clearAllMocks();
  useConversationStore.setState({
    conversations: [],
    allConversations: [],
    tabIds: [],
    activeId: null,
    favorites: [],
    archived: [],
  });
});

function conversationIds(): string[] {
  return useConversationStore.getState().conversations.map((c) => c.id);
}

describe("Sidebar 删除/归档失败处理（T-148）", () => {
  it("单条删除失败：toast 提示，列表保持原样", async () => {
    render(<Sidebar />);

    fireEvent.click(screen.getByTitle("memory.delete"));

    await waitFor(() => {
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("sidebar.deleteFailed")
      );
    });
    expect(conversationIds()).toEqual(["c1"]);
  });

  it("批量删除失败：toast 提示，列表保持原样且退出管理模式", async () => {
    render(<Sidebar />);

    fireEvent.click(screen.getByTitle("sidebar.manage"));
    fireEvent.click(screen.getByText("会话一"));
    fireEvent.click(screen.getByTitle("sidebar.deleteMany"));

    await waitFor(() => {
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("sidebar.batchDeleteFailed")
      );
    });
    expect(conversationIds()).toEqual(["c1"]);
    // 失败后仍退出管理模式（与成功路径一致，避免卡在空选择状态）
    expect(screen.queryByTitle("sidebar.deleteMany")).toBeNull();
  });

  it("批量归档失败（localStorage 抛错）：toast 提示", async () => {
    setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    render(<Sidebar />);

    fireEvent.click(screen.getByTitle("sidebar.manage"));
    fireEvent.click(screen.getByText("会话一"));
    const archiveButtons = screen.getAllByTitle("sidebar.archive");
    const batchArchive = archiveButtons[archiveButtons.length - 1];
    if (!batchArchive) throw new Error("应存在批量归档按钮");
    fireEvent.click(batchArchive);

    await waitFor(() => {
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("sidebar.archiveFailed")
      );
    });
    expect(useConversationStore.getState().archived).toEqual([]);
  });
});
