// @vitest-environment jsdom
// components/skills/SkillManager.test.tsx — 「对话模式可用」的界面契约
//
// 契约：
//   1. 列表里只有 lite_enabled=true 的技能显示「对话」徽标；
//   2. 编辑弹层有「对话模式可用」复选框，默认未勾选；
//   3. 勾选后保存，create 载荷必须带 lite_enabled=true（否则开关形同虚设）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";

import type { Skill } from "@/types";

const storeState = vi.hoisted(() => ({
  skills: [] as unknown[],
  create: vi.fn(),
  remove: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/stores/useSkillStore", () => ({
  useSkillStore: (sel: (s: typeof storeState) => unknown) => sel(storeState),
}));

vi.mock("@/stores/useMemoryStore", () => ({
  useMemoryStore: () => ({ allTags: () => [] }),
}));

vi.mock("@/lib/tauri", () => ({
  mcpListServers: vi.fn(async () => []),
  mcpListTools: vi.fn(async () => []),
}));

vi.mock("@/lib/i18n", () => ({
  useT: () => (key: string) => key,
}));

import { SkillManager } from "./SkillManager";

function skill(over: Partial<Skill> = {}): Skill {
  return {
    id: "s1",
    name: "S1",
    description: "",
    systemPrompt: "p",
    model: "",
    temperature: null,
    category: "",
    tags: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  storeState.skills = [];
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("SkillManager 对话模式可用", () => {
  it("只为 lite_enabled 的技能渲染徽标", () => {
    storeState.skills = [
      skill({ id: "a", name: "A", lite_enabled: true }),
      skill({ id: "b", name: "B", lite_enabled: false }),
      skill({ id: "c", name: "C" }),
    ];
    render(<SkillManager />);
    expect(screen.getAllByText("skills.liteBadge")).toHaveLength(1);
  });

  it("编辑弹层有复选框，勾选后 create 携带 lite_enabled=true", async () => {
    render(<SkillManager />);

    fireEvent.click(screen.getByText("skills.new"));
    expect(screen.getByText("skills.liteEnabled")).toBeTruthy();

    const cb = screen.getByRole("checkbox") as HTMLInputElement;
    expect(cb.checked).toBe(false);
    fireEvent.click(cb);

    fireEvent.click(screen.getByText("settings.save"));

    await waitFor(() =>
      expect(storeState.create).toHaveBeenCalledWith(
        expect.objectContaining({ lite_enabled: true })
      )
    );
  });
});

// T-103：openEdit 曾用裸 JSON.parse —— JSON 合法但非数组时把对象塞进 tools，
// 渲染期 `edit.tools.includes` 抛错白屏。现在降级为 [] 并提示。
describe("SkillManager 坏 JSON 字段降级", () => {
  /** 找到某个技能卡片并点开编辑 */
  function openEditOf(name: string) {
    const row = screen.getByText(name).closest(".border");
    if (!row) throw new Error("找不到技能行");
    const editBtn = within(row as HTMLElement).getAllByRole("button")[0];
    if (!editBtn) throw new Error("找不到编辑按钮");
    fireEvent.click(editBtn);
  }

  it("tools_json 是合法 JSON 但非数组：不崩溃、可打开编辑、降级为空并提示", async () => {
    storeState.skills = [
      skill({ id: "bad", name: "Bad", tools_json: '{"oops":true}', memory_tags: '["m1"]' }),
    ];
    render(<SkillManager />);

    // 列表渲染不抛错
    expect(screen.getByText("Bad")).toBeTruthy();

    openEditOf("Bad");
    // 编辑弹层正常打开（此前这里渲染期就抛错了）
    expect(screen.getByText("skills.edit")).toBeTruthy();
    expect(screen.getByText(/技能数据异常.*tools_json/)).toBeTruthy();

    fireEvent.click(screen.getByText("settings.save"));
    await waitFor(() =>
      expect(storeState.save).toHaveBeenCalledWith(
        expect.objectContaining({ tools_json: "[]", memory_tags: '["m1"]' })
      )
    );
  });

  it("坏 JSON 字符串：两个字段都降级为空，仍可保存", async () => {
    storeState.skills = [
      skill({ id: "bad2", name: "Bad2", tools_json: "{oops", memory_tags: "not-json" }),
    ];
    render(<SkillManager />);

    openEditOf("Bad2");
    const warning = screen.getByText(/技能数据异常/);
    expect(warning.textContent).toContain("tools_json");
    expect(warning.textContent).toContain("memory_tags");

    fireEvent.click(screen.getByText("settings.save"));
    await waitFor(() =>
      expect(storeState.save).toHaveBeenCalledWith(
        expect.objectContaining({ tools_json: "[]", memory_tags: "[]" })
      )
    );
  });
});
