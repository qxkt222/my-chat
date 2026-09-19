// lib/memory-graph.test.ts — 记忆图谱抽取(人物/关系边/地点/跳转)
import { describe, it, expect } from "vitest";
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
});
