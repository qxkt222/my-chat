// @vitest-environment jsdom
// components/characters/LorebookManager.test.tsx — 编辑条目时的字段保真契约
//
// T-109:旧实现保存时整对象重建，只映射表单里那 9 个字段：
//   keyssecondary/comment/match_whole_words/min_activations/selective/
//   sticky/cooldown 全丢，且 enabled 被强置为 true（禁用条目一编辑就复活）。
// 这里锁定：编辑只覆盖表单字段，其余原样保留，enabled 按原值。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import type { LoreEntry } from "@/types";

const state = vi.hoisted(() => ({
  saveGlobalLorebook: vi.fn(async () => {}),
  saveLorebook: vi.fn(async () => {}),
  book: { name: "测试书", entries: [] as unknown[] },
}));

vi.mock("@/stores/useCharacterStore", () => ({
  useCharacterStore: () => ({
    globalLorebook: state.book,
    lorebooks: {},
    enabledLorebookIds: [],
    getActivePersona: () => null,
    saveGlobalLorebook: state.saveGlobalLorebook,
    saveLorebook: state.saveLorebook,
    toggleLorebookEnabled: vi.fn(),
    savePersona: vi.fn(),
    removeLorebook: vi.fn(),
    importLorebook: vi.fn(),
  }),
}));

vi.mock("@/lib/tauri", () => ({
  pickFile: vi.fn(async () => null),
  readFile: vi.fn(async () => ""),
}));

vi.mock("@/lib/character-card", () => ({
  parseCharacterJson: vi.fn(() => null),
}));

vi.mock("@/components/ui/Toast", () => ({ showToast: vi.fn() }));

vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key }));

import { LorebookManager } from "./LorebookManager";

function makeEntry(over: Partial<LoreEntry> = {}): LoreEntry {
  return {
    keys: ["王都", "首都"],
    keyssecondary: ["夜晚", "月光"],
    content: "原始内容",
    constant: true,
    selective: true,
    insertion_order: 5,
    position: "after_char",
    enabled: false,
    comment: "注释",
    case_sensitive: true,
    probability: 70,
    recursive: true,
    regex: true,
    match_whole_words: true,
    min_activations: 2,
    sticky: true,
    cooldown: 3,
    ...over,
  };
}

beforeEach(() => {
  state.book.entries = [makeEntry()];
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("LorebookManager 编辑条目字段保真", () => {
  function openEditor() {
    render(<LorebookManager />);
    const row = screen.getByText("原始内容").closest("div.items-start");
    if (!row) throw new Error("找不到条目行");
    const editBtn = within(row as HTMLElement).getAllByRole("button")[0];
    if (!editBtn) throw new Error("找不到编辑按钮");
    fireEvent.click(editBtn);
  }

  it("编辑关键词后保存：未暴露字段原样保留，禁用的仍禁用", async () => {
    openEditor();

    fireEvent.change(screen.getByPlaceholderText("lore.keys"), {
      target: { value: "王都,首都,新词" },
    });
    fireEvent.click(screen.getByText("settings.save"));

    await waitFor(() => expect(state.saveGlobalLorebook).toHaveBeenCalled());
    expect(state.saveGlobalLorebook).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "测试书",
        entries: [
          expect.objectContaining({
            keys: ["王都", "首都", "新词"],
            keyssecondary: ["夜晚", "月光"],
            comment: "注释",
            match_whole_words: true,
            min_activations: 2,
            selective: true,
            sticky: true,
            cooldown: 3,
            enabled: false,
          }),
        ],
      })
    );
  });

  it("新建条目仍默认启用", async () => {
    openEditor();
    fireEvent.click(screen.getByText("settings.cancel"));
    fireEvent.click(screen.getByText("lore.new"));

    fireEvent.change(screen.getByPlaceholderText("lore.keys"), {
      target: { value: "新关键词" },
    });
    fireEvent.change(screen.getByPlaceholderText("lore.content"), {
      target: { value: "新内容" },
    });
    fireEvent.click(screen.getByText("settings.save"));

    await waitFor(() => expect(state.saveGlobalLorebook).toHaveBeenCalled());
    expect(state.saveGlobalLorebook).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [
          expect.objectContaining({ keys: ["王都", "首都"] }),
          expect.objectContaining({ keys: ["新关键词"], content: "新内容", enabled: true }),
        ],
      })
    );
  });
});
