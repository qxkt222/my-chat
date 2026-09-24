// lib/rp-prompt.test.ts — 角色扮演三段式(深度提示词/正则世界书/摘要)
import { describe, it, expect } from "vitest";
import {
  buildRpSystemParts,
  buildRpSystemPrompt,
  collectLorebookText,
  collectLorebookTextWithTimed,
  injectAuthorNote,
  resolveVarMacros,
} from "./rp-prompt";
import type { CharacterCard } from "@/types";

const card = {
  id: "c1",
  specVersion: "3",
  name: "芙兰",
  description: "幽灵",
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
  extensions: undefined,
  depth_prompt: { depth: 10, prompt: "{{char}} 的秘密即将揭晓" },
  avatarPath: "",
  presetId: undefined,
  favorite: undefined,
  created_at: "",
  updated_at: "",
} as CharacterCard;

describe("buildRpSystemParts", () => {
  it("深度提示词带出且宏替换", () => {
    const p = buildRpSystemParts({
      card,
      persona: null,
      preset: null,
      lorebooks: [],
      recentMessages: [],
      currentInput: "hi",
    });
    expect(p.depthPrompt?.prompt).toContain("芙兰");
    expect(p.depthPrompt?.prompt).not.toContain("{{char}}");
  });

  it("无深度提示词 → undefined", () => {
    const p = buildRpSystemParts({
      card: { ...card, depth_prompt: undefined },
      persona: null,
      preset: null,
      lorebooks: [],
      recentMessages: [],
      currentInput: "x",
    });
    expect(p.depthPrompt).toBeUndefined();
  });
});

describe("collectLorebookText 正则世界书", () => {
  it("正则关键词命中 + 常规关键词命中", () => {
    const text = collectLorebookText(
      [{ entries: [{ keys: ["王都|首都"], content: "王都是首都", regex: true }] }],
      [{ role: "user", content: "去王都" }],
      ""
    );
    expect(text).toContain("王都是首都");
  });

  it("regex 编译失败回退字面量", () => {
    const text = collectLorebookText(
      [{ entries: [{ keys: ["([bad"], content: "坏规则" }] }],
      [{ role: "user", content: "([bad 出现" }],
      ""
    );
    expect(text).toContain("坏规则");
  });

  it("全词匹配:词边界命中才注入(酒馆 Match Whole Words)", () => {
    // "cat" 全词匹配在 "category" 中不应命中;在 "cat" 独立词中命中
    const text = collectLorebookText(
      [{ entries: [{ keys: ["cat"], content: "猫条目", match_whole_words: true }] }],
      [{ role: "user", content: "I have a category about cats." }],
      ""
    );
    expect(text).not.toContain("猫条目");
    const hit = collectLorebookText(
      [{ entries: [{ keys: ["cat"], content: "猫条目", match_whole_words: true }] }],
      [{ role: "user", content: "I have a cat." }],
      ""
    );
    expect(hit).toContain("猫条目");
  });

  it("最小激活:关键词出现 ≥ N 次才注入(酒馆 Min Activations)", () => {
    // min_activations=2,只出现 1 次 → 不注入
    const once = collectLorebookText(
      [{ entries: [{ keys: ["王都"], content: "王都条目", min_activations: 2 }] }],
      [{ role: "user", content: "去王都。" }],
      ""
    );
    expect(once).not.toContain("王都条目");
    // 出现 2 次 → 注入
    const twice = collectLorebookText(
      [{ entries: [{ keys: ["王都"], content: "王都条目", min_activations: 2 }] }],
      [{ role: "user", content: "去王都,再回王都。" }],
      ""
    );
    expect(twice).toContain("王都条目");
  });
});

describe("buildRpSystemPrompt 向后兼容", () => {
  it("单字符串含摘要", () => {
    const s = buildRpSystemPrompt({
      card,
      persona: null,
      preset: null,
      lorebooks: [],
      recentMessages: [],
      currentInput: "q",
      summary: "此前调查了律师",
    });
    expect(s).toContain("【对话摘要】");
    expect(s).toContain("此前调查了律师");
  });
});

