// stores/tavern/assembly.test.ts — 发送流程纯逻辑的回归测试
//
// 这三块决定「发给模型的东西长什么样」，其中三段式顺序直接关系到 DeepSeek 的
// 缓存命中率 —— 而缓存失效在界面上完全看不出来（回复照常，只是慢且贵）。
// 所以它们值得有测试，而且必须是**钉住顺序**的测试，不是「跑得通就行」。

import { describe, it, expect } from "vitest";
import { assembleApiMessages, collectLorebooks, makeSamplerPicker } from "./assembly";
import type { CharacterBook, ModelParameters } from "@/types";

// ── 世界书四源合并 ─────────────────────────────────────────
describe("collectLorebooks", () => {
  // 注意 CharacterBook 的真实形状：{ name?, entries } —— 没有 id 字段
  const main: CharacterBook = { name: "主世界书", entries: [] };
  const embedded: CharacterBook = { name: "角色内嵌", entries: [] };
  const globalA: CharacterBook = { name: "全局 A", entries: [] };
  const personaA: CharacterBook = { name: "Persona A", entries: [] };
  const convA: CharacterBook = { name: "会话 A", entries: [] };

  it("四类来源合并，同一 id 在多个来源出现只算一次", () => {
    const books = collectLorebooks({
      globalLorebook: main,
      card: { character_book: embedded, lorebookIds: ["ga"] },
      enabledIds: ["ga"], // 与 card.lorebookIds 重复
      personaIds: ["pa"],
      convIds: ["ca", "pa"], // 与 Persona 重复
      byId: { ga: globalA, pa: personaA, ca: convA },
    });
    expect(books.map((b) => b.name)).toEqual(["主世界书", "角色内嵌", "全局 A", "Persona A", "会话 A"]);
  });

  it("空书（null / undefined / id 找不到）一律过滤掉", () => {
    const books = collectLorebooks({
      globalLorebook: null,
      card: { character_book: undefined, lorebookIds: [] },
      enabledIds: ["不存在"],
      personaIds: [],
      convIds: [],
      byId: {},
    });
    expect(books).toEqual([]);
  });

  it("主世界书恒在首位、角色内嵌第二（顺序即优先级）", () => {
    const books = collectLorebooks({
      globalLorebook: main,
      card: { character_book: embedded, lorebookIds: [] },
      enabledIds: [],
      personaIds: [],
      convIds: [],
      byId: {},
    });
    expect(books[0]?.name).toBe("主世界书");
    expect(books[1]?.name).toBe("角色内嵌");
  });
});

// ── 采样器回退链 ──────────────────────────────────────────
describe("makeSamplerPicker", () => {
  const defaults = { temperature: 0.9, top_p: 0.95 } as ModelParameters;

  it("会话预设优先于模型参数与全局默认", () => {
    const pick = makeSamplerPicker(
      { temperature: 0.3 },
      { temperature: 0.5 } as ModelParameters,
      defaults
    );
    expect(pick("temperature")).toBe(0.3);
  });

  it("会话没设时退到模型参数，都没有才用全局默认；三处全无则 null", () => {
    const pick = makeSamplerPicker({}, { temperature: 0.5 } as ModelParameters, defaults);
    expect(pick("temperature")).toBe(0.5); // 退到模型参数
    expect(pick("top_p")).toBe(0.95); // 再退到全局默认
    expect(pick("min_p")).toBeNull(); // 三处都没有 → 该字段不发送
  });
});

// ── 三段式消息组装 ────────────────────────────────────────
describe("assembleApiMessages", () => {
  const history = [
    { role: "user" as const, content: "第一句" },
    { role: "assistant" as const, content: "第一答" },
  ];

  it("system 在首、user 在末，历史夹在中间", () => {
    const msgs = assembleApiMessages({
      stableSystem: "STABLE",
      history,
      userContent: "新输入",
    });
    expect(msgs[0]).toEqual({ role: "system", content: "STABLE" });
    expect(msgs[1]).toEqual({ role: "user", content: "第一句" });
    expect(msgs[2]).toEqual({ role: "assistant", content: "第一答" });
    expect(msgs.at(-1)).toEqual({ role: "user", content: "新输入" });
  });

  it("钉住区紧跟 stableSystem（在历史之前）；空钉住不产生额外消息", () => {
    const withPin = assembleApiMessages({
      stableSystem: "STABLE",
      pinned: "  别忘了我怕黑  ",
      history,
      userContent: "新输入",
    });
    expect(withPin[1]).toEqual({ role: "system", content: "【钉住】\n别忘了我怕黑" });

    const withoutPin = assembleApiMessages({ stableSystem: "STABLE", history, userContent: "x" });
    expect(withoutPin).toHaveLength(4); // system + 2 条历史 + user，没有多出来的系统消息
  });

  it("尾部三块顺序固定：世界书 → 摘要 → 附件，且都排在 user 之前", () => {
    const msgs = assembleApiMessages({
      stableSystem: "STABLE",
      history,
      lorebook: "LORE",
      summary: "SUM",
      attachmentBlock: "ATT",
      userContent: "新输入",
    });
    const tail = msgs.slice(-4).map((m) => m.content);
    expect(tail).toEqual(["LORE", "【对话摘要】\nSUM", "ATT", "新输入"]);
    expect(msgs.at(-1)?.role).toBe("user");
  });
});
