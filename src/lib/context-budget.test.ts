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
  // 320 token,预算 200:砍 P5 作者注(80)→240,再砍 P3 世界书(104)→136 ≤ 200 停止。
  // P1【对话摘要】(55)幸存、历史也在预算内 → 不得再做整段替换,否则会出现第二份摘要。
  it("砍完 P5/P3 已回到预算内:不整段替换,也不追加第二份摘要", () => {
    const r = shrinkMessages(msgs, 200, { mode: "auto", summary: "压缩摘要" });
    expect(r.messages.some((m) => m.content.startsWith("【作者注】"))).toBe(false);
    expect(r.messages.some((m) => m.content.startsWith("【世界设定】"))).toBe(true);
    // P1 摘要幸存,且只此一份;不得再追加 `【对话摘要】\n压缩摘要`
    expect(r.messages.filter((m) => m.content.startsWith("【对话摘要】"))).toHaveLength(1);
    expect(r.messages.some((m) => m.content === "【对话摘要】\n压缩摘要")).toBe(false);
    // 历史未被替换:user 与上一条 assistant 都保留
    expect(r.messages.some((m) => m.role === "user" && m.content === msgs[1]?.content)).toBe(true);
    expect(r.messages.some((m) => m.role === "assistant" && m.content === msgs[2]?.content)).toBe(
      true
    );
    expect(r.total).toBe(136); // 55 + 13 + 13 + 55
    expect(r.over).toBe(false);
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

  it("砍完 P5 已在预算内(162 ≤ 170)时不整段替换,历史原样保留", () => {
    const r = shrinkMessages(input, 170, { mode: "auto", summary: "压缩摘要" });

    // 门控 remaining > budget:砍光 P5 后已回到预算内,即使有摘要也不替换。
    expect(r.messages.map((m) => m.content)).toEqual([
      p0.content,
      lore.content,
      user.content,
      assistant.content,
    ]);
    expect(r.messages.some((m) => m.content.startsWith("【对话摘要】"))).toBe(false);
    expect(r.total).toBe(40 + 42 + 40 + 40); // 162
    expect(r.over).toBe(false);
  });
});

