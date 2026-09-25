// lib/regex-import.test.ts — 酒馆正则套件导入单测
//
// 全部基于**真实事故**（2026-09-25）：开发者把 `FF5 Regex 3.0 Suite.json`
// 当预设导入，应用回「这是角色卡」。根因两处，这里各钉一条：
//   1. 该文件根是**数组**，而 parseCharacterJson 对数组取字段会凑出空白角色卡 → 误报
//   2. 应用没有「正则套件」这种文件的解析器 → 只能落到兜底分支
//
// 另外钉住能力边界：promptOnly 的脚本本应用生效不了，必须被数出来而不是混进规则。

import { describe, it, expect } from "vitest";
import { looksLikeRegexSuite, parseTavernRegex, parseTavernRegexSuite } from "./regex-import";
import { parseCharacterJson } from "./character-card";
import { applyRegexRules } from "./regex-format";

/** 与真实文件同构的一条：带 /gi 标志、markdownOnly */
function script(over: Record<string, unknown> = {}) {
  return {
    id: "533cabce-8e08-4df5-ba60-b96c1d77e17c",
    scriptName: "FF5 Delete - Untagged Thoughts",
    findRegex: "/^\\s{0,20}([^<\\[\\s][\\s\\S]{0,30000}?)/gi",
    replaceString: "$2",
    trimStrings: [] as string[],
    placement: [2, 1],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    ...over,
  };
}

describe("误报根因：数组成不了角色卡", () => {
  it("JSON 数组一律不被 parseCharacterJson 接受（旧版会凑出空白卡）", () => {
    expect(parseCharacterJson(JSON.stringify([script(), script()]))).toBeNull();
  });

  it("空数组、字符串、数字也不是角色卡", () => {
    expect(parseCharacterJson("[]")).toBeNull();
    expect(parseCharacterJson('"just a string"')).toBeNull();
    expect(parseCharacterJson("42")).toBeNull();
    expect(parseCharacterJson("null")).toBeNull();
  });

  it("真正的 V2 卡仍然解析成功（守卫没有误伤）", () => {
    const v2 = JSON.stringify({
      spec: "chara_card_v2",
      data: { name: "芙兰", description: "幽灵" },
    });
    const card = parseCharacterJson(v2);
    expect(card?.name).toBe("芙兰");
    expect(card?.specVersion).toBe("2");
  });

  it("data 层是数组的畸形 V2 卡也被拒", () => {
    expect(parseCharacterJson(JSON.stringify({ spec: "chara_card_v2", data: [1, 2] }))).toBeNull();
  });
});

describe("套件识别", () => {
  it("每项都带 findRegex 的非空数组 → 是正则套件", () => {
    expect(looksLikeRegexSuite(JSON.stringify([script(), script()]))).toBe(true);
  });

  it("只要有一项缺 findRegex 就不算（避免误判其它数组）", () => {
    expect(looksLikeRegexSuite(JSON.stringify([script(), { name: "x" }]))).toBe(false);
  });

  it("空数组/非数组/坏 JSON 都不算", () => {
    expect(looksLikeRegexSuite("[]")).toBe(false);
    expect(looksLikeRegexSuite("{}")).toBe(false);
    expect(looksLikeRegexSuite("{ 不是 json")).toBe(false);
  });

  it("角色卡数组也不该被认成正则套件（卡没有 findRegex）", () => {
    const cards = JSON.stringify([{ name: "A", description: "b" }]);
    expect(looksLikeRegexSuite(cards)).toBe(false);
  });
});

describe("findRegex 解析（/pattern/flags）", () => {
  it("切出 pattern 与 flags，并保证带 g", () => {
    expect(parseTavernRegex("/abc/gi")).toEqual({ pattern: "abc", flags: "gi" });
    expect(parseTavernRegex("/abc/")).toEqual({ pattern: "abc", flags: "g" });
    expect(parseTavernRegex("/abc/i")).toEqual({ pattern: "abc", flags: "ig" });
  });

  it("pattern 内含**未转义**斜杠时按最后一个斜杠切（不是第一个）", () => {
    expect(parseTavernRegex("/a/b/c/gi")).toEqual({ pattern: "a/b/c", flags: "gi" });
  });

  it("转义的斜杠 `\\/` 不作为分隔符", () => {
    const r = parseTavernRegex("/a\\/b/gi");
    expect(r.pattern).toBe("a\\/b");
    expect(r.flags).toBe("gi");
  });

  it("非斜杠形态（裸 pattern）退化为直接使用、标志 g", () => {
    expect(parseTavernRegex("abc")).toEqual({ pattern: "abc", flags: "g" });
  });

  it("残缺形态（只有一个开头斜杠）不抛异常", () => {
    expect(parseTavernRegex("/abc")).toEqual({ pattern: "abc", flags: "g" });
  });
});

