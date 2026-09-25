// lib/regex-import.ts — 酒馆(SillyTavern)「正则脚本套件」导入(纯函数)
//
// 背景（2026-09-25 实测事故）：开发者把 `FF5 Regex 3.0 Suite.json` 当预设导入，
// 应用回「这是角色卡」。查下来它是**第四种文件类型**——一个 JSON **数组**，
// 每项是一条正则脚本：
//   { id, scriptName, findRegex: "/…/gi", replaceString, trimStrings,
//     placement: [2] | [2,1], disabled, markdownOnly, promptOnly, ... }
// 既不是预设、不是角色卡、也不是世界书；应用原本没有这种文件的解析器，
// 于是落到了最后的兜底分支被误报。
//
// 能力边界（必须如实告知，不假装全部支持）：
//   · markdownOnly（只改显示）→ 本应用的渲染期正则正是干这个的，**能支持**
//   · promptOnly（只改发给模型的提示词）→ 本应用的正则只在渲染期跑，
//     **做不到**，导入时应单独数出来告诉用户，而不是混进去当普通规则
//   · placement 的深度区间 / trimStrings / substituteRegex 等字段本应用无对应概念，丢弃

import type { RegexRule } from "./regex-format";

/** 酒馆正则脚本的一条（只列我们真正读的字段，别的原样忽略） */
interface TavernRegexScript {
  id?: string;
  scriptName?: string;
  findRegex?: string;
  replaceString?: string;
  disabled?: boolean;
  markdownOnly?: boolean;
  promptOnly?: boolean;
}

export interface RegexImportResult {
  /** 可直接喂给 settings.regexRules 的规则 */
  rules: RegexRule[];
  /** 只作用于提示词、本应用无法生效的条数（如实告知用） */
  promptOnlySkipped: number;
  /** 标记为 disabled 的条数（导入时保持禁用） */
  disabledCount: number;
}

/**
 * 判断一段 JSON 是不是酒馆正则套件。
 * 判据：根是**非空数组**，且**每一项**都有 findRegex 字符串。
 * 用「每一项」而不是「第一项」——避免把恰好含一个 findRegex 字段的其它数组误判。
 */
export function looksLikeRegexSuite(rawJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    return parsed.every(
      (it) =>
        it !== null &&
        typeof it === "object" &&
        typeof (it as TavernRegexScript).findRegex === "string"
    );
  } catch {
    return false;
  }
}

/**
 * 解析 `/pattern/flags` 形态的酒馆正则。
 *
 * 为什么不能只存 pattern：本应用的 applyRegexRules 历史实现把标志硬编码成 `g`，
 * 而实测这套预设 22/25 条带 `i`（大小写不敏感）。丢掉 `i` 会让规则**看起来导入了、
 * 实际匹配不上**——比报错更糟。所以这里把标志一并解析出来存进 flags。
 *
 * 手写扫描而不是正则：pattern 里可能含转义的 `/`（如 `\/`），
 * 用「最后一个未转义的 `/`」才是正确切分点。
 */
export function parseTavernRegex(re: string): { pattern: string; flags: string } {
  const s = re.trim();
  if (!s.startsWith("/")) return { pattern: s, flags: "g" };
  // 从右往左找最后一个「未被反斜杠转义」的 '/'
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i] !== "/") continue;
    let backslashes = 0;
    for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) backslashes++;
    if (backslashes % 2 === 1) continue; // 这个 '/' 是被转义的，不是分隔符
    const pattern = s.slice(1, i);
    const rawFlags = s.slice(i + 1);
    const flags = /^[gimsuy]*$/.test(rawFlags)
      ? rawFlags.includes("g")
        ? rawFlags
        : rawFlags + "g" // 渲染期「全部替换」是既定语义，保证带 g
      : "g";
    return { pattern, flags };
  }
  // 只有一个开头的 '/'（残缺），退化为把剩余当 pattern
  return { pattern: s.slice(1), flags: "g" };
}

/**
 * 解析酒馆正则套件，返回可导入的规则 + 能力边界统计。
 * 坏项跳过而不是整包失败（与 lorebook/preset 导入的容错口径一致）。
 */
export function parseTavernRegexSuite(rawJson: string): RegexImportResult {
  const out: RegexImportResult = { rules: [], promptOnlySkipped: 0, disabledCount: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;

  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const s = item as TavernRegexScript;
    const find = typeof s.findRegex === "string" ? s.findRegex.trim() : "";
    if (!find) continue;

    // 只改提示词的脚本本应用生效不了：数出来告诉用户，不混进规则列表
    if (s.promptOnly === true) {
      out.promptOnlySkipped += 1;
      continue;
    }

    const { pattern, flags } = parseTavernRegex(find);
    if (!pattern) continue;

    const name = (typeof s.scriptName === "string" && s.scriptName.trim()) || "酒馆正则";
    out.rules.push({
      id: `tavern-${typeof s.id === "string" && s.id ? s.id : crypto.randomUUID()}`,
      name,
      pattern,
      replacement: typeof s.replaceString === "string" ? s.replaceString : "",
      // 保持酒馆里的启用状态（disabled=true → 导入后也是关的）
      enabled: s.disabled !== true,
      flags,
    });
    if (s.disabled === true) out.disabledCount += 1;
  }
  return out;
}
