// lib/character-card.ts — 酒馆(SillyTavern)角色卡解析与导出(纯函数,无 Tauri 依赖)
//
// 支持:
//  - JSON 卡:V1(扁平 6 字段)/ V2({spec:"chara_card_v2",data})/ V3(同结构,spec 不同)
//  - PNG 卡:文件尾部追加 "chara_card_v2"/"chara_card_v3" 魔数 + JSON(魔数前 = 头像原图);
//    无魔数时回退扫描 PNG tEXt 块(keyword="chara")。
//  - character_book:酒馆部分卡用单数 key 字段,统一规整为 keys 数组。

import type { CharacterCard, LoreEntry } from "@/types";

const MAGIC_V2 = "chara_card_v2";
const MAGIC_V3 = "chara_card_v3";

function emptyCard(): Omit<CharacterCard, "id" | "created_at" | "updated_at"> {
  return {
    specVersion: "",
    name: "",
    description: "",
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "",
    character_version: "",
    character_book: undefined,
    extensions: undefined,
    depth_prompt: undefined,
    avatarPath: "",
  };
}

/** 归一化 character_book:entry.key(单数,部分旧卡)→ keys 数组;补全高级字段映射 */
function normalizeLoreEntry(e: Record<string, unknown>): LoreEntry {
  const keysRaw = (e.keys as unknown[] | undefined) ?? (e.key ? [e.key] : []);
  return {
    keys: (Array.isArray(keysRaw) ? keysRaw : []).map(String),
    keyssecondary: Array.isArray(e.keyssecondary)
      ? (e.keyssecondary as unknown[]).map(String)
      : undefined,
    content: String(e.content ?? ""),
    constant: e.constant === true,
    selective: e.selective === true,
    insertion_order: typeof e.insertion_order === "number" ? e.insertion_order : 0,
    position: e.position ? String(e.position) : "before_char",
    enabled: e.enabled !== false,
    comment: e.comment ? String(e.comment) : "",
    // 修复导入丢字段:酒馆高级字段此前被丢弃
    case_sensitive: e.case_sensitive === true ? true : undefined,
    probability: typeof e.probability === "number" ? e.probability : undefined,
    recursive: e.recursive === true ? true : undefined,
    regex: e.regex === true ? true : undefined,
    match_whole_words: e.match_whole_words === true ? true : undefined,
    min_activations: typeof e.min_activations === "number" ? e.min_activations : undefined,
  };
}

/** 从 V2/V3 的 data 或 V1 扁平对象构造统一卡片数据 */
function cardFromData(
  data: Record<string, unknown>
): Omit<CharacterCard, "id" | "created_at" | "updated_at"> {
  const card = emptyCard();
  card.name = String(data.name ?? "");
  card.description = String(data.description ?? "");
  card.personality = String(data.personality ?? "");
  card.scenario = String(data.scenario ?? "");
  card.first_mes = String(data.first_mes ?? "");
  card.mes_example = String(data.mes_example ?? "");
  card.creator_notes = String(data.creator_notes ?? "");
  card.system_prompt = String(data.system_prompt ?? "");
  card.post_history_instructions = String(data.post_history_instructions ?? "");
  card.alternate_greetings = Array.isArray(data.alternate_greetings)
    ? (data.alternate_greetings as unknown[]).map(String)
    : [];
  card.tags = Array.isArray(data.tags) ? (data.tags as unknown[]).map(String) : [];
  card.creator = String(data.creator ?? "");
  card.character_version = String(data.character_version ?? "");
  // 酒馆扩展数据(含 emotions 表情配置)原样保留
  if (data.extensions && typeof data.extensions === "object") {
    card.extensions = data.extensions as Record<string, unknown>;
  }
  // V3 扩展:深度提示词(depth_prompt)——{depth, prompt},对话到第 depth 条消息时注入
  if (data.depth_prompt && typeof data.depth_prompt === "object") {
    const dp = data.depth_prompt as Record<string, unknown>;
    const prompt = dp.prompt ? String(dp.prompt) : "";
    if (prompt.trim()) {
      card.depth_prompt = {
        depth: typeof dp.depth === "number" ? Math.max(0, Math.floor(dp.depth)) : 0,
        prompt,
      };
    }
  }
  if (data.character_book && typeof data.character_book === "object") {
    const cb = data.character_book as Record<string, unknown>;
    const entries = Array.isArray(cb.entries)
      ? (cb.entries as Record<string, unknown>[])
          .filter((e) => e && typeof e === "object")
          .map(normalizeLoreEntry)
          .sort((a, b) => (a.insertion_order ?? 0) - (b.insertion_order ?? 0))
      : [];
    card.character_book = {
      name: cb.name ? String(cb.name) : undefined,
      description: cb.description ? String(cb.description) : undefined,
      scan_depth: typeof cb.scan_depth === "number" ? cb.scan_depth : undefined,
      token_budget: typeof cb.token_budget === "number" ? cb.token_budget : undefined,
      entries,
    };
  }
  return card;
}

