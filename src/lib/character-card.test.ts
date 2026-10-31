// lib/character-card.test.ts — 角色卡解析/导出/深度提示词(迁移自历史冒烟测试)
import { describe, it, expect } from "vitest";
import {
  parseCharacterJson,
  parseCharacterPng,
  toExportJson,
  base64FromBytes,
} from "./character-card";

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

/** 含全部高级字段的 V2 卡:导入→导出→再导入必须逐项保住 */
const ADVANCED_V2 = JSON.stringify({
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "阿狸",
    description: "d",
    character_book: {
      name: "王都设定",
      description: "书描述",
      scan_depth: 7,
      token_budget: 512,
      entries: [
        {
          keys: ["王都", "首都"],
          secondary_keys: ["夜晚", "月光"],
          content: "第一行\n第二行",
          constant: true,
          selective: true,
          insertion_order: 3,
          position: "after_char",
          enabled: false,
          comment: "注释",
          probability: 60,
          case_sensitive: true,
          recursive: true,
          regex: true,
          match_whole_words: true,
          min_activations: 2,
        },
      ],
    },
  },
});

/** 导出 JSON 的最小形状(避免 JSON.parse 的 any 触发 lint) */
interface ExportedEntry {
  keys?: string[];
  secondary_keys?: string[];
  content?: string;
  constant?: boolean;
  selective?: boolean;
  position?: string;
  probability?: number;
  case_sensitive?: boolean;
  recursive?: boolean;
  regex?: boolean;
  match_whole_words?: boolean;
  min_activations?: number;
  sticky?: boolean;
  cooldown?: number;
}
interface ExportedCard {
  data?: {
    character_book?: {
      name?: string;
      description?: string;
      scan_depth?: number;
      token_budget?: number;
      entries?: ExportedEntry[];
    };
  };
}

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

describe("T-030 character_book 字段往返", () => {
  it("V2 导入→导出→再导入:constant/selective/keyssecondary/position/probability 不丢", () => {
    const first = parseCharacterJson(ADVANCED_V2);
    const firstEntry = first?.character_book?.entries[0];
    expect(firstEntry?.keyssecondary).toEqual(["夜晚", "月光"]);
    expect(firstEntry?.content).toBe("第一行\n第二行");

    const exported = JSON.parse(toExportJson(first as never)) as ExportedCard;
    const outBook = exported.data?.character_book;
    const outEntry = outBook?.entries?.[0];
    // book 元数据不重置
    expect(outBook?.name).toBe("王都设定");
    expect(outBook?.description).toBe("书描述");
    expect(outBook?.scan_depth).toBe(7);
    expect(outBook?.token_budget).toBe(512);
    // 条目字段不丢；导出按酒馆规范写 secondary_keys
    expect(outEntry?.constant).toBe(true);
    expect(outEntry?.selective).toBe(true);
    expect(outEntry?.position).toBe("after_char");
    expect(outEntry?.probability).toBe(60);
    expect(outEntry?.case_sensitive).toBe(true);
    expect(outEntry?.recursive).toBe(true);
    expect(outEntry?.regex).toBe(true);
    expect(outEntry?.match_whole_words).toBe(true);
    expect(outEntry?.min_activations).toBe(2);
    expect(outEntry?.secondary_keys).toEqual(["夜晚", "月光"]);
    expect(outEntry?.content).toBe("第一行\n第二行");

    // 自家导出再导入：内部字段仍为 keyssecondary，其余字段不变
    const again = parseCharacterJson(JSON.stringify(exported));
    const againEntry = again?.character_book?.entries[0];
    expect(againEntry?.keyssecondary).toEqual(["夜晚", "月光"]);
    expect(againEntry?.constant).toBe(true);
    expect(againEntry?.selective).toBe(true);
    expect(againEntry?.position).toBe("after_char");
    expect(againEntry?.probability).toBe(60);
    expect(againEntry?.content).toBe("第一行\n第二行");
    expect(again?.character_book?.scan_depth).toBe(7);
    expect(again?.character_book?.token_budget).toBe(512);
  });

  it("sticky / cooldown 往返（T-121）", () => {
    const raw = JSON.stringify({
      spec: "chara_card_v2",
      data: {
        name: "定时卡",
        character_book: {
          entries: [
            { keys: ["火"], content: "火焰常驻", sticky: true },
            { keys: ["冰"], content: "冰霜冷却", cooldown: 3 },
          ],
        },
      },
    });
    const first = parseCharacterJson(raw);
    expect(first?.character_book?.entries[0]?.sticky).toBe(true);
    expect(first?.character_book?.entries[1]?.cooldown).toBe(3);

    const exported = JSON.parse(toExportJson(first as never)) as ExportedCard;
    expect(exported.data?.character_book?.entries?.[0]?.sticky).toBe(true);
    expect(exported.data?.character_book?.entries?.[1]?.cooldown).toBe(3);

    const again = parseCharacterJson(JSON.stringify(exported));
    expect(again?.character_book?.entries[0]?.sticky).toBe(true);
    expect(again?.character_book?.entries[1]?.cooldown).toBe(3);
  });

  it("secondary_keys 与 keysecondary 两种输入都映射到内部 keyssecondary", () => {
    const v2 = JSON.stringify({
      spec: "chara_card_v2",
      data: {
        name: "别名卡",
        character_book: {
          entries: [
            { keys: ["a"], secondary_keys: ["s1", "s2"], content: "c1" },
            { keys: ["b"], keysecondary: ["s3"], content: "c2" },
            { keys: ["c"], keysecondary: "s4, s5", content: "c3" },
          ],
        },
      },
    });
    const entries = parseCharacterJson(v2)?.character_book?.entries ?? [];
    expect(entries[0]?.keyssecondary).toEqual(["s1", "s2"]);
    expect(entries[1]?.keyssecondary).toEqual(["s3"]);
    expect(entries[2]?.keyssecondary).toEqual(["s4", "s5"]);
  });
});

