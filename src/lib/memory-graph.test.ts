// lib/memory-graph.test.ts — 记忆图谱抽取(人物/关系边/地点/跳转)
import { describe, it, expect, vi } from "vitest";
import { extractGraph } from "./memory-graph";

describe("extractGraph", () => {
  it("抽取人物节点 + 关系边(宿敌/盟友)+ 地点 + refMsgId", () => {
    const g = extractGraph(
      [
        { id: "m1", role: "assistant", content: "「爱丽丝」走进大厅,「男爵」是她的宿敌。" },
        { id: "m2", role: "assistant", content: "「爱丽丝」与「圣殿骑士」是盟友。" },
      ],
      "王都 王都 王都",
      30
    );
    expect(g.nodes.some((n) => n.label === "爱丽丝" && n.kind === "person")).toBe(true);
    expect(g.edges.some((e) => e.relation === "宿敌")).toBe(true);
    expect(g.edges.some((e) => e.relation === "盟友")).toBe(true);
    expect(g.nodes.some((n) => n.label === "王都" && n.kind === "place")).toBe(true);
    expect(g.nodes.find((n) => n.label === "爱丽丝")?.refMsgId).toBe("m1");
  });

  it("关系正则只在模块加载时预编译，抽取过程不再现场构造（T-140）", async () => {
    const NativeRegExp = globalThis.RegExp;
    let constructed = 0;
    class CountingRegExp extends NativeRegExp {
      // matchAll 会按 species 克隆正则；克隆走原生 RegExp，不算「现场构造」
      static override get [Symbol.species]() {
        return NativeRegExp;
      }
      constructor(pattern: string | RegExp, flags?: string) {
        super(pattern, flags);
        constructed += 1;
      }
    }

    vi.resetModules();
    vi.stubGlobal("RegExp", CountingRegExp);
    try {
      const mod: typeof import("./memory-graph") = await import("./memory-graph");
      const afterImport = constructed;
      expect(afterImport).toBeGreaterThan(0); // 预编译发生在模块加载期

      mod.extractGraph(
        Array.from({ length: 200 }, (_, i) => ({
          id: `m${i}`,
          role: "assistant",
          content: `「爱丽丝」与「男爵」是盟友。第 ${i} 条消息。`,
        })),
        "",
        30
      );

      // 200 条消息 × 18 个关系词，旧实现会构造 3600 个 RegExp；预编译后为 0
      expect(constructed).toBe(afterImport);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
