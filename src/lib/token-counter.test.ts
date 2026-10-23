// lib/token-counter.test.ts — 估算口径的最小回归(CJK 0.6/字,其余 0.25/字,合计四舍五入)
import { describe, it, expect } from "vitest";
import { countTokens } from "./token-counter";

describe("countTokens", () => {
  it("CJK:你好世界 = 4 × 0.6 = 2.4 → 2", () => {
    expect(countTokens("你好世界")).toBe(2);
  });

  it("英文:hello world = 11 × 0.25 = 2.75 → 3", () => {
    expect(countTokens("hello world")).toBe(3);
  });

  it("混合:中文ab = 2 × 0.6 + 2 × 0.25 = 1.7 → 2", () => {
    expect(countTokens("中文ab")).toBe(2);
  });

  it("空串 = 0", () => {
    expect(countTokens("")).toBe(0);
  });
});
