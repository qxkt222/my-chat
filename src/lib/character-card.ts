// lib/character-card.ts — 酒馆(SillyTavern)角色卡解析与导出(纯函数,无 Tauri 依赖)
//
// 支持:
//  - JSON 卡:V1(扁平 6 字段)/ V2({spec:"chara_card_v2",data})/ V3(同结构,spec 不同)
//  - PNG 卡:文件尾部追加 "chara_card_v2"/"chara_card_v3" 魔数 + JSON(魔数前 = 头像原图);
//    无魔数时回退扫描 PNG tEXt 块(keyword="chara")。
//  - character_book:酒馆部分卡用单数 key 字段,统一规整为 keys 数组。

import type { CharacterBook, CharacterCard, LoreEntry } from "@/types";

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

/**
 * 次级关键词别名归一:
 *  - 酒馆 V2 character_book 规范字段是 `secondary_keys`(数组);
 *  - 部分世界书/旧导出用 `keysecondary`(本仓旧版导出还写成过逗号分隔字符串)。
 * 内部字段始终是 `keyssecondary`(已落盘数据无需迁移)。
 */
export function normalizeSecondaryKeys(e: Record<string, unknown>): string[] | undefined {
  const raw = e.keyssecondary ?? e.secondary_keys ?? e.keysecondary;
  if (Array.isArray(raw)) {
    const keys = raw.map(String).filter(Boolean);
    return keys.length > 0 ? keys : undefined;
  }
  if (typeof raw === "string") {
    const keys = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return keys.length > 0 ? keys : undefined;
  }
  return undefined;
}

/** 归一化 character_book:entry.key(单数,部分旧卡)→ keys 数组;补全高级字段映射 */
function normalizeLoreEntry(e: Record<string, unknown>): LoreEntry {
  const keysRaw = (e.keys as unknown[] | undefined) ?? (e.key ? [e.key] : []);
  return {
    keys: (Array.isArray(keysRaw) ? keysRaw : []).map(String),
    keyssecondary: normalizeSecondaryKeys(e),
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
    // T-121:定时世界书字段导出/再导入时必须往返保住
    sticky: e.sticky === true ? true : undefined,
    cooldown: typeof e.cooldown === "number" ? e.cooldown : undefined,
  };
}

/**
 * T-118:判断根对象是否是**独立世界书**而非角色卡。
 * 独立世界书形如 `{ name?, scan_depth?, entries: [...] }`(或 entries 字典),
 * 根上没有 description/personality/scenario/first_mes 等角色字段。
 * 旧实现会让它落进 V1 分支 → 生成一张空名角色卡并落盘。
 */
function looksLikeLorebookObject(obj: Record<string, unknown>): boolean {
  const entries = obj.entries;
  const hasEntries = Array.isArray(entries) || (!!entries && typeof entries === "object");
  if (!hasEntries) return false;
  const rpFields = ["description", "personality", "scenario", "first_mes", "mes_example"];
  return !rpFields.some((k) => typeof obj[k] === "string" && (obj[k] as string).trim() !== "");
}

/** 行格式转义:内容里的反斜杠与换行转成 \\ / \n,保证一条条目只占一行 */
function escapeLoreContent(content: string): string {
  return content.replace(/\\/g, "\\\\").replace(/\r\n?/g, "\n").replace(/\n/g, "\\n");
}