// ── T-118:非角色卡对象不再生成空角色 ────────────────────────────────
describe("parseCharacterJson 形态校验（T-118）", () => {
  it("独立世界书（根级 entries）被拒绝，不再造空名角色", () => {
    expect(
      parseCharacterJson(JSON.stringify({ entries: [{ keys: ["a"], content: "b" }] }))
    ).toBeNull();
    // 带 name 的世界书同样是世界书结构
    expect(
      parseCharacterJson(
        JSON.stringify({ name: "世界书", entries: [{ keys: ["a"], content: "b" }] })
      )
    ).toBeNull();
  });

  it("没有 name/description 的任意对象被拒绝", () => {
    expect(parseCharacterJson("{}")).toBeNull();
    expect(parseCharacterJson(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(parseCharacterJson(JSON.stringify({ name: "   ", description: "" }))).toBeNull();
  });

  it("V1 最小卡仍可导入（name 或 description 有一个即可）", () => {
    expect(parseCharacterJson(JSON.stringify({ name: "只有名字" }))?.name).toBe("只有名字");
    expect(parseCharacterJson(JSON.stringify({ description: "只有描述" }))?.description).toBe(
      "只有描述"
    );
  });
});

// ── T-119 / T-120:PNG 魔数扫描性能 + tEXt 回退 ─────────────────────
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  return concatBytes([u32(data.length), new TextEncoder().encode(type), data, new Uint8Array(4)]);
}

/** 造一张 PNG:签名 + IHDR + IDAT(可塞假魔数) + IEND + 尾部 payload */
function makePng(payload: string, opts: { idatSize?: number; fakeHits?: number } = {}): Uint8Array {
  const idatSize = opts.idatSize ?? 16;
  const data = new Uint8Array(idatSize);
  for (let i = 0; i < idatSize; i++) data[i] = i % 251;
  const magic = new TextEncoder().encode("chara_card_v2");
  const hits = opts.fakeHits ?? 0;
  for (let n = 0; n < hits; n++) {
    // 均匀撒在图像数据里(真实卡片的图像字节同样可能偶然命中)
    const at = Math.floor(((n + 1) * idatSize) / (hits + 2));
    data.set(magic.subarray(0, Math.min(magic.length, idatSize - at)), at);
  }
  return concatBytes([
    new Uint8Array(PNG_SIGNATURE),
    chunk("IHDR", new Uint8Array(13)),
    chunk("IDAT", data),
    chunk("IEND", new Uint8Array(0)),
    new TextEncoder().encode(payload),
  ]);
}

const CARD_JSON = JSON.stringify({
  spec: "chara_card_v2",
  data: { name: "PNG卡", description: "d" },
});

describe("parseCharacterPng 性能与回退（T-119/T-120）", () => {
  it("5MB 图像数据里 200 个假魔数命中：忽略图像区，不回溯，远快于旧实现", () => {
    const png = makePng(`chara_card_v2${CARD_JSON}`, {
      idatSize: 5 * 1024 * 1024,
      fakeHits: 200,
    });
    const b64 = base64FromBytes(png);
    const start = performance.now();
    const parsed = parseCharacterPng(b64);
    const elapsed = performance.now() - start;
    expect(parsed?.json).toBe(CARD_JSON);
    // 旧实现按「每个命中复制余下全部字节 + decode + parse」≈3.3s；
    // 新实现按 IEND 块偏移直达尾部、图像区零扫描、头像走原 base64 前缀切片，
    // 单跑约几十毫秒。阈值按验收标准 500ms。
    expect(elapsed).toBeLessThan(500);
  });

  it("非 PNG 文件里海量魔数命中也有候选上限（不随命中数平方增长）", () => {
    // 2MB 全由魔数字符串构成（病态输入），旧实现会为每个命中复制余下全部字节
    const unit = new TextEncoder().encode("chara_card_v2");
    const reps = Math.floor((2 * 1024 * 1024) / unit.length);
    const blob = new Uint8Array(unit.length * reps);
    for (let i = 0; i < reps; i++) blob.set(unit, i * unit.length);
    const b64 = base64FromBytes(blob);
    const start = performance.now();
    expect(parseCharacterPng(b64)).toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("尾部魔数段解析失败时继续走 tEXt 回退（裸 JSON V2 卡可导入）", () => {
    const text = concatBytes([
      new TextEncoder().encode("chara"),
      new Uint8Array([0]),
      new TextEncoder().encode(CARD_JSON),
    ]);
    const png = concatBytes([
      new Uint8Array(PNG_SIGNATURE),
      chunk("IHDR", new Uint8Array(13)),
      chunk("tEXt", text),
      chunk("IEND", new Uint8Array(0)),
      // 尾部有真魔数但后面不是合法 JSON：旧实现到此直接 return null
      new TextEncoder().encode("chara_card_v2not-a-json"),
    ]);
    const parsed = parseCharacterPng(base64FromBytes(png));
    expect(parsed?.json).toBe(CARD_JSON);
  });

  it("正常尾部魔数卡仍可解析，头像为魔数前原图的精确 base64 前缀", () => {
    const payload = new TextEncoder().encode(`chara_card_v2${CARD_JSON}`);
    const png = makePng(`chara_card_v2${CARD_JSON}`, { idatSize: 64 });
    const parsed = parseCharacterPng(base64FromBytes(png));
    expect(parsed?.json).toBe(CARD_JSON);
    // 前缀切片优化必须与完整重编码逐字符一致
    expect(parsed?.avatarBase64).toBe(
      base64FromBytes(png.subarray(0, png.length - payload.length))
    );
  });
});
