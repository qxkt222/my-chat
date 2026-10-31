// lib/lorebook-import.test.ts — 世界书导入的次级关键词别名契约
import { describe, it, expect } from "vitest";
import { parseLorebook } from "./lorebook-import";

describe("parseLorebook 次级关键词别名", () => {
  it("secondary_keys / keysecondary 均归一为内部 keyssecondary", () => {
    const raw = JSON.stringify({
      name: "测试书",
      entries: [
        { keys: ["a"], secondary_keys: ["s1", "s2"], content: "c1" },
        { keys: ["b"], keysecondary: ["s3"], content: "c2" },
        { keys: ["c"], keysecondary: "s4, s5", content: "c3" },
      ],
    });
    const book = parseLorebook(raw);
    expect(book?.entries.map((e) => e.keyssecondary)).toEqual([["s1", "s2"], ["s3"], ["s4", "s5"]]);
  });

  it("无次级关键词时保持 undefined(不伪造空数组)", () => {
    const raw = JSON.stringify({ entries: [{ keys: ["a"], content: "c1" }] });
    expect(parseLorebook(raw)?.entries[0]?.keyssecondary).toBeUndefined();
  });
});
