// lib/sim-prompt.test.ts — 推演提示词/骰子数据化/时间线分层
import { describe, it, expect } from "vitest";
import {
  rollDice,
  parseTimelineLines,
  parseStateText,
  parseTimeLabel,
  buildSimSystemParts,
} from "./sim-prompt";

function conv(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    title: "t",
    created_at: "",
    updated_at: "",
    messages: [],
    type: "story",
    stateMode: "text",
    pacing: "turn",
    stateUpdate: "every",
    autoRounds: 3,
    setup: "维多利亚伦敦",
    worldState: "",
    stateTable: {},
    timeLabel: "第 1 天",
    timeline: [],
    ...over,
  } as never;
}

describe("buildSimSystemParts 三段式", () => {
  it("三类型指令不同且含设定", () => {
    const story = buildSimSystemParts({ conv: conv({ type: "story" }), recentMessages: [] });
    const tactical = buildSimSystemParts({ conv: conv({ type: "tactical" }), recentMessages: [] });
    expect(story.stableSystem).toContain("剧情推演");
    expect(tactical.stableSystem).toContain("数值裁定");
    expect(story.stableSystem).toContain("维多利亚伦敦");
  });

  it("stateBlock 按 stateMode 形态输出", () => {
    const text = buildSimSystemParts({
      conv: conv({ stateMode: "text", worldState: "伦敦迷雾" }),
      recentMessages: [],
    });
    expect(text.stateBlock).toContain("伦敦迷雾");
    const none = buildSimSystemParts({ conv: conv({ stateMode: "none" }), recentMessages: [] });
    expect(none.stateBlock).not.toContain("世界状态");
  });

  it("钉住/回锚/观察者注入稳定前缀", () => {
    const p = buildSimSystemParts({
      conv: conv({ pinned: "爱丽丝是主角", anchor: "王都陷落", observerMode: true }),
      recentMessages: [],
    });
    expect(p.stableSystem).toContain("【钉住】");
    expect(p.stableSystem).toContain("王都陷落");
    expect(p.stableSystem).toContain("旁观模式");
  });
});

describe("rollDice 骰子数据化", () => {
  it("带阈值结构化返回", () => {
    const r = rollDice("D100", 65);
    expect(typeof r.roll).toBe("number");
    expect(r.threshold).toBe(65);
    expect(r.pass === true || r.pass === false).toBe(true);
    expect(r.text).toMatch(/🎲 \[D100\] \d+/);
  });
  it("无阈值 pass=null", () => {
    expect(rollDice("D20").pass).toBeNull();
  });
});

describe("parseTimelineLines 时间线分层", () => {
  it("里程碑/日志/常规识别", () => {
    const tl = parseTimelineLines(
      "[里程碑] 第 5 天:王国联盟成立\n[时间线] 第 6 天:北境出兵\n[日志] 第 7 天:粮草-10",
      "当前"
    );
    expect(tl.length).toBe(3);
    expect(tl[0]?.kind).toBe("milestone");
    expect(tl[1]?.kind).toBeUndefined();
    expect(tl[2]?.kind).toBe("log");
  });
});

describe("parseStateText / parseTimeLabel", () => {
  it("解析状态段与当前时间", () => {
    expect(parseStateText("正文\n【状态】\n局势紧张\n[时间线] 第 3 天:突破")).toBe("局势紧张");
    expect(parseTimeLabel("【当前时间】第 5 天\n正文", "第 1 天")).toBe("第 5 天");
  });
});