/** 解析 JSON 文本为卡片数据(不抛错,失败返回 null) */
export function parseCharacterJson(
  json: string
): Omit<CharacterCard, "id" | "created_at" | "updated_at"> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    // ⚠️ 必须先是普通对象。数组/字符串/数字一律不是角色卡。
    //    2026-09-25 实测事故：酒馆「正则脚本套件」是一个 JSON **数组**，
    //    旧代码直接对数组取 data.name/data.description（全部 undefined → String 成空串），
    //    cardFromData 于是「成功地」造出一张**空白角色卡**，
    //    导入时就被报成「这是角色卡」，把用户引到完全错误的 tab。
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.spec === MAGIC_V2 || obj.spec === MAGIC_V3) {
      const data = obj.data as Record<string, unknown>;
      if (!data || typeof data !== "object" || Array.isArray(data)) return null;
      const card = cardFromData(data);
      card.specVersion = obj.spec === MAGIC_V3 ? "3" : "2";
      return card;
    }
    // V1 扁平(或带 spec 但无 data 的容错)
    const card = cardFromData(obj);
    card.specVersion = obj.spec ? String(obj.spec) : "";
    return card;
  } catch {
    return null;
  }
}

/**
 * 从 PNG 二进制(base64)解析角色卡:
 * 返回 { json, avatarBase64 } —— avatarBase64 为魔数前的原始 PNG(可作头像),
 * 无魔数时回退扫 tEXt 块(keyword="chara"),此时无头像。
 *
 * 兼容真实世界卡(酒馆/Chub 等导出):
 *  - **多段卡**:现代卡同时嵌 chara_card_v2 段 + chara_card_v3 段(V2 前 V3 后)。
 *    逐段尝试解析,取第一个合法 JSON 段(通常取到 V3 段)。
 *  - **JSON 内部自带 "spec":"chara_card_v2" 字符串**会误命中魔数——
 *    用「紧邻 PNG IEND 尾标」判定真魔数作为头像边界,JSON 段逐个试错跳过误命中。
 */