describe("injectAuthorNote 作者注四维", () => {
  const base = [
    { role: "system" as const, content: "stable" },
    { role: "user" as const, content: "u1" },
    { role: "assistant" as const, content: "a1" },
    { role: "user" as const, content: "u2" },
  ];

  it("prompt 模式:插在最后一条 user 之前(system 角色)", () => {
    const out = injectAuthorNote(base, { text: "保持冷酷", position: "prompt", role: "system" });
    const lastUser = out.map((m) => m.role).lastIndexOf("user");
    expect(out[lastUser - 1]?.role).toBe("system");
    expect(out[lastUser - 1]?.content).toContain("保持冷酷");
  });

  it("in_chat 模式:在第 depth 条消息后插入(role=user)", () => {
    const out = injectAuthorNote(base, {
      text: "内部状态",
      position: "in_chat",
      depth: 2,
      role: "user",
    });
    expect(out[3]?.role).toBe("user");
    expect(out[3]?.content).toBe("内部状态");
  });

  it("无 note 文本 → 原数组不动", () => {
    const out = injectAuthorNote(base, { text: "  " });
    expect(out).toEqual(base);
  });
});

describe("resolveVarMacros 消息变量", () => {
  it("{{var::name}} / {{getvar::name}} 替换,未定义为空串", () => {
    expect(
      resolveVarMacros("我是{{var::npc}},遇到{{getvar::place}}", { npc: "老村长", place: "酒馆" })
    ).toBe("我是老村长,遇到酒馆");
    expect(resolveVarMacros("x{{var::missing}}y", {})).toBe("xy");
  });

  it("无变量 → 原样返回", () => {
    expect(resolveVarMacros("普通文本", undefined)).toBe("普通文本");
  });
});

describe("collectLorebookTextWithTimed 定时世界书", () => {
  it("sticky 命中后进入常驻(stickyContents)", () => {
    const r = collectLorebookTextWithTimed(
      [{ entries: [{ keys: ["火"], content: "火焰已燃起", sticky: true }] }],
      [{ role: "user", content: "点火" }],
      "",
      undefined
    );
    expect(r.text).toContain("火焰已燃起");
    expect(r.stickyHits).toContain("火焰已燃起");
  });

  it("cooldown 命中后,下一轮关键词不命中也不注入,且冷却递减", () => {
    const books = [{ entries: [{ keys: ["王"], content: "王座条目", cooldown: 2 }] }];
    // 第一轮:命中,返回冷却 2
    const r1 = collectLorebookTextWithTimed(
      books,
      [{ role: "user", content: "见王" }],
      "",
      undefined
    );
    expect(r1.text).toContain("王座条目");
    expect(r1.cooldownHits["王座条目"]).toBe(2);
    // 第二轮:上一轮 cooldown=2 → 递减为 1,仍在冷却 → 关键词不命中也不注入
    const r2 = collectLorebookTextWithTimed(books, [{ role: "user", content: "见王" }], "", {
      stickyContents: [],
      cooldownLeft: r1.cooldownHits,
    });
    expect(r2.text).not.toContain("王座条目");
    // 第三轮:递减为 0 → 恢复命中
    const r3 = collectLorebookTextWithTimed(books, [{ role: "user", content: "见王" }], "", {
      stickyContents: [],
      cooldownLeft: r2.cooldownHits,
    });
    expect(r3.text).toContain("王座条目");
  });

  it("sticky 常驻内容即使关键词不命中也注入", () => {
    const r = collectLorebookTextWithTimed(
      [{ entries: [{ keys: ["无关"], content: "普通条目" }] }],
      [{ role: "user", content: "其他话题" }],
      "",
      { stickyContents: ["火焰常驻"], cooldownLeft: {} }
    );
    expect(r.text).toContain("火焰常驻");
    expect(r.text).not.toContain("普通条目");
  });
});
