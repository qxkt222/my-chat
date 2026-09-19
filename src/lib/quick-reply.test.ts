// lib/quick-reply.test.ts — Quick Reply + STscript 轻量(宏替换/[roll]/[ask])
import { describe, it, expect } from "vitest";
import { renderQuickReply } from "./quick-reply";

describe("renderQuickReply", () => {
  it("[roll] 动作替换为骰子文本", () => {
    const r = renderQuickReply(
      { id: "t", name: "掷骰", template: "[roll D100 65]" },
      { char: "芙兰", user: "玩家", input: "hi" }
    );
    expect(r.text).toMatch(/🎲 \[D100\] \d+/);
    expect(r.ask).toBeNull();
  });

  it("[ask] 提取问题 + 宏替换", () => {
    const r = renderQuickReply(
      { id: "t2", name: "加注", template: "[ask 注入什么?]{{char}}问候{{user}}" },
      { char: "芙兰", user: "玩家", input: "" }
    );
    expect(r.ask).toBe("注入什么?");
    expect(r.text).toContain("芙兰问候玩家");
  });
});
