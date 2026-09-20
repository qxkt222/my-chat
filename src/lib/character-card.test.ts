// lib/character-card.test.ts — 角色卡解析/导出/深度提示词(迁移自历史冒烟测试)
import { describe, it, expect } from "vitest";
import { parseCharacterJson, toExportJson } from "./character-card";

describe("parseCharacterJson", () => {
  it("解析 V3 卡并保留 depth_prompt", () => {
    const v3 = JSON.stringify({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "Test",
        description: "d",
        depth_prompt: { depth: 12, prompt: "中段转折" },
      },
    });
    const card = parseCharacterJson(v3);
    expect(card?.specVersion).toBe("3");
    expect(card?.depth_prompt?.depth).toBe(12);
    expect(card?.depth_prompt?.prompt).toBe("中段转折");
  });

  it("V2 无 depth_prompt → undefined", () => {
    const v2 = JSON.stringify({ spec: "chara_card_v2", data: { name: "A", description: "b" } });
    expect(parseCharacterJson(v2)?.depth_prompt).toBeUndefined();
  });

  it("导入补全酒馆高级字段(不丢 case_sensitive/probability/recursive/regex)", () => {
    const v2 = JSON.stringify({
      spec: "chara_card_v2",
      data: {
        name: "X",
        description: "y",
        character_book: {
          entries: [
            {
              keys: ["王都"],
              content: "王都是首都",
              case_sensitive: true,
              probability: 80,
              recursive: true,
              regex: true,
            },
          ],
        },
      },
    });
    const card = parseCharacterJson(v2);
    const e = card?.character_book?.entries[0];
    expect(e?.case_sensitive).toBe(true);
    expect(e?.probability).toBe(80);
    expect(e?.recursive).toBe(true);
    expect(e?.regex).toBe(true);
  });
});

describe("toExportJson", () => {
  it("导出透传 depth_prompt", () => {
    const v3 = JSON.stringify({
      spec: "chara_card_v3",
      data: { name: "X", description: "y", depth_prompt: { depth: 5, prompt: "第五轮注入" } },
    });
    const card = parseCharacterJson(v3);
    // 显式断言导出结构：JSON.parse 返回 any，不标注就会让 no-unsafe-member-access 报警
    const out = JSON.parse(toExportJson(card as never)) as {
      data?: { depth_prompt?: { depth?: number; prompt?: string } };
    };
    expect(out.data?.depth_prompt?.depth).toBe(5);
    expect(out.data?.depth_prompt?.prompt).toBe("第五轮注入");
  });
});
