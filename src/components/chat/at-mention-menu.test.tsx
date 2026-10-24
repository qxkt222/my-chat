// @vitest-environment jsdom
//
// components/chat/at-mention-menu.test.tsx — @ 菜单按子模式隐藏条目
//
// 缺陷背景：「对话」子模式不支持技能 / 知识库（发送前已被拒绝），
// 但共享的 AtMentionMenu 仍把它们列出来，用户选中后才收到“不支持”提示。
// 新接口 hideKinds 在**菜单层**就过滤掉这些条目。
//
// 契约：
//   1. 不传 hideKinds → 技能 / 命令 / 知识库 / 会话全部照旧渲染（酒馆 & 工作不变）；
//   2. hideKinds=["skill","knowledge"] → 这两类不渲染，命令等其余条目仍在；
//   3. 可只隐藏其中一类。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { createRef } from "react";

import { AtMentionMenu, type AtMentionMenuHandle } from "./AtMentionMenu";
import { useSkillStore } from "@/stores/useSkillStore";
import { useKnowledgeStore } from "@/stores/useKnowledgeStore";
import { useConversationStore } from "@/stores/useConversationStore";
import type { KnowledgeBase, Skill } from "@/types";

const SKILL: Skill = {
  id: "s1",
  name: "SkillA",
  description: "skill desc",
  systemPrompt: "PROMPT",
  model: "",
  temperature: null,
  category: "",
  tags: [],
  created_at: "2026-10-23T00:00:00.000Z",
  updated_at: "2026-10-23T00:00:00.000Z",
};

const KB: KnowledgeBase = {
  id: "k1",
  name: "KnowledgeA",
  description: "kb desc",
  created_at: "2026-10-23T00:00:00.000Z",
};

function renderMenu(hideKinds?: Array<"skill" | "knowledge">, skillsOverride?: Skill[]) {
  const ref = createRef<AtMentionMenuHandle>();
  render(
    <AtMentionMenu
      ref={ref}
      trigger=""
      highlight={0}
      onHighlightChange={vi.fn()}
      onSelect={vi.fn()}
      {...(hideKinds ? { hideKinds } : {})}
      {...(skillsOverride ? { skillsOverride } : {})}
    />
  );
}

beforeEach(() => {
  // jsdom 没有实现 Element.scrollTo（组件挂载时会滚动列表到顶部）
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  useSkillStore.setState({ skills: [SKILL] } as never);
  useKnowledgeStore.setState({ bases: [KB] } as never);
  useConversationStore.setState({ conversations: [] } as never);
});

afterEach(() => cleanup());

describe("AtMentionMenu.hideKinds", () => {
  it("不传 hideKinds：技能 / 知识库 / 命令都渲染（现有行为不变）", () => {
    renderMenu();

    expect(screen.getByText("SkillA")).toBeTruthy();
    expect(screen.getByText("KnowledgeA")).toBeTruthy();
    expect(screen.getByText("/translate")).toBeTruthy();
  });

  it("hideKinds=[skill, knowledge]：两类条目不渲染，命令仍在", () => {
    renderMenu(["skill", "knowledge"]);

    expect(screen.queryByText("SkillA")).toBeNull();
    expect(screen.queryByText("KnowledgeA")).toBeNull();
    expect(screen.getByText("/translate")).toBeTruthy();
  });

  it("只隐藏 skill 时知识库仍可见", () => {
    renderMenu(["skill"]);

    expect(screen.queryByText("SkillA")).toBeNull();
    expect(screen.getByText("KnowledgeA")).toBeTruthy();
  });
});

describe("AtMentionMenu.skillsOverride（对话子模式只列 lite 技能）", () => {
  const SKILL_LITE: Skill = { ...SKILL, id: "s2", name: "SkillLite", lite_enabled: true };

  it("传入过滤后的技能列表时只显示这些技能，知识库分组不受影响", () => {
    useSkillStore.setState({ skills: [SKILL, SKILL_LITE] } as never);
    renderMenu(undefined, [SKILL_LITE]);

    expect(screen.getByText("SkillLite")).toBeTruthy();
    expect(screen.queryByText("SkillA")).toBeNull();
    expect(screen.getByText("KnowledgeA")).toBeTruthy();
    expect(screen.getByText("/translate")).toBeTruthy();
  });
});
