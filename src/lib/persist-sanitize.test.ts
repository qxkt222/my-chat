// lib/persist-sanitize.test.ts — 持久化边界的运行时校验（坏 JSON 结构不白屏）
import { describe, it, expect } from "vitest";
import {
  sanitizeRegexRule,
  sanitizeRegexRules,
  sanitizeBudgetConfig,
  sanitizeConnectionProfile,
  sanitizeConnectionProfiles,
  sanitizeCharacterBook,
  sanitizeCharacterCard,
  sanitizePersona,
  sanitizePersonas,
  sanitizeStringArray,
  parseErrorKind,
} from "./persist-sanitize";

describe("sanitizeRegexRule", () => {
  it("缺字段时给出合法默认对象，不抛", () => {
    expect(() => sanitizeRegexRule({})).not.toThrow();
    const r = sanitizeRegexRule({});
    expect(r.id).toBe("");
    expect(r.name).toBe("");
    expect(r.pattern).toBe("");
    expect(r.replacement).toBe("");
    expect(r.enabled).toBe(true);
    expect(r.placement).toBeUndefined();
  });

  it("placement 是字符串（坏数据）时退回默认显示语义，不产生 TypeError", () => {
    // 旧 bug：placement: "2" 会被 .includes 调用炸掉 → 消息区白屏
    const r = sanitizeRegexRule({ id: "a", placement: "2" });
    expect(r.placement).toBeUndefined();
  });

  it("placement 数组里混入非法值只保留 1/2", () => {
    const r = sanitizeRegexRule({ id: "a", placement: [1, "2", null, 2, 3] });
    expect(r.placement).toEqual([1, 2]);
  });

  it("placement 数组全是非法值时保留空数组（显式约束 = 哪都不生效）", () => {
    expect(sanitizeRegexRule({ id: "a", placement: ["2"] }).placement).toEqual([]);
  });

  it("flags/深度字段类型错误时忽略", () => {
    const r = sanitizeRegexRule({
      id: "a",
      flags: 123,
      minDepth: "3",
      maxDepth: null,
    });
    expect(r.flags).toBeUndefined();
    expect(r.minDepth).toBeUndefined();
    expect(r.maxDepth).toBeNull();
  });

  it("数组里混 null/非对象时过滤，不抛", () => {
    const list = sanitizeRegexRules([
      { id: "a", pattern: "x" },
      null,
      "garbage",
      { id: "b", placement: "2" },
    ]);
    expect(list.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("非数组输入返回空数组", () => {
    expect(sanitizeRegexRules({ x: 1 })).toEqual([]);
  });
});

describe("sanitizeBudgetConfig", () => {
  it("缺字段时使用默认配置", () => {
    expect(sanitizeBudgetConfig({})).toEqual({
      mode: "auto",
      usage_pct: 90,
      default_context_window: 8192,
    });
  });

  it("类型错误/越界值被替换或收敛", () => {
    const cfg = sanitizeBudgetConfig({
      mode: "manual",
      usage_pct: "80",
      default_context_window: -5,
    });
    expect(cfg.mode).toBe("manual");
    expect(cfg.usage_pct).toBe(90); // 类型错误 → 默认值
    expect(cfg.default_context_window).toBe(8192); // 非正数 → 默认值
  });

  it("usage_pct 越界收敛到 1..100", () => {
    expect(sanitizeBudgetConfig({ usage_pct: 150 }).usage_pct).toBe(100);
    expect(sanitizeBudgetConfig({ usage_pct: 0 }).usage_pct).toBe(1);
  });

  it("null/字符串输入返回默认配置", () => {
    expect(sanitizeBudgetConfig(null).mode).toBe("auto");
    expect(sanitizeBudgetConfig("x").usage_pct).toBe(90);
  });
});

describe("sanitizeConnectionProfile(s)", () => {
  it("缺字段时全部回落为空字符串", () => {
    expect(sanitizeConnectionProfile({})).toEqual({
      id: "",
      name: "",
      api_url: "",
      api_key: "",
      model: "",
      created_at: "",
    });
  });

  it("字段类型错误时回落", () => {
    const p = sanitizeConnectionProfile({ id: 1, api_key: { leak: true }, model: 7 });
    expect(p.id).toBe("");
    expect(p.api_key).toBe("");
    expect(p.model).toBe("");
  });

  it("数组过滤 null / 非对象 / 无 id 条目", () => {
    const list = sanitizeConnectionProfiles([null, { id: "a" }, 5, { name: "x" }]);
    expect(list.map((p) => p.id)).toEqual(["a"]);
  });
});

describe("sanitizeCharacterCard", () => {
  it("空对象也能产出结构合法的卡（旧版本字段缺失）", () => {
    const c = sanitizeCharacterCard({});
    expect(c.name).toBe("");
    expect(c.alternate_greetings).toEqual([]);
    expect(c.tags).toEqual([]);
    expect(c.avatarPath).toBe("");
    expect(c.favorite).toBeUndefined();
    expect(c.character_book).toBeUndefined();
  });

  it("字符串数组里混 null/数字时过滤", () => {
    const c = sanitizeCharacterCard({
      alternate_greetings: ["hi", null, 3, "yo"],
      tags: "not-an-array",
    });
    expect(c.alternate_greetings).toEqual(["hi", "yo"]);
    expect(c.tags).toEqual([]);
  });

  it("内嵌世界书条目混 null 时过滤并逐字段校验", () => {
    const c = sanitizeCharacterCard({
      character_book: {
        entries: [null, { keys: "oops", content: 5 }, { keys: ["a", 1], content: "c" }],
      },
    });
    expect(c.character_book?.entries).toHaveLength(1);
    expect(c.character_book?.entries[0]).toMatchObject({ keys: ["a"], content: "c" });
  });

  it("depth_prompt / extensions 类型错误时丢弃", () => {
    expect(sanitizeCharacterCard({ depth_prompt: "x" }).depth_prompt).toBeUndefined();
    expect(
      sanitizeCharacterCard({ depth_prompt: { depth: "3", prompt: 5 } }).depth_prompt
    ).toBeUndefined();
    expect(sanitizeCharacterCard({ extensions: [] }).extensions).toBeUndefined();
  });

  it("合法 depth_prompt 保留", () => {
    expect(sanitizeCharacterCard({ depth_prompt: { depth: 3, prompt: "p" } }).depth_prompt).toEqual(
      { depth: 3, prompt: "p" }
    );
  });
});

describe("sanitizePersona(s)", () => {
  it("空对象回落为合法 Persona", () => {
    expect(sanitizePersona({})).toEqual({
      id: "",
      name: "",
      description: "",
      avatarPath: "",
      lorebookIds: [],
      created_at: "",
    });
  });

  it("旧版单值 lorebookId 迁移为数组；坏数组过滤", () => {
    expect(sanitizePersona({ lorebookId: "L1" }).lorebookIds).toEqual(["L1"]);
    expect(sanitizePersona({ lorebookIds: ["A", null, 3], lorebookId: "B" }).lorebookIds).toEqual([
      "A",
    ]);
  });

  it("数组过滤 null / 无 id 条目", () => {
    const list = sanitizePersonas([null, { id: "p1" }, { name: "noid" }, 4]);
    expect(list.map((p) => p.id)).toEqual(["p1"]);
  });
});

describe("sanitizeCharacterBook / sanitizeStringArray / parseErrorKind", () => {
  it("世界书 entries 非数组 → 空数组", () => {
    expect(sanitizeCharacterBook({ entries: "x" }).entries).toEqual([]);
  });

  it("字符串数组过滤非字符串", () => {
    expect(sanitizeStringArray(["a", null, 2, "b", ""])).toEqual(["a", "b"]);
    expect(sanitizeStringArray("x")).toEqual([]);
  });

  it("errorKind 只接受已知枚举，旧数据里的陌生值丢弃", () => {
    expect(parseErrorKind("timeout")).toBe("timeout");
    expect(parseErrorKind("rate_limit")).toBe("rate_limit");
    expect(parseErrorKind("weird-old-value")).toBeUndefined();
    expect(parseErrorKind(undefined)).toBeUndefined();
    expect(parseErrorKind("")).toBeUndefined();
  });
});
