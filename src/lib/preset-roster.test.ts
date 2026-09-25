// lib/preset-roster.test.ts — 名册纯函数单测
//
// 这组测试钉的是**旧数据兼容**与**拼装确定性**两件事：
//   1. 旧数据：本机 34 个已落盘的预设 JSON 都没有 enabled/group/order 三个键。
//      若把「未启用」判成「启用」，「导入预设（默认组合）」那 6.5 万字会默认开上，
//      发送链路当场顶爆上下文预算 —— 所以「只认 === true」必须被机械钉住。
//   2. 确定性：拼装顺序决定 DeepSeek 缓存前缀。顺序抖动在界面上看不出来
//      （回复照常，只是变慢变贵），只能靠单测钉。

import { describe, it, expect } from "vitest";
import {
  assembleRoster,
  applyOrder,
  charCount,
  enabledCharTotal,
  enabledCount,
  entryOrderOf,
  isEntryEnabled,
  migrateLegacyEntries,
  moveWithin,
  orderOf,
  groupOf,
  splitByGroup,
  emptyRosterIndex,
  UNGROUPED,
  UNGROUPED_LABEL,
} from "./preset-roster";
import type { PromptPreset } from "@/types";

/** 造条目；不传 enabled/group/order 时**不写这三个键**，模拟旧数据 */
function mk(id: string, template: string, extra: Partial<PromptPreset> = {}): PromptPreset {
  return {
    id,
    name: id,
    description: "",
    template,
    is_preset: false,
    created_at: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

describe("旧数据兼容（最要紧的一条）", () => {
  it("没有 enabled 键的旧条目 = 未启用", () => {
    const old = mk("old-1", "旧的六万字模板");
    expect("enabled" in old).toBe(false);
    expect(isEntryEnabled(old)).toBe(false);
  });

  it("整批旧数据拼装结果为空串 —— 于是发送链路会回退，不会把 6.5 万字开上", () => {
    const olds = [mk("a", "x".repeat(65762)), mk("b", "y".repeat(1169))];
    expect(assembleRoster(olds)).toBe("");
    expect(enabledCount(olds)).toBe(0);
    expect(enabledCharTotal(olds)).toBe(0);
  });

  it("只有显式 enabled:true 才算启用", () => {
    expect(isEntryEnabled(mk("a", "t", { enabled: true }))).toBe(true);
    expect(isEntryEnabled(mk("b", "t", { enabled: false }))).toBe(false);
    // 显式 undefined 同样算未启用
    expect(isEntryEnabled(mk("c", "t", { enabled: undefined }))).toBe(false);
  });
});

describe("拼装", () => {
  it("按 order 升序拼接", () => {
    const list = [
      mk("c", "第三", { enabled: true, order: 30 }),
      mk("a", "第一", { enabled: true, order: 10 }),
      mk("b", "第二", { enabled: true, order: 20 }),
    ];
    expect(assembleRoster(list)).toBe("第一\n\n第二\n\n第三");
  });

  it("未启用的条目不参与，即使 order 更靠前", () => {
    const list = [
      mk("off", "不该出现", { enabled: false, order: 1 }),
      mk("on", "该出现", { enabled: true, order: 2 }),
    ];
    expect(assembleRoster(list)).toBe("该出现");
  });

  it("缺 order 的排最后；同 order 保持入参相对顺序（缓存前缀稳定）", () => {
    const list = [
      mk("no-order", "无序", { enabled: true }),
      mk("o2", "有序2", { enabled: true, order: 2 }),
      mk("o1a", "有序1a", { enabled: true, order: 1 }),
      mk("o1b", "有序1b", { enabled: true, order: 1 }),
    ];
    expect(assembleRoster(list)).toBe("有序1a\n\n有序1b\n\n有序2\n\n无序");
    // 同样输入再跑一次必须逐字一致（缓存前缀稳定的最低要求）
    expect(assembleRoster(list)).toBe("有序1a\n\n有序1b\n\n有序2\n\n无序");
  });

  it("忽略空白模板，避免拼出多余空行", () => {
    const list = [
      mk("a", "有内容", { enabled: true, order: 1 }),
      mk("b", "   ", { enabled: true, order: 2 }),
      mk("c", "也有内容", { enabled: true, order: 3 }),
    ];
    expect(assembleRoster(list)).toBe("有内容\n\n也有内容");
  });

  it("单条启用也能拼（不是只在多条时才工作）", () => {
    expect(assembleRoster([mk("a", "独苗", { enabled: true })])).toBe("独苗");
  });

  it("order 为非法值（NaN）不产生 NaN 参与比较，仍排最后", () => {
    const list = [
      mk("bad", "非法序", { enabled: true, order: Number.NaN }),
      mk("ok", "正常序", { enabled: true, order: 5 }),
    ];
    expect(orderOf(list[0] as PromptPreset)).toBe(Number.MAX_SAFE_INTEGER);
    expect(assembleRoster(list)).toBe("正常序\n\n非法序");
  });
});

describe("计数与预算", () => {
  it("charCount 按字符数（与 UI 显示同口径）", () => {
    expect(charCount(mk("a", "12345"))).toBe(5);
    expect(charCount(mk("b", "中文三个字"))).toBe(5);
  });

  it("enabledCharTotal 只合计已启用", () => {
    const list = [
      mk("a", "12345", { enabled: true }),
      mk("b", "1234567890", { enabled: false }),
      mk("c", "123", { enabled: true }),
    ];
    expect(enabledCharTotal(list)).toBe(8);
    expect(enabledCount(list)).toBe(2);
  });
});

describe("包内排序与旧数据迁移", () => {
  it("moveWithin：上移下移一位，端点返回 null（调用方据此跳过落盘）", () => {
    const ids = ["a", "b", "c"];
    expect(moveWithin(ids, "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveWithin(ids, "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveWithin(ids, "a", -1)).toBeNull();
    expect(moveWithin(ids, "c", 1)).toBeNull();
    expect(moveWithin(ids, "zzz", 1)).toBeNull();
  });

  it("applyOrder：按给定顺序把 order 写成 0,1,2…", () => {
    const entries = [mk("a", "t"), mk("b", "t")];
    const out = applyOrder(entries, ["b", "a"]);
    expect(out.find((p) => p.id === "b")?.order).toBe(0);
    expect(out.find((p) => p.id === "a")?.order).toBe(1);
  });

  it("entryOrderOf：索引没记录时用现有顺序兜底；新条目补到末尾", () => {
    expect(entryOrderOf(emptyRosterIndex(), "包A", ["a", "b"])).toEqual(["a", "b"]);
    const idx = { groupOrder: [], entryOrder: { 包A: ["b"] }, updated_at: "" };
    expect(entryOrderOf(idx, "包A", ["a", "b"])).toEqual(["b", "a"]);
  });

  it("migrateLegacyEntries：给旧导入条目补 group/order，且一律按未启用", () => {
    const olds = [mk("imp-1", "t1"), mk("imp-2", "t2")];
    const { presets, changed } = migrateLegacyEntries(olds, "旧包");
    expect(changed).toBe(2);
    expect(presets.every((p) => p.group === "旧包")).toBe(true);
    expect(presets.map((p) => p.order).sort()).toEqual([0, 1]);
    // 关键：不能因为迁移就把旧数据变成已启用
    expect(presets.every((p) => p.enabled === false)).toBe(true);
  });

  it("migrateLegacyEntries：非 imp- 前缀（内置/自定义）不动", () => {
    const mixed = [mk("preset-classic-char", "t"), mk("custom-1", "t")];
    const { presets, changed } = migrateLegacyEntries(mixed, "旧包");
    expect(changed).toBe(0);
    expect(presets.every((p) => p.group === undefined)).toBe(true);
  });

  it("migrateLegacyEntries：已是新格式的条目不再改动（幂等）", () => {
    const already = [mk("imp-9", "t", { group: "包A", order: 3, enabled: true })];
    const { changed } = migrateLegacyEntries(already, "旧包");
    expect(changed).toBe(0);
  });
});

describe("分区与包顺序", () => {
  it("按 group 分区；未分组的归到 UNGROUPED 且排最后", () => {
    const list = [
      mk("u1", "t", { group: undefined }),
      mk("p2", "t", { group: "包B" }),
      mk("p1", "t", { group: "包A" }),
    ];
    const groups = splitByGroup(list, emptyRosterIndex());
    expect(groups.map((g) => g.key)).toEqual(["包A", "包B", UNGROUPED]);
    expect(groups[2]?.label).toBe(UNGROUPED_LABEL);
  });

  it("索引里声明过的包优先，未声明的排在后面", () => {
    const list = [
      mk("a", "t", { group: "包A" }),
      mk("b", "t", { group: "包B" }),
      mk("c", "t", { group: "包C" }),
    ];
    const idx = { groupOrder: ["包C", "包A"], entryOrder: {}, updated_at: "" };
    const groups = splitByGroup(list, idx);
    expect(groups.map((g) => g.key)).toEqual(["包C", "包A", "包B"]);
  });

  it("包内条目按 order 排好，且给出该包已启用字数", () => {
    const list = [
      mk("b", "bb", { group: "包A", order: 2, enabled: true }),
      mk("a", "a", { group: "包A", order: 1, enabled: false }),
    ];
    const g = splitByGroup(list, emptyRosterIndex())[0];
    expect(g?.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(g?.enabledChars).toBe(2);
  });

  it("空列表返回空分区（不抛异常）", () => {
    expect(splitByGroup([], emptyRosterIndex())).toEqual([]);
  });

  it("groupOf：空串与缺省都归未分组", () => {
    expect(groupOf(mk("a", "t"))).toBe(UNGROUPED);
    expect(groupOf(mk("b", "t", { group: "" }))).toBe(UNGROUPED);
    expect(groupOf(mk("c", "t", { group: "包A" }))).toBe("包A");
  });
});
