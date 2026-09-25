// lib/outgoing-regex.test.ts — 出站正则清理单测
//
// 钉住的核心事实（2026-09-25）：那套 FF5 预设里有 25 条 placement=[2] 的脚本，
// 它们**只改发给模型的消息**，不改界面显示。若把它们混进渲染期规则，
// 用户自己的思考块会凭空消失 —— 所以「显示」与「出站」必须是两条独立通路。
//
// 用例直接采用那几条脚本的**真实 findRegex**，不是自造的近似正则。

import { describe, it, expect } from "vitest";
import { applyOutgoingRegex, depthAllows, activeOutgoingCount } from "./outgoing-regex";
import { appliesToDisplay, appliesToPrompt } from "./regex-format";
import type { RegexRule } from "./regex-format";
import type { Message } from "@/types";

/** 造一条出站规则（默认 placement=[2]） */
function outRule(over: Partial<RegexRule> = {}): RegexRule {
  return {
    id: "r",
    name: "r",
    pattern: "x",
    replacement: "",
    enabled: true,
    flags: "g",
    placement: [2],
    ...over,
  };
}

/** 造消息时收窄 role 的类型（对象字面量默认被推成 string） */
function msg(
  role: "user" | "assistant" | "system",
  content: string
): Pick<Message, "role" | "content"> {
  return { role, content };
}

/** 那几条 promptOnly 脚本的真实正则（逐字取自 FF5 Regex 3.0 Suite.json） */
const REAL = {
  contextSaver:
    "(?:<!--\\s{0,8}GFX_START\\s{0,8}-->|<internal_states>)[\\s\\S]{0,50000}?(?:<!--\\s{0,8}GFX_END\\s{0,8}-->|<\\/internal_states>|$)",
  gfxStripper:
    "<!-- GFX_START -->\\s{0,8}<div[^>]{0,200}?>([\\s\\S]{0,20000}?)<\\/div>\\s{0,8}<!-- GFX_END -->",
  imagePrompt: "<!--\\s{0,8}IMG_PROMPT:[\\s\\S]{0,4000}?-->",
  thoughts:
    "(?:<\\s{0,8}(?:think|thinking|thought|thoughts|reasoning|internal_monologue|internal\\s+monologue)\\b[^>]{0,120}>[\\s\\S]{0,20000}?<\\s{0,8}\\/\\s{0,8}(?:think|thinking|thought|thoughts|reasoning|internal_monologue|internal\\s+monologue)[^>]{0,120}>)",
};

describe("位置分流：显示 vs 出站", () => {
  it("placement=[2] 只进出站，不进显示", () => {
    const r = outRule({ placement: [2] });
    expect(appliesToPrompt(r)).toBe(true);
    expect(appliesToDisplay(r)).toBe(false);
  });

  it("placement=[1] 只进显示", () => {
    const r = outRule({ placement: [1] });
    expect(appliesToDisplay(r)).toBe(true);
    expect(appliesToPrompt(r)).toBe(false);
  });

  it("placement=[1,2] 两边都进", () => {
    const r = outRule({ placement: [1, 2] });
    expect(appliesToDisplay(r)).toBe(true);
    expect(appliesToPrompt(r)).toBe(true);
  });

  it("缺省 placement = 只进显示（历史行为不能变）", () => {
    const r: RegexRule = { id: "b", name: "b", pattern: "a", replacement: "z", enabled: true };
    expect(appliesToDisplay(r)).toBe(true);
    expect(appliesToPrompt(r)).toBe(false);
  });
});

describe("真实脚本的剥离效果", () => {
  it("Image Prompt Stripper：剥掉 <!-- IMG_PROMPT:…-->", () => {
    const msgs = [msg("assistant", "正文 <!-- IMG_PROMPT: a photo of X --> 结尾")];
    const out = applyOutgoingRegex(msgs, [
      outRule({ pattern: REAL.imagePrompt, replacement: "", flags: "gi" }),
    ]);
    expect(out[0]?.content).toBe("正文  结尾");
    expect(out[0]?.content).not.toContain("IMG_PROMPT");
  });

  it("Context Saver：剥掉 <internal_states> 整块", () => {
    const msgs = [
      msg("assistant", "可见正文\n<internal_states>一大坨状态</internal_states>\n尾巴"),
    ];
    const out = applyOutgoingRegex(msgs, [
      outRule({ pattern: REAL.contextSaver, replacement: "", flags: "gi" }),
    ]);
    expect(out[0]?.content).not.toContain("internal_states");
    expect(out[0]?.content).toContain("可见正文");
  });

  it("GFX Stripper：剥掉包裹 div，只留里面正文（$1）", () => {
    const msgs = [
      msg("assistant", '<!-- GFX_START --><div class="x">保留的正文</div><!-- GFX_END -->'),
    ];
    const out = applyOutgoingRegex(msgs, [
      outRule({ pattern: REAL.gfxStripper, replacement: "$1", flags: "gi" }),
    ]);
    expect(out[0]?.content).toBe("保留的正文");
  });

  it("Hapuppy Delete Thoughts：剥掉 <thinking> 块", () => {
    const msgs = [msg("assistant", "回答\n<thinking>内心戏</thinking>\n完")];
    const out = applyOutgoingRegex(msgs, [
      outRule({ pattern: REAL.thoughts, replacement: "", flags: "gi" }),
    ]);
    expect(out[0]?.content).not.toContain("内心戏");
    expect(out[0]?.content).toContain("回答");
  });

  it("几条一起上：一整条含全部标记的消息被清干净", () => {
    const dirty =
      "回答正文\n<internal_states>状态</internal_states>\n<!-- IMG_PROMPT: prompt -->\n" +
      "<!-- GFX_START --><div>图形</div><!-- GFX_END -->\n<thinking>想法</thinking>";
    const rules = [
      outRule({ pattern: REAL.contextSaver, replacement: "", flags: "gi" }),
      outRule({ pattern: REAL.imagePrompt, replacement: "", flags: "gi" }),
      outRule({ pattern: REAL.gfxStripper, replacement: "$1", flags: "gi" }),
      outRule({ pattern: REAL.thoughts, replacement: "", flags: "gi" }),
    ];
    const out = applyOutgoingRegex([msg("assistant", dirty)], rules);
    const c = out[0]?.content ?? "";
    expect(c).toContain("回答正文");
    expect(c).not.toContain("internal_states");
    expect(c).not.toContain("IMG_PROMPT");
    expect(c).not.toContain("GFX_START");
    expect(c).not.toContain("想法");
  });
});

