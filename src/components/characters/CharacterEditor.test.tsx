// @vitest-environment jsdom
// components/characters/CharacterEditor.test.tsx — 内嵌世界书保存路径的数据保真契约
//
// T-022:旧实现把 textarea 的「关键词:内容」行格式重新解析成新条目，导致
// constant/selective/keyssecondary/position/probability 等字段全丢、book 元数据
// 被重置、含换行内容被拆行截断。这里锁定：只改角色名/单条内容时，未编辑字段
// 必须原样保留(未编辑条目甚至保持原对象引用)。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { CharacterCard, CharacterBook, LoreEntry } from "@/types";

const storeState = vi.hoisted(() => ({
  saveCharacter: vi.fn(async () => {}),
  createCharacter: vi.fn(async () => {}),
  createPersona: vi.fn(async () => {}),
}));

vi.mock("@/stores/useCharacterStore", () => ({
  useCharacterStore: () => ({
    presets: [],
    lorebooks: {},
    saveCharacter: storeState.saveCharacter,
    createCharacter: storeState.createCharacter,
    createPersona: storeState.createPersona,
  }),
}));

vi.mock("@/lib/tauri", () => ({
  pickFile: vi.fn(async () => null),
  readFileBytes: vi.fn(async () => ""),
  getAppDir: vi.fn(async () => "C:/app"),
  writeFileBytes: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));

vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key }));

vi.mock("@/components/ui/Toast", () => ({ showToast: vi.fn() }));

import { CharacterEditor } from "./CharacterEditor";

const LORE_PLACEHOLDER = "每行一条:关键词1,关键词2:条目内容(对话中出现关键词时自动注入)";

function makeEntry(over: Partial<LoreEntry> = {}): LoreEntry {
  return {
    keys: ["王都", "首都"],
    keyssecondary: ["夜晚", "月光"],
    content: "第一行\n第二行",
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
    ...over,
  };
}

function makeBook(entry: LoreEntry): CharacterBook {
  return {
    name: "王都设定",
    description: "书描述",
    scan_depth: 9,
    token_budget: 777,
    entries: [entry],
  };
}

function makeCard(book?: CharacterBook): CharacterCard {
  return {
    id: "c1",
    specVersion: "2",
    name: "阿狸",
    description: "d",
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "",
    character_version: "",
    character_book: book,
    avatarPath: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function savedCard(): CharacterCard {
  const call = storeState.saveCharacter.mock.calls[0] as unknown[] | undefined;
  return call?.[0] as CharacterCard;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("CharacterEditor 保存内嵌世界书", () => {
  it("只改角色名 → book 元数据与全部条目字段原样保留(条目仍是原对象)", async () => {
    const entry = makeEntry();
    const book = makeBook(entry);
    render(<CharacterEditor card={makeCard(book)} onClose={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue("阿狸"), { target: { value: "新名字" } });
    fireEvent.click(screen.getByText("settings.save"));

    await waitFor(() => expect(storeState.saveCharacter).toHaveBeenCalledTimes(1));
    const saved = savedCard();
    expect(saved.name).toBe("新名字");
    // book 的 name/scan_depth/token_budget 不被重置
    expect(saved.character_book).toEqual(book);
    // 未编辑的条目对象被直接复用 → 所有高级字段必然不变
    expect(saved.character_book?.entries[0]).toBe(entry);
  });

  it("多行内容在显示层被转义为一条,保存时仍按原条目合并", () => {
    const entry = makeEntry();
    render(<CharacterEditor card={makeCard(makeBook(entry))} onClose={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(LORE_PLACEHOLDER) as HTMLTextAreaElement;
    // \n 是字面反斜杠+n:多行内容不会在 textarea 里变成两行(否则会被拆成两条)
    expect(textarea.value).toBe("王都,首都:第一行\\n第二行");
  });

  it("只改某条的关键词/内容 → 该条其余高级字段与 book 元数据不变", async () => {
    const entry = makeEntry();
    const book = makeBook(entry);
    render(<CharacterEditor card={makeCard(book)} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText(LORE_PLACEHOLDER), {
      target: { value: "王都,首都:新内容" },
    });
    fireEvent.click(screen.getByText("settings.save"));

    await waitFor(() => expect(storeState.saveCharacter).toHaveBeenCalledTimes(1));
    const saved = savedCard();
    const out = saved.character_book;
    expect(out?.name).toBe("王都设定");
    expect(out?.description).toBe("书描述");
    expect(out?.scan_depth).toBe(9);
    expect(out?.token_budget).toBe(777);
    const outEntry = out?.entries[0];
    expect(outEntry?.keys).toEqual(["王都", "首都"]);
    expect(outEntry?.content).toBe("新内容");
    // 显示层不可编辑的字段全部保留
    expect(outEntry?.keyssecondary).toEqual(["夜晚", "月光"]);
    expect(outEntry?.constant).toBe(true);
    expect(outEntry?.selective).toBe(true);
    expect(outEntry?.insertion_order).toBe(5);
    expect(outEntry?.position).toBe("after_char");
    expect(outEntry?.enabled).toBe(false);
    expect(outEntry?.comment).toBe("注释");
    expect(outEntry?.case_sensitive).toBe(true);
    expect(outEntry?.probability).toBe(70);
    expect(outEntry?.recursive).toBe(true);
    expect(outEntry?.regex).toBe(true);
    expect(outEntry?.match_whole_words).toBe(true);
    expect(outEntry?.min_activations).toBe(2);
  });
});
