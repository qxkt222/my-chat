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

// ── 多段裁剪回归:必须按「原始下标」记账 ──────────────────────────────
// 消息与 token 全部手算(token-counter:CJK 0.6/字,其余 0.25/字,合计四舍五入):
//   P0          "S" + 159×"a"        = 160 × 0.25                    = 40
//   user        "Q" + 159×"b"        = 160 × 0.25                    = 40
//   assistant   "A" + 159×"c"        = 160 × 0.25                    = 40
//   作者注      "【作者注】"(2.3) + 160×"d"(40)  = 42.3              → 42
//   世界书      "【世界书】"(2.3) + 160×"e"(40)  = 42.3              → 42
//   深度提示词  "【深度提示词】"(3.5) + 160×"f"(40) = 43.5           → 44
//   状态        "【状态】"(1.7) + 160×"g"(40)    = 41.7              → 42
//   合计 290;三个 P5 共 42+44+42=128。预算 170:砍光 P5 后 162 ≤ 170,
//   因此必须停在 P3 之前 —— 世界书保留,P0 与最近 user/assistant 轮也保留。
describe("shrinkMessages 多段裁剪(原始下标回归)", () => {
  const p0 = mk("S" + "a".repeat(159)); // 40
  const user = { role: "user" as const, content: "Q" + "b".repeat(159) }; // 40
  const assistant = { role: "assistant" as const, content: "A" + "c".repeat(159) }; // 40
  const authorNote = mk("【作者注】" + "d".repeat(160)); // 42
  const lore = mk("【世界书】" + "e".repeat(160)); // 42
  const depth = mk("【深度提示词】" + "f".repeat(160)); // 44
  const state = mk("【状态】" + "g".repeat(160)); // 42
  const input = [p0, user, assistant, authorNote, lore, depth, state]; // 290

  it("砍两段以上时只砍最低优先级,世界书与最近轮保留", () => {
    const r = shrinkMessages(input, 170, { mode: "auto" });

    // 期望:保留 P0 + 世界书 + 两条历史(顺序:先保留的 system 段,后历史)
    expect(r.messages.map((m) => m.content)).toEqual([
      p0.content,
      lore.content,
      user.content,
      assistant.content,
    ]);
    expect(r.messages.filter((m) => m.role === "user" || m.role === "assistant")).toHaveLength(2);
    expect(r.messages.some((m) => m.content.startsWith("【作者注】"))).toBe(false);
    expect(r.messages.some((m) => m.content.startsWith("【深度提示词】"))).toBe(false);
    expect(r.messages.some((m) => m.content.startsWith("【状态"))).toBe(false);
    expect(r.messages.some((m) => m.content.startsWith("【对话摘要】"))).toBe(false);
    expect(r.total).toBe(40 + 42 + 40 + 40); // 162
    expect(r.over).toBe(false);
  });

  it("历史被砍时整段替换为【对话摘要】,原历史消息不再出现", () => {
    const r = shrinkMessages(input, 170, { mode: "auto", summary: "压缩摘要" });

    // 摘要 4 个 CJK = 2.4 → 2 token,小于历史 80,故整段替换。
    expect(r.messages.some((m) => m.content === "【对话摘要】\n压缩摘要")).toBe(true);
    expect(r.messages.some((m) => m.role === "user" || m.role === "assistant")).toBe(false);
    expect(r.messages.some((m) => m.content === user.content)).toBe(false);
    expect(r.messages.some((m) => m.content === assistant.content)).toBe(false);
    // P0 与世界书仍保留;P5 全砍。
    expect(r.messages.some((m) => m.content === p0.content)).toBe(true);
    expect(r.messages.some((m) => m.content === lore.content)).toBe(true);
    expect(r.messages.some((m) => m.content.startsWith("【深度提示词】"))).toBe(false);
    // 摘要消息 "【对话摘要】\n压缩摘要" = 2.3 + 0.25(\n) + 2.4 = 5.55 → 6
    expect(r.total).toBe(40 + 42 + 6); // 88
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