/** escapeLoreContent 的逆操作 */
function unescapeLoreContent(content: string): string {
  let out = "";
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "\\") {
      const next = content[i + 1];
      if (next === "\\") {
        out += "\\";
        i++;
        continue;
      }
      if (next === "n") {
        out += "\n";
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * 编辑器显示用行格式:`关键词1,关键词2:内容`,每条条目一行。
 * 内容中的换行被转义,避免多行内容在 textarea 里被当成多条(旧实现会因此拆行截断)。
 */
export function loreEntriesToText(entries: LoreEntry[]): string {
  return entries.map((e) => `${e.keys.join(",")}:${escapeLoreContent(e.content)}`).join("\n");
}

/** 解析一行「关键词:内容」;非法/空行返回 null */
function parseLoreLine(line: string): { keys: string[]; content: string } | null {
  const idx = line.indexOf(":");
  if (idx <= 0) return null;
  const keys = line
    .slice(0, idx)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const content = unescapeLoreContent(line.slice(idx + 1)).trim();
  if (keys.length === 0 || !content) return null;
  return { keys, content };
}

/**
 * 按索引把编辑器的行格式文本合并回原条目:
 *  - 未改动的行 → 直接复用**原条目对象**(constant/selective/keyssecondary/position/
 *    probability/regex/... 全部保留,含换行的 content 也原样保留);
 *  - 改动过的行 → 只在原条目上覆盖显示层可编辑的 keys/content;
 *  - 超出原条目数量的行 → 追加为新条目。
 */
export function mergeLoreEntries(original: LoreEntry[], text: string): LoreEntry[] {
  const lines = text.split(/\r?\n/);
  const originalLines = original.map((e) => `${e.keys.join(",")}:${escapeLoreContent(e.content)}`);
  const merged: LoreEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) continue;
    const base = original[i];
    if (base && line === originalLines[i]) {
      merged.push(base);
      continue;
    }
    const parsed = parseLoreLine(line);
    if (!parsed) continue; // 残缺行(没有可触发关键词/内容)→ 丢弃
    if (base) {
      merged.push({ ...base, keys: parsed.keys, content: parsed.content });
    } else {
      merged.push({
        keys: parsed.keys,
        content: parsed.content,
        insertion_order: merged.length,
        enabled: true,
      });
    }
  }
  return merged;
}

/**
 * 保存内嵌世界书:保留原 book 的 name/description/scan_depth/token_budget,
 * 只合并条目;原卡无 book 且用户新增条目时按旧默认名创建。
 */
export function mergeLoreBook(
  original: CharacterBook | undefined,
  text: string,
  fallbackName: string
): CharacterBook | undefined {
  const entries = mergeLoreEntries(original?.entries ?? [], text);
  if (entries.length === 0) return undefined;
  return {
    ...(original ?? {}),
    name: original?.name ?? fallbackName,
    entries,
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
    // T-118:独立世界书(根级 entries)不是角色卡 —— 明确拒绝,而不是造空卡。
    if (looksLikeLorebookObject(obj)) return null;
    // V1 扁平(或带 spec 但无 data 的容错):至少要有 name 或 description,
    // 否则任意 JSON 对象(设置、配置、世界书片段…)都会被当成空白角色卡导入。
    const v1Name = typeof obj.name === "string" ? obj.name.trim() : "";
    const v1Description = typeof obj.description === "string" ? obj.description.trim() : "";
    if (!v1Name && !v1Description) return null;
    const card = cardFromData(obj);
    card.specVersion = obj.spec ? String(obj.spec) : "";
    return card;
  } catch {
    return null;
  }
}

/**
 * base64 → bytes（T-119 性能）。
 * `Uint8Array.from(atob(s), c => c.charCodeAt(0))` 对 5MB 实测约 880ms
 * （每个字符一次回调）；纯 for 循环约 22ms，差 40 倍。
 */
export function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 从 PNG 二进制(base64)解析角色卡:
 * 返回 { json, avatarBase64 } —— avatarBase64 为魔数前的原始 PNG(可作头像),
 * 无魔数时回退扫 tEXt 块(keyword="chara"),此时以整张图作头像。
 *
 * 兼容真实世界卡(酒馆/Chub 等导出):
 *  - **多段卡**:现代卡同时嵌 chara_card_v2 段 + chara_card_v3 段(V2 前 V3 后)。
 *    逐段尝试解析,取第一个合法 JSON 段(通常取到 V3 段)。
 *  - **JSON 内部自带 "spec":"chara_card_v2" 字符串**会误命中魔数——
 *    以 IEND 块之后的偏移为头像边界,尾串内逐候选试错跳过误命中。
 */
