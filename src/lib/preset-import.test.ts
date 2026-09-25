// lib/preset-import.test.ts — 酒馆预设导入解析单测
//
// 钉住三件事（2026-09-25 全局条目名册改造）：
//   1. 每条打上 group（包名）与 order（prompts 原序）——UI 分区与拼装顺序都靠它；
//   2. enabled 读酒馆自带的 prompt_order 标记，而不是拍脑袋默认；
//   3. 「（默认组合）」**恒定不启用** —— 实测真实数据里它有 65762 字符，
//      一开就顶爆上下文预算，这条必须机械钉死。

import { describe, it, expect } from "vitest";
import { parseTavernPresets } from "./preset-import";

/** 造一个酒馆 ImpExp 导出：两个条目，一个启用一个不启用 */
function exportJson() {
  return JSON.stringify({
    name: "TestPack",
    prompts: [
      { identifier: "main", name: "Main Prompt", content: "A".repeat(50) },
      { identifier: "nsfw", name: "NSFW Mode", content: "B".repeat(50) },
      { identifier: "tiny", name: "TooShort", content: "xy" }, // 应被 >10 过滤掉
    ],
    prompt_order: [
      {
        order: [
          { identifier: "main", enabled: true },
          { identifier: "nsfw", enabled: false },
        ],
      },
    ],
  });
}

describe("parseTavernPresets：分组 / 次序 / 启用标记", () => {
  it("每条都带 group=（包名），且是同一个包", () => {
    const out = parseTavernPresets(exportJson());
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((p) => p.group === "TestPack")).toBe(true);
  });

  it("order：默认组合排 -1，其余按 prompts 原序 0,1", () => {
    const out = parseTavernPresets(exportJson());
    const combo = out.find((p) => p.name.includes("默认组合"));
    const main = out.find((p) => p.name === "Main Prompt");
    const nsfw = out.find((p) => p.name === "NSFW Mode");
    expect(combo?.order).toBe(-1);
    expect(main?.order).toBe(0);
    expect(nsfw?.order).toBe(1);
  });

  it("enabled 读 prompt_order：启用的为 true、未启用的为 false", () => {
    const out = parseTavernPresets(exportJson());
    expect(out.find((p) => p.name === "Main Prompt")?.enabled).toBe(true);
    expect(out.find((p) => p.name === "NSFW Mode")?.enabled).toBe(false);
  });

  it("「（默认组合）」恒定 enabled=false —— 它实测有 6.5 万字，不能默认开", () => {
    const out = parseTavernPresets(exportJson());
    const combo = out.find((p) => p.name.includes("默认组合"));
    expect(combo).toBeTruthy();
    expect(combo?.enabled).toBe(false);
  });

  it("过短条目（<=10 字符）被过滤，不生成条目", () => {
    const out = parseTavernPresets(exportJson());
    expect(out.find((p) => p.name === "TooShort")).toBeUndefined();
  });

  it("没有 prompt_order 时：不抛异常，条目 enabled 为 false", () => {
    const raw = JSON.stringify({
      name: "NoOrder",
      prompts: [{ identifier: "x", name: "X", content: "C".repeat(30) }],
    });
    const out = parseTavernPresets(raw);
    const x = out.find((p) => p.name === "X");
    expect(x?.enabled).toBe(false);
    expect(x?.group).toBe("NoOrder");
  });

  it("单条预设（格式1）：默认启用，且自成一组", () => {
    const raw = JSON.stringify({ name: "SoloPreset", system_prompt: "you are {{char}}" });
    const out = parseTavernPresets(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.enabled).toBe(true);
    expect(out[0]?.group).toBe("SoloPreset");
    expect(out[0]?.order).toBe(0);
  });

  it("坏 JSON 返回空数组，不抛", () => {
    expect(parseTavernPresets("{ 不是 json")).toEqual([]);
  });

  it("prompts 全为空内容时返回空数组（不生成只有默认组合的结果）", () => {
    const raw = JSON.stringify({ name: "Empty", prompts: [{ name: "a", content: "x" }] });
    expect(parseTavernPresets(raw)).toEqual([]);
  });
});
