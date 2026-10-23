// lib/regex-cache.test.ts — 正则编译缓存单测
//
// 钉住的核心事实（2026-10-23 SRC-14）：
//   1. 同 (pattern, flags) 必须命中缓存、返回**同一个实例** —— 否则流式 token
//      每帧重编译 N 条规则的问题等于没修；
//   2. 无效 pattern / 非法 flags 返回 null，**不抛** —— 调用方据此「跳过坏规则」，
//      错误处理语义与原来的 try/catch 等价；
//   3. 不同 flags 绝不复用（g 与 i 是两个编译产物）；
//   4. `g` 标志的 RegExp 有状态（lastIndex），取用时必须归零，否则跨调用串状态；
//   5. 超长 pattern 直接拒绝并只告警一次（ReDoS 的最小长度闸门）。

import { describe, it, expect, beforeEach, vi } from "vitest";
import { compileRegex, clearRegexCache, MAX_PATTERN_LENGTH } from "./regex-cache";

beforeEach(() => {
  // 每个用例从空缓存开始：实例身份断言才可重复
  clearRegexCache();
});

describe("compileRegex：缓存与实例复用", () => {
  it("同 pattern + 同 flags 返回同一个 RegExp 实例（命中不重建）", () => {
    const a = compileRegex("a+b", "gi");
    const b = compileRegex("a+b", "gi");
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("缺省 flags 与显式空串是同一个 key（同一个实例）", () => {
    const a = compileRegex("a+b");
    const b = compileRegex("a+b", "");
    expect(a).toBe(b);
  });

  it("不同 flags 不复用同一实例", () => {
    const g = compileRegex("a", "g");
    const i = compileRegex("a", "i");
    expect(g).not.toBe(i);
    expect(g?.flags).toBe("g");
    expect(i?.flags).toBe("i");
  });
});

describe("compileRegex：错误处理（不抛）", () => {
  it("无效 pattern 返回 null 而不是抛异常", () => {
    expect(() => compileRegex("([")).not.toThrow();
    expect(compileRegex("([")).toBeNull();
  });

  it("非法 flags 返回 null 而不是抛异常", () => {
    expect(() => compileRegex("a", "zz")).not.toThrow();
    expect(compileRegex("a", "zz")).toBeNull();
  });

  it("空 pattern 返回 null（调用方本就跳过空规则）", () => {
    expect(compileRegex("")).toBeNull();
  });

  it("无效 pattern 的 null 结果可重复取用（不抛、结果稳定）", () => {
    expect(compileRegex("([")).toBeNull();
    expect(compileRegex("([")).toBeNull();
  });
});

describe("compileRegex：g 标志的 lastIndex 语义", () => {
  it("每次取用都把 lastIndex 归零（跨调用不串状态）", () => {
    const re = compileRegex("a", "g");
    expect(re).not.toBeNull();
    // 用一次 exec，推进 lastIndex 到 1
    expect(re?.exec("aa")?.index).toBe(0);
    expect(re?.lastIndex).toBe(1);

    // 重新取用：同一实例，但 lastIndex 已被归零
    const again = compileRegex("a", "g");
    expect(again).toBe(re);
    expect(again?.lastIndex).toBe(0);
    // 于是下一次 exec 仍从字符串开头开始（不会跳过第一个 a）
    expect(again?.exec("aa")?.index).toBe(0);
  });

  it("取用后在同一实例上连续 exec 仍按 JS 语义推进", () => {
    const re = compileRegex("a", "g");
    expect(re?.exec("aa")?.index).toBe(0);
    expect(re?.exec("aa")?.index).toBe(1);
    expect(re?.exec("aa")).toBeNull();
  });

  it("String.replace 全量替换不受上一次 lastIndex 影响", () => {
    compileRegex("a", "g")?.exec("aa"); // 污染 lastIndex
    const re = compileRegex("a", "g");
    expect("aaa".replace(re as RegExp, "z")).toBe("zzz");
  });
});

describe("compileRegex：超长 pattern 闸门（ReDoS 最小缓解）", () => {
  it("超过 MAX_PATTERN_LENGTH 直接返回 null", () => {
    const long = "a".repeat(MAX_PATTERN_LENGTH + 1);
    expect(compileRegex(long)).toBeNull();
  });

  it("恰好 MAX_PATTERN_LENGTH 仍可编译（边界值不误杀）", () => {
    const ok = "a".repeat(MAX_PATTERN_LENGTH);
    expect(compileRegex(ok)).toBeInstanceOf(RegExp);
  });

  it("告警只发一次（同一进程内不刷屏）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      compileRegex("b".repeat(MAX_PATTERN_LENGTH + 1));
      compileRegex("c".repeat(MAX_PATTERN_LENGTH + 1));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