export function parseCharacterPng(
  base64: string
): { json: string; avatarBase64: string | null } | null {
  try {
    const bytes = base64ToBytes(base64);

    // ── T-119:按 PNG 块结构定位 IEND,而不是全文扫魔数 ─────────────
    // 现代酒馆卡的魔数紧跟在 IEND(含 CRC)之后。直接走块头跳到 IEND
    // 是 O(块数) 的偏移计算,图像数据一个字节都不用解码/复制;
    // 旧实现对每个魔数命中都 `slice(余下全部字节)` + decode + parse,
    // 5MB/200 命中 ≈ 3.3s、50MB 可冻结 webview。
    const pngEnd = findPngEnd(bytes);
    if (pngEnd >= 0) {
      const tail = decodeBytesFrom(bytes, pngEnd);
      const json = tryParseCardTail(tail);
      if (json) return { json, avatarBase64: avatarBefore(base64, bytes, pngEnd) };
      // T-120:尾部有魔数但所有分段都解析失败时**不能直接 return null** ——
      // 继续走下面的 tEXt 回退(裸 JSON 的 V2/V3 卡常只存在 tEXt 里)。
      if (tail.includes(MAGIC_V2) || tail.includes(MAGIC_V3)) {
        console.warn("[character-card] PNG 尾部魔数段解析失败，尝试 tEXt 回退");
      }
    } else {
      // 非标准 PNG(或没有合法块结构):保留全文扫描兜底,但**限制候选数**,
      // 且只 decode 一次,不再对每个命中复制剩余字节。
      const v2Bytes = new TextEncoder().encode(MAGIC_V2);
      const v3Bytes = new TextEncoder().encode(MAGIC_V3);
      const hits = findAllMagic(bytes, v2Bytes, v3Bytes, MAX_MAGIC_HITS);
      const firstHit = hits[0];
      if (firstHit) {
        const tail = decodeBytesFrom(bytes, firstHit.pos);
        const json = tryParseCardTail(tail);
        if (json) return { json, avatarBase64: avatarBefore(base64, bytes, firstHit.pos) };
      }
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

/** 非标准文件全文扫描时的魔数候选上限(T-119:防止每个命中都尝试解析) */
const MAX_MAGIC_HITS = 64;
/** 同一尾串里最多尝试解析的魔数候选数(多段卡 + JSON 内部 spec 误命中足够) */
const MAX_TAIL_PARSE_ATTEMPTS = 8;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 校验 PNG 签名并沿块头走到 IEND,返回 IEND 之后(含 CRC)的偏移;非法返回 -1 */
function findPngEnd(bytes: Uint8Array): number {
  if (bytes.length < 8) return -1;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return -1;
  }
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const len = readU32(bytes, offset);
    const dataEnd = offset + 8 + len;
    // 长度越界 = 坏块结构(不信任文件头);交给全文扫描兜底
    if (dataEnd + 4 > bytes.length) return -1;
    if (chunkTypeEquals(bytes, offset + 4, "IEND")) return dataEnd + 4;
    offset = dataEnd + 4;
  }
  return -1;
}

function chunkTypeEquals(bytes: Uint8Array, offset: number, type: string): boolean {
  if (offset + 4 > bytes.length) return false;
  for (let i = 0; i < 4; i++) {
    if (bytes[offset + i] !== type.charCodeAt(i)) return false;
  }
  return true;
}

/** 从 offset 到文件尾解码一次(只复制一次,不再逐命中复制) */
function decodeBytesFrom(bytes: Uint8Array, offset: number): string {
  return new TextDecoder().decode(bytes.subarray(offset));
}

/**
 * 在尾部文本中按出现顺序尝试魔数后的 JSON,直到解析出合法角色卡。
 * 多段卡(V2 魔数+JSON+V3 魔数+JSON)与 JSON 内部 "spec":"chara_card_v2"
 * 误命中都靠「逐个候选试错」排除。
 */
function tryParseCardTail(tail: string): string | null {
  let from = 0;
  for (let attempt = 0; attempt < MAX_TAIL_PARSE_ATTEMPTS; attempt++) {
    const a = tail.indexOf(MAGIC_V2, from);
    const b = tail.indexOf(MAGIC_V3, from);
    let pos = -1;
    let len = 0;
    if (a >= 0 && (b < 0 || a < b)) {
      pos = a;
      len = MAGIC_V2.length;
    } else if (b >= 0) {
      pos = b;
      len = MAGIC_V3.length;
    }
    if (pos < 0) return null;
    const json = tail.slice(pos + len).trim();
    if (json && parseCharacterJson(json)) return json;
    from = pos + len;
  }
  return null;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * 魔数之前的原始图像区作头像;不足一个 PNG 签名时视为无头像。
 *
 * 性能(同属 T-119):头像就是输入 base64 的前 `boundary` 字节,直接对原
 * base64 串做前缀切片(按 3 字节 / 4 字符对齐,末尾 1-2 字节单独编码)
 * 即可,不必把 5MB 字节重新编码(实测重编码约 400-800ms)。含空白字符的
 * 非标准 base64 才回退到完整重编码,保证正确性。
 */
function avatarBefore(base64: string, bytes: Uint8Array, boundary: number): string | null {
  if (boundary <= 8) return null;
  if (/\s/.test(base64)) return base64FromBytes(bytes.subarray(0, boundary));
  const full = Math.floor(boundary / 3) * 3;
  const chars = (full / 3) * 4;
  // 理论上 chars ≤ base64.length;防御坏输入
  if (chars > base64.length) return base64FromBytes(bytes.subarray(0, boundary));
  let out = base64.slice(0, chars);
  const rem = boundary - full;
  if (rem === 0) return out;
  const a = bytes[full] ?? 0;
  const b = bytes[full + 1] ?? 0;
  out += B64_ALPHABET[a >> 2];
  if (rem === 1) {
    // 只剩 1 字节:第 2 个字符后直接补 "=="
    out += `${B64_ALPHABET[(a & 3) << 4]}==`;
  } else {
    out += B64_ALPHABET[((a & 3) << 4) | (b >> 4)];
    out += `${B64_ALPHABET[(b & 15) << 2]}=`;
  }
  return out;
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
    const bytes = base64ToBytes(trimmed);
    const decoded = new TextDecoder().decode(bytes);
    JSON.parse(decoded);
    return decoded;
  } catch {
    return null;
  }
}

/**
 * 收集魔数命中位置(升序,最多 limit 个),含 JSON 内部的误命中(靠试错排除)。
 * T-119:limit 防止病态文件(图像数据里塞满 ASCII 魔数)产生海量候选;
 * 只记偏移,不复制字节。
 */
function findAllMagic(
  bytes: Uint8Array,
  v2: Uint8Array,
  v3: Uint8Array,
  limit: number
): { pos: number; len: number }[] {
  const out: { pos: number; len: number }[] = [];
  // 单次线性扫描:旧实现每轮分别 find(v2) / find(v3),某个魔数不存在时
  // 后者会把剩余字节整段重扫一遍 → 命中数 × 文件大小。
  const maxLen = Math.max(v2.length, v3.length);
  for (let i = 0; i + 1 < bytes.length && out.length < limit; i++) {
    if (bytes[i] !== v2[0] && bytes[i] !== v3[0]) continue;
    if (matchesAt(bytes, i, v2)) {
      out.push({ pos: i, len: v2.length });
      i += v2.length - 1;
    } else if (matchesAt(bytes, i, v3)) {
      out.push({ pos: i, len: v3.length });
      i += v3.length - 1;
    }
    // 保险:i 过于接近尾部时 loops cond 会自然结束
    if (i + maxLen > bytes.length) break;
  }
  return out;
}

/** bytes[offset..] 是否以 needle 开头(逐字节比较,不复制) */
function matchesAt(bytes: Uint8Array, offset: number, needle: Uint8Array): boolean {
  if (offset + needle.length > bytes.length) return false;
  for (let j = 0; j < needle.length; j++) {
    if (bytes[offset + j] !== needle[j]) return false;
  }
  return true;
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
        // 酒馆 V2 规范字段是 secondary_keys(数组);内部仍叫 keyssecondary
        secondary_keys: e.keyssecondary || [],
        comment: e.comment || "",
        content: e.content,
        constant: !!e.constant,
        selective: !!e.selective,
        insertion_order: e.insertion_order ?? 0,
        enabled: e.enabled !== false,
        position: e.position || "before_char",
        // 导入时特意保留的高级字段:导出必须反向映射,否则往返即丢(见 T-030)
        case_sensitive: e.case_sensitive,
        probability: e.probability,
        recursive: e.recursive,
        regex: e.regex,
        match_whole_words: e.match_whole_words,
        min_activations: e.min_activations,
        sticky: e.sticky,
        cooldown: e.cooldown,
        extensions: {},
      })),
    };
  }
  return JSON.stringify({ spec: MAGIC_V2, spec_version: "2.0", data }, null, 2);
}

/** 组装导出用 PNG(头像原图 + 魔数 + JSON);无头像时返回 null(应导出 JSON) */
export function buildExportPng(avatarBase64: string, json: string): string {
  const avatarBytes = base64ToBytes(avatarBase64);
  const magic = new TextEncoder().encode(MAGIC_V2);
  const jsonBytes = new TextEncoder().encode(json);
  const out = new Uint8Array(avatarBytes.length + magic.length + jsonBytes.length);
  out.set(avatarBytes, 0);
  out.set(magic, avatarBytes.length);
  out.set(jsonBytes, avatarBytes.length + magic.length);
  return base64FromBytes(out);
}
