// stores/chat/rp-messages.test.ts — RP 三段式组装的回归测试
//
// 这里钉住的是**顺序与位置**：三段式一旦被改乱，DeepSeek 缓存命中率会掉下来，
// 而界面上完全看不出来（回复照常，只是变慢变贵）。

import { describe, it, expect } from "vitest";
import { assembleRpMessages } from "./rp-messages";
import type { Message } from "@/types";

const msg = (role: Message["role"], content: string) => ({ role, content }) as Message;

describe("assembleRpMessages", () => {
  it("三段式顺序：system(stable) → 历史 → 世界书 → 摘要；历史里的 system 被丢弃", () => {
    const out = assembleRpMessages({
      stableSystem: "STABLE",
      history: [
        msg("system", "旧的 system 应被丢掉"),
        msg("user", "第一句"),
        msg("assistant", "第一答"),
      ],
      lorebook: "LORE",
      summary: "SUM",
    });
    expect(out.map((m) => m.content)).toEqual([
      "STABLE",
      "第一句",
      "第一答",
      "LORE",
      "【对话摘要】\nSUM",
    ]);
    expect(out.every((m) => m.content !== "旧的 system 应被丢掉")).toBe(true);
  });

  it("深度提示词按既有规则 1+depth 定位；对话不够长时不注入", () => {
    const history = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
    const out = assembleRpMessages({
      stableSystem: "STABLE",
      history,
      depthPrompt: { depth: 2, prompt: "别忘了伏笔" },
    });
    // ⚠️ 位置是「stableSystem 之后第 1+depth 条」——这是原实现的行为（从顶部数），
    //    与酒馆「距底部 N 条」的语义并不相同。本测试钉住的是**现有行为**，
    //    要改成距底部语义，得单独做一次并确认缓存前缀影响。
    expect(out[3]).toEqual({ role: "system", content: "【深度提示词】\n别忘了伏笔" });

    const tooShort = assembleRpMessages({
      stableSystem: "STABLE",
      history: [msg("user", "只有一句")],
      depthPrompt: { depth: 5, prompt: "不该出现" },
    });
    expect(tooShort.some((m) => m.content.includes("不该出现"))).toBe(false);
  });

  it("没有世界书与摘要时不产生多余消息（历史原样保留）", () => {
    const out = assembleRpMessages({
      stableSystem: "STABLE",
      history: [msg("user", "hi"), msg("assistant", "hello")],
    });
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });
});