export function parseCharacterPng(
  base64: string
): { json: string; avatarBase64: string | null } | null {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const v2Bytes = new TextEncoder().encode(MAGIC_V2);
    const v3Bytes = new TextEncoder().encode(MAGIC_V3);
    const hits = findAllMagic(bytes, v2Bytes, v3Bytes);

    if (hits.length > 0) {
      // 头像边界 = 第一个「前面紧邻 PNG IEND 尾标」的魔数(真魔数,在 PNG 数据后);
      // JSON 内部的 spec 串误命中前面是 "spec":" 而非 IEND,不会被当作边界。
      const iendTail = new Uint8Array([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
      const firstHit = hits[0];
      let boundary = firstHit ? firstHit.pos : -1;
      for (const h of hits) {
        if (h.pos >= 8 && bytesEqual(bytes.slice(h.pos - 8, h.pos), iendTail)) {
          boundary = h.pos;
          break;
        }
      }
      // 逐段尝试:魔数之后到文件尾,能解析成合法卡的段即真卡。
      // 多段卡:V2 段后含 V3 魔数+JSON 是混合串(解析失败),V3 段后是纯 JSON(成功)。
      for (const h of hits) {
        const seg = bytes.slice(h.pos + h.len);
        let end = seg.length;
        while (end > 0 && (seg[end - 1] === 0x0a || seg[end - 1] === 0x0d || seg[end - 1] === 0x20))
          end--;
        const json = new TextDecoder().decode(seg.slice(0, end)).trim();
        if (json && parseCharacterJson(json)) {
          const avatar = bytes.slice(0, boundary);
          return { json, avatarBase64: avatar.length > 8 ? base64FromBytes(avatar) : null };
        }
      }
      return null;
    }

    // 2) 回退:tEXt 块 keyword="chara"(老式卡,JSON 常 base64 编码存于此;
    //    同一 keyword 可能有多块,逐个尝试)
    for (const chunk of extractAllTextChunks(bytes, "chara")) {
      const decoded = tryDecodeJson(chunk);
      if (decoded && parseCharacterJson(decoded)) {
        // 整张 PNG 本身就是角色头像(卡图 + 内嵌 JSON);无尾部魔数时
        // 没有"魔数前纯图像区"概念,直接以整张图作头像。
        return { json: decoded, avatarBase64: base64FromBytes(bytes) };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * tEXt 块内容兼容两种存法:直接 JSON / base64 编码的 JSON(老式酒馆卡常见)。
 * 返回能解析的原始 JSON 字符串,否则 null。
 */
function tryDecodeJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    /* 非直接 JSON */
  }
  try {
    const bytes = Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    JSON.parse(decoded);
    return decoded;
  } catch {
    return null;
  }
}

/** 收集全部魔数命中位置(升序),含 JSON 内部的误命中(靠试错排除) */
function findAllMagic(
  bytes: Uint8Array,
  v2: Uint8Array,
  v3: Uint8Array
): { pos: number; len: number }[] {
  const out: { pos: number; len: number }[] = [];
  let from = 0;
  while (from < bytes.length) {
    const a = findBytesFrom(bytes, v2, from);
    const b = findBytesFrom(bytes, v3, from);
    let pos = -1;
    let len = 0;
    if (a >= 0 && (b < 0 || a < b)) {
      pos = a;
      len = v2.length;
    } else if (b >= 0) {
      pos = b;
      len = v3.length;
    }
    if (pos < 0) break;
    out.push({ pos, len });
    from = pos + len;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 在字节数组中从 from 开始查找目标序列,返回位置(找不到 -1) */
function findBytesFrom(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  outer: for (let i = Math.max(0, from); i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** 从 PNG 字节中提取所有指定 keyword 的 tEXt 块文本(可能多块) */
function extractAllTextChunks(bytes: Uint8Array, keyword: string): string[] {
  const out: string[] = [];
  // PNG 结构:8 字节签名 + (4 长度 + 4 类型 + 数据 + 4 CRC)*
  let offset = 8;
  const decoder = new TextDecoder();
  while (offset + 12 <= bytes.length) {
    const len = readU32(bytes, offset);
    const type = decoder.decode(bytes.slice(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > bytes.length) break;
    if (type === "tEXt") {
      const data = bytes.slice(dataStart, dataEnd);
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const key = decoder.decode(data.slice(0, nullIdx));
        if (key === keyword) {
          out.push(decoder.decode(data.slice(nullIdx + 1)).trim());
        }
      }
    }
    offset = dataEnd + 4; // 跳过 CRC
    if (type === "IEND") break;
  }
  return out;
}

function readU32(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const b3 = bytes[offset + 3] ?? 0;
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

export function base64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** 组装导出用 V2 JSON(带 spec 包裹,酒馆可直接导入) */
export function toExportJson(
  card: Pick<
    CharacterCard,
    | "name"
    | "description"
    | "personality"
    | "scenario"
    | "first_mes"
    | "mes_example"
    | "creator_notes"
    | "system_prompt"
    | "post_history_instructions"
    | "alternate_greetings"
    | "tags"
    | "creator"
    | "character_version"
    | "character_book"
  >
): string {
  const data: Record<string, unknown> = {
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.first_mes,
    mes_example: card.mes_example,
    creator_notes: card.creator_notes,
    system_prompt: card.system_prompt,
    post_history_instructions: card.post_history_instructions,
    alternate_greetings: card.alternate_greetings,
    tags: card.tags,
    creator: card.creator,
    character_version: card.character_version,
    extensions: (card as { extensions?: Record<string, unknown> }).extensions || {},
  };
  // V3 扩展:深度提示词(depth_prompt)透传导出(酒馆可读)
  const dp = (card as { depth_prompt?: { depth: number; prompt: string } }).depth_prompt;
  if (dp?.prompt?.trim()) {
    data.depth_prompt = { depth: Math.max(0, Math.floor(dp.depth)), prompt: dp.prompt.trim() };
  }
  if (card.character_book && card.character_book.entries.length > 0) {
    data.character_book = {
      name: card.character_book.name || "Character Lore",
      description: card.character_book.description || "",
      scan_depth: card.character_book.scan_depth ?? 10,
      token_budget: card.character_book.token_budget ?? 1024,
      recursive_scanning: false,
      extensions: {},
      entries: card.character_book.entries.map((e, i) => ({
        id: i + 1,
        keys: e.keys,
        key: e.keys[0] || "",
        keysecondary: e.keyssecondary || "",
        comment: e.comment || "",
        content: e.content,
        constant: !!e.constant,
        selective: !!e.selective,
        insertion_order: e.insertion_order ?? 0,
        enabled: e.enabled !== false,
        position: e.position || "before_char",
        extensions: {},
      })),
    };
  }
  return JSON.stringify({ spec: MAGIC_V2, spec_version: "2.0", data }, null, 2);
}

/** 组装导出用 PNG(头像原图 + 魔数 + JSON);无头像时返回 null(应导出 JSON) */
export function buildExportPng(avatarBase64: string, json: string): string {
  const avatarBytes = Uint8Array.from(atob(avatarBase64), (c) => c.charCodeAt(0));
  const magic = new TextEncoder().encode(MAGIC_V2);
  const jsonBytes = new TextEncoder().encode(json);
  const out = new Uint8Array(avatarBytes.length + magic.length + jsonBytes.length);
  out.set(avatarBytes, 0);
  out.set(magic, avatarBytes.length);
  out.set(jsonBytes, avatarBytes.length + magic.length);
  return base64FromBytes(out);
}