// ── P0-1 回归:整段替换时最后一条 user(本轮输入)必须保留 ──────────────
// token 手算(全部 ASCII,0.25/字):
//   P0 "S"+159×"a" = 40;user1 "Q"+159×"b" = 40;assistant "A"+159×"c" = 40;
//   user2(本轮输入)"U"+159×"d" = 40;合计 160。预算 100:
//   无可砍的 system 段,砍完仍 160 > 100,有摘要 → 触发整段替换。
//   摘要 "压缩摘要" = 4 CJK = 2.4 → 2;被替换的历史(user1+assistant)= 80 > 2 → 替换。
describe("shrinkMessages 历史整段替换(保留本轮 user)", () => {
  const p0 = mk("S" + "a".repeat(159)); // 40
  const user1 = { role: "user" as const, content: "Q" + "b".repeat(159) }; // 40
  const assistant = { role: "assistant" as const, content: "A" + "c".repeat(159) }; // 40
  const user2 = { role: "user" as const, content: "U" + "d".repeat(159) }; // 40
  const input = [p0, user1, assistant, user2]; // 160

  it("超预算且有摘要:摘要 + 最后一条 user 保留,更早历史被替换", () => {
    const r = shrinkMessages(input, 100, { mode: "auto", summary: "压缩摘要" });

    expect(r.messages.some((m) => m.content === "【对话摘要】\n压缩摘要")).toBe(true);
    // 本轮输入必须原样保留,且是最后一条
    const last = r.messages[r.messages.length - 1];
    expect(last).toEqual(user2);
    // 更早的历史被替换掉
    expect(r.messages.some((m) => m.content === user1.content)).toBe(false);
    expect(r.messages.some((m) => m.content === assistant.content)).toBe(false);
    expect(r.messages.some((m) => m.content === p0.content)).toBe(true);
    // 摘要消息 "【对话摘要】\n压缩摘要" = 3.6 + 0.25(\n) + 2.4 = 6.25 → 6
    expect(r.total).toBe(40 + 6 + 40); // 86
    expect(r.over).toBe(false);
  });

  it("无摘要且超预算:保留历史(绝不静默删光),over=true", () => {
    const r = shrinkMessages(input, 60, { mode: "auto" });
    expect(r.messages.map((m) => m.content)).toEqual(input.map((m) => m.content));
    expect(r.messages.filter((m) => m.role === "user")).toHaveLength(2);
    expect(r.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(r.total).toBe(160);
    expect(r.over).toBe(true);
  });
});

// ── T-111:附件/世界状态必须识别为 P5 可变尾部,超预算时可裁 ──────────
describe("segmentMessages 附件 / 世界状态（T-111）", () => {
  const p0 = mk("S" + "a".repeat(159)); // 40 token
  const user = { role: "user" as const, content: "Q" + "b".repeat(159) }; // 40
  const attachment = mk("【数据银行 / 聊天附件】\n" + "c".repeat(400)); // ≈ 100+
  const worldState = mk("【世界状态】\n" + "d".repeat(400)); // ≈ 100+
  const input = [p0, user, attachment, worldState];

  it("两类段都归入 P5（不是 P0 稳定前缀）", () => {
    const r = shrinkMessages(input, 100000, { mode: "manual" });
    const byName = new Map(r.segments.map((s) => [s.name, s.priority]));
    expect(byName.get("聊天附件")).toBe(5);
    expect(byName.get("世界状态")).toBe(5);
    // 不得落入「稳定前缀」P0
    const p0Tokens = r.segments
      .filter((s) => s.priority === 0)
      .reduce((sum, s) => sum + s.tokens, 0);
    expect(p0Tokens).toBe(40);
  });

  it("超预算时大附件/世界状态被裁掉，P0 与历史保留", () => {
    const r = shrinkMessages(input, 50, { mode: "auto" });
    expect(r.messages.some((m) => m.content.startsWith("【数据银行 / 聊天附件】"))).toBe(false);
    expect(r.messages.some((m) => m.content.startsWith("【世界状态】"))).toBe(false);
    expect(r.messages.some((m) => m.content === p0.content)).toBe(true);
    expect(r.messages.some((m) => m.content === user.content)).toBe(true);
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

// T-112 — context_window 0/NaN/负数会把预算打成 0/NaN，
// auto 模式随即把**任意**会话判超限并走摘要替换。预算必须有限、正数且有下限。
describe("budgetFor 坏 context_window 回退(T-112)", () => {
  const cfg = { mode: "auto" as const, usage_pct: 90, default_context_window: 8192 };
  const withWindow = (w: number) => ({ parameters: { context_window: w } }) as never;

  it("0 → 回退默认窗口(8192×90%=7372)", () => {
    expect(budgetFor(withWindow(0), cfg)).toBe(7372);
  });

  it("NaN → 回退默认窗口", () => {
    expect(budgetFor(withWindow(Number.NaN), cfg)).toBe(7372);
  });

  it("负数 → 回退默认窗口", () => {
    expect(budgetFor(withWindow(-1000), cfg)).toBe(7372);
  });

  it("Infinity → 回退默认窗口", () => {
    expect(budgetFor(withWindow(Number.POSITIVE_INFINITY), cfg)).toBe(7372);
  });

  it("正数但低于下限 → 抬到 1024(1024×90% = 921)", () => {
    expect(budgetFor(withWindow(400), cfg)).toBe(921);
  });

  it("cfg.default_context_window 为 0/NaN → 8192 兜底", () => {
    expect(budgetFor(undefined, { ...cfg, default_context_window: 0 })).toBe(7372);
    expect(
      budgetFor(undefined, { ...cfg, default_context_window: Number.NaN as unknown as number })
    ).toBe(7372);
  });

  it("usage_pct 为 NaN 不得让预算变 NaN", () => {
    expect(budgetFor(undefined, { ...cfg, usage_pct: Number.NaN })).toBe(7372);
    expect(Number.isFinite(budgetFor(undefined, { ...cfg, usage_pct: Number.NaN }))).toBe(true);
  });
});