describe("套件导入与能力边界", () => {
  it("普通脚本转成 RegexRule：名字/pattern/replacement/启用态都对", () => {
    const r = parseTavernRegexSuite(JSON.stringify([script()]));
    expect(r.rules).toHaveLength(1);
    const rule = r.rules[0];
    expect(rule?.name).toBe("FF5 Delete - Untagged Thoughts");
    expect(rule?.pattern).toContain("[\\s\\S]");
    expect(rule?.replacement).toBe("$2");
    expect(rule?.enabled).toBe(true);
    expect(rule?.flags).toBe("gi");
    expect(rule?.id.startsWith("tavern-")).toBe(true);
  });

  it("promptOnly（placement=[2]）的脚本**照样导入**，并计入 promptCount", () => {
    // 2026-09-25 改：应用新增「出站清理」通路后，这 5 条不再是「做不到」，
    // 而是真支持 —— 所以旧版「跳过并计数」的断言在这里被反过来了。
    const r = parseTavernRegexSuite(
      JSON.stringify([
        script({ placement: [1] }),
        script({ promptOnly: true, placement: [2] }),
        script({ promptOnly: true, placement: [2] }),
      ])
    );
    expect(r.rules).toHaveLength(3);
    expect(r.displayCount).toBe(1);
    expect(r.promptCount).toBe(2);
  });

  it("placement 被保留：[2,1] 的规则两边都算", () => {
    const r = parseTavernRegexSuite(
      JSON.stringify([script({ placement: [2, 1] }), script({ placement: undefined })])
    );
    expect(r.rules[0]?.placement).toEqual([1, 2]);
    // 缺省 placement → 归一到「显示」，保持历史行为
    expect(r.rules[1]?.placement).toEqual([1]);
    expect(r.displayCount).toBe(2);
    expect(r.promptCount).toBe(1);
  });

  it("minDepth/maxDepth 被保留（Context Saver 是 minDepth=2）", () => {
    const r = parseTavernRegexSuite(
      JSON.stringify([script({ placement: [2], minDepth: 2, maxDepth: null })])
    );
    expect(r.rules[0]?.minDepth).toBe(2);
    expect(r.rules[0]?.maxDepth).toBeNull();
  });

  it("placement 是非法值时归一到「显示」，不抛", () => {
    const r = parseTavernRegexSuite(
      JSON.stringify([script({ placement: ["x", 9] }), script({ placement: [] })])
    );
    expect(r.rules[0]?.placement).toEqual([1]);
    expect(r.rules[1]?.placement).toEqual([1]);
  });

  it("disabled=true 的脚本导入后是关的，且计入 disabledCount", () => {
    const r = parseTavernRegexSuite(JSON.stringify([script({ disabled: true })]));
    expect(r.rules[0]?.enabled).toBe(false);
    expect(r.disabledCount).toBe(1);
  });

  it("坏项跳过而不是整包失败", () => {
    const bad = JSON.stringify([script(), null, 42, { scriptName: "没有 findRegex" }, script()]);
    const r = parseTavernRegexSuite(bad);
    expect(r.rules).toHaveLength(2);
  });

  it("非数组 / 坏 JSON 返回空结果，不抛", () => {
    expect(parseTavernRegexSuite("{}").rules).toEqual([]);
    expect(parseTavernRegexSuite("{ 坏").rules).toEqual([]);
  });
});

describe("导入后的规则真的能按 gi 生效", () => {
  it("带 i 标志：大小写不敏感匹配（这正是丢掉 i 会坏掉的地方）", () => {
    const r = parseTavernRegexSuite(
      JSON.stringify([script({ findRegex: "/hello/gi", replaceString: "X" })])
    );
    const rules = r.rules;
    expect(applyRegexRules("Hello world HELLO", rules)).toBe("X world X");
  });

  it("内置规则（不带 flags 字段）行为不变：仍按 g 全部替换", () => {
    const builtin = [{ id: "b", name: "b", pattern: "a", replacement: "z", enabled: true }];
    expect(applyRegexRules("aaa", builtin)).toBe("zzz");
  });

  it("未启用的规则不生效", () => {
    const rules = [
      { id: "b", name: "b", pattern: "a", replacement: "z", enabled: false, flags: "gi" },
    ];
    expect(applyRegexRules("aaa", rules)).toBe("aaa");
  });
});
