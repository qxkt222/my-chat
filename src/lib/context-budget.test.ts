// lib/context-budget.test.ts — Token 预算收缩(自动/手动双模式,历史整段替换)
import { describe, it, expect } from "vitest";
import { shrinkMessages, budgetFor } from "./context-budget";

const mk = (text: string) => ({ role: "system" as const, content: text });
const msgs = [
  mk("【世界设定】稳定前缀" + "x".repeat(200)),
  { role: "user" as const, content: "问1" + "y".repeat(50) },
  { role: "assistant" as const, content: "答1" + "z".repeat(50) },
  mk("【世界书】背景" + "w".repeat(400)),
  mk("【对话摘要】摘要内容" + "s".repeat(200)),
  mk("【作者注】紧张氛围" + "n".repeat(300)),
];

describe("shrinkMessages 自动模式", () => {
  it("超限时砍 P5 作者注,历史整段替换为摘要,P0 前缀保留", () => {
    const r = shrinkMessages(msgs, 200, { mode: "auto", summary: "压缩摘要" });
    expect(r.messages.some((m) => m.content.startsWith("【作者注】"))).toBe(false);
    expect(r.messages.some((m) => m.content.startsWith("【对话摘要】"))).toBe(true);
    expect(r.messages.some((m) => m.content.startsWith("【世界设定】"))).toBe(true);
  });

  it("大预算不砍", () => {
    const r = shrinkMessages(msgs, 100000, { mode: "auto" });
    expect(r.messages.length).toBe(msgs.length);
    expect(r.over).toBe(false);
  });
});

describe("shrinkMessages 手动模式", () => {
  it("保留全部,只标记 over", () => {
    const r = shrinkMessages(msgs, 50, { mode: "manual" });
    expect(r.messages.length).toBe(msgs.length);
    expect(r.over).toBe(true);
  });
});

describe("budgetFor", () => {
  const cfg = { mode: "auto" as const, usage_pct: 90, default_context_window: 8192 };
  it("默认窗口 × 90%", () => expect(budgetFor(undefined, cfg)).toBe(7372));
  it("模型覆盖窗口", () =>
    expect(budgetFor({ parameters: { context_window: 128000 } } as never, cfg)).toBe(115200));
});
