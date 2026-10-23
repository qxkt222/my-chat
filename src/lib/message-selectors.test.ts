// lib/message-selectors.test.ts — SRC-03 回归
//
// 背景(2026-10-23 审计):TavernView 的消息 map 里对每一行执行
//   `m.role === "assistant" && active.messages.slice(mi + 1).every(...)`
// → 每行复制尾部数组,整体 O(n²);流式期间每帧都跑一遍。
//
// 本文件钉住的契约:
//   1. lastAssistantIndex 的返回值与「从后往前找第一条 assistant」完全一致;
//   2. 200 条消息的边界正确(尾部有 user 也不影响);
//   3. 实现不得调用 Array.prototype.slice(复杂度证据:slice 是 O(n²) 的来源);
//   4. isLastAssistantMessage 只在「该行是 assistant 且后面没有 assistant」时为 true。

import { describe, it, expect, vi } from "vitest";
import { lastAssistantIndex, isLastAssistantMessage } from "./message-selectors";

type Role = "user" | "assistant" | "system";
interface M {
  role: Role;
}

const u = (): M => ({ role: "user" });
const a = (): M => ({ role: "assistant" });
const s = (): M => ({ role: "system" });

describe("lastAssistantIndex", () => {
  it("空数组 → -1", () => {
    expect(lastAssistantIndex([])).toBe(-1);
  });

  it("只有 user/system → -1", () => {
    expect(lastAssistantIndex([u(), s(), u()])).toBe(-1);
  });

  it("返回最后一条 assistant 的下标", () => {
    expect(lastAssistantIndex([u(), a(), u(), a(), u()])).toBe(3);
  });

  it("尾部全是 user 时仍指向最后一条 assistant", () => {
    expect(lastAssistantIndex([u(), a(), u(), u(), u()])).toBe(1);
  });

  it("200 条消息:最后一条 assistant 在 197,尾部两条 user", () => {
    // 0..197 交替 user/assistant → 197 是 assistant
    const msgs: M[] = Array.from({ length: 198 }, (_, i) => (i % 2 === 1 ? a() : u()));
    msgs.push(u(), u());
    expect(msgs.length).toBe(200);
    expect(lastAssistantIndex(msgs)).toBe(197);
  });

  it("复杂度:不调用 Array.prototype.slice", () => {
    const msgs: M[] = Array.from({ length: 200 }, (_, i) => (i % 2 === 1 ? a() : u()));
    const spy = vi.spyOn(Array.prototype, "slice");
    try {
      lastAssistantIndex(msgs);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("isLastAssistantMessage", () => {
  const msgs: M[] = [u(), a(), u(), a(), u()];

  it("最后一条 assistant → true", () => {
    expect(isLastAssistantMessage(msgs, 3)).toBe(true);
  });

  it("更早的 assistant(后面还有 assistant)→ false", () => {
    expect(isLastAssistantMessage(msgs, 1)).toBe(false);
  });

  it("role 不是 assistant 的行 → false", () => {
    expect(isLastAssistantMessage(msgs, 4)).toBe(false);
  });

  it("越界下标 → false", () => {
    expect(isLastAssistantMessage(msgs, -1)).toBe(false);
    expect(isLastAssistantMessage(msgs, 99)).toBe(false);
  });

  it("200 条消息与逐行扫描结果一致", () => {
    const big: M[] = Array.from({ length: 200 }, (_, i) => (i % 2 === 1 ? a() : u()));
    // 逐行参照实现(旧的 O(n²) 写法),只用来对拍
    const reference = (idx: number) =>
      big[idx]?.role === "assistant" && big.slice(idx + 1).every((x) => x.role !== "assistant");
    for (let i = 0; i < big.length; i += 1) {
      expect(isLastAssistantMessage(big, i)).toBe(reference(i));
    }
    // 199 是 assistant → 197 后面还有 assistant,所以不是最后一条
    expect(isLastAssistantMessage(big, 197)).toBe(false);
    expect(isLastAssistantMessage(big, 199)).toBe(true);
  });
});