describe("安全与边界", () => {
  it("不原地改：原数组与原消息对象都不受污染", () => {
    const original = [msg("assistant", "a <internal_states>x</internal_states>")];
    const snapshot = original[0]?.content;
    const out = applyOutgoingRegex(original, [
      outRule({ pattern: REAL.contextSaver, replacement: "", flags: "gi" }),
    ]);
    expect(original[0]?.content).toBe(snapshot); // 原消息没被动
    expect(out[0]?.content).not.toBe(snapshot); // 返回的是新对象
  });

  it("system 消息不被出站规则改动（深度只数 user/assistant）", () => {
    const msgs = [
      msg("system", "system <internal_states>x</internal_states>"),
      msg("user", "user <internal_states>x</internal_states>"),
    ];
    const out = applyOutgoingRegex(msgs, [
      outRule({ pattern: REAL.contextSaver, replacement: "", flags: "gi" }),
    ]);
    expect(out[0]?.content).toContain("internal_states"); // system 原样
    expect(out[1]?.content).not.toContain("internal_states"); // user 被清
  });

  it("未启用的规则不生效", () => {
    const out = applyOutgoingRegex(
      [msg("user", "<internal_states>x")],
      [outRule({ enabled: false, pattern: REAL.contextSaver, replacement: "", flags: "gi" })]
    );
    expect(out[0]?.content).toContain("internal_states");
  });

  it("坏正则被跳过，不影响其它规则与原文", () => {
    const out = applyOutgoingRegex(
      [msg("user", "abc")],
      [outRule({ pattern: "([", replacement: "x" }), outRule({ pattern: "a", replacement: "z" })]
    );
    expect(out[0]?.content).toBe("zbc");
  });

  it("没有出站规则时原样返回同一个数组（零开销短路）", () => {
    const msgs = [msg("user", "abc")];
    expect(applyOutgoingRegex(msgs, [])).toBe(msgs);
    expect(applyOutgoingRegex(msgs, [outRule({ placement: [1] })])).toBe(msgs);
  });
});

describe("深度窗口（酒馆 minDepth/maxDepth）", () => {
  it("depthAllows：min/max 为 null 表示不限", () => {
    expect(depthAllows(outRule(), 0)).toBe(true);
    expect(depthAllows(outRule(), 99)).toBe(true);
  });

  it("depthAllows：minDepth=2 时 depth 0/1 不生效、2 起生效", () => {
    const r = outRule({ minDepth: 2, maxDepth: null });
    expect(depthAllows(r, 0)).toBe(false);
    expect(depthAllows(r, 1)).toBe(false);
    expect(depthAllows(r, 2)).toBe(true);
  });

  it("depthAllows：maxDepth 封顶", () => {
    const r = outRule({ minDepth: 0, maxDepth: 1 });
    expect(depthAllows(r, 0)).toBe(true);
    expect(depthAllows(r, 1)).toBe(true);
    expect(depthAllows(r, 2)).toBe(false);
  });

  it("Context Saver（minDepth=2）只清 depth≥2 的历史，最新两条保留", () => {
    const msgs = [
      msg("user", "旧 <internal_states>1</internal_states>"), // depth=2
      msg("assistant", "新 <internal_states>2</internal_states>"), // depth=1
      msg("user", "最新 <internal_states>3</internal_states>"), // depth=0
    ];
    const out = applyOutgoingRegex(msgs, [
      outRule({ pattern: REAL.contextSaver, replacement: "", flags: "gi", minDepth: 2 }),
    ]);
    expect(out[0]?.content).not.toContain("internal_states"); // depth=2 被清
    expect(out[1]?.content).toContain("internal_states"); // depth=1 保留
    expect(out[2]?.content).toContain("internal_states"); // depth=0 保留
  });

  it("activeOutgoingCount 只数启用的出站规则", () => {
    expect(
      activeOutgoingCount([
        outRule({ placement: [2] }),
        outRule({ placement: [1] }),
        outRule({ placement: [2], enabled: false }),
        outRule({ placement: [1, 2] }),
      ])
    ).toBe(2);
  });
});
