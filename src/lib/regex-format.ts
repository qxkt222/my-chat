// lib/regex-format.ts — AI 回复 Regex 后处理(酒馆 Regex 样式美化)
//
// 在渲染前对回复文本做正则替换(不改原始数据,规则可随时开关,历史消息也生效)。
// 内置规则 + 用户自定义规则;每条规则独立 try/catch,坏正则跳过不影响其他。

export interface RegexRule {
  id: string;
  name: string;
  pattern: string;
  replacement: string;
  enabled: boolean;
  /** 正则标志。缺省 = 只用 "g"（渲染期「全部替换」是既定语义）。
   *  2026-09-25 加：酒馆正则套件里 22/25 条带 `i`（大小写不敏感），
   *  丢掉它会让规则「看起来导入了、实际匹配不上」——比报错更糟。 */
  flags?: string | undefined;
  /** 生效位置（酒馆 placement 语义）：
   *   1 = 显示（渲染期，用户看到的文本）
   *   2 = 发送给模型的消息（出站清理）
   *  缺省/undefined = 只用 1（历史行为：本应用正则一直是渲染期的，不能变）。
   *  ⚠️ 2026-09-25 加：实测那套 FF5 预设里 5 条是 `[2]`（只改提示词，如剥掉
   *  `<internal_states>`、`<!-- IMG_PROMPT -->`），若混进渲染期规则，
   *  用户界面上自己的思考块会凭空消失 —— 必须按位置分开两条通路。 */
  placement?: number[] | undefined;
  /** 深度窗口（酒馆 minDepth/maxDepth 语义）：只作用于「距末尾 depth 条」的消息。
   *  depth 从末尾 0 起算，只数 user/assistant 消息（与酒馆一致，system 不计）。
   *  缺省 = 不限。 */
  minDepth?: number | null | undefined;
  maxDepth?: number | null | undefined;
}

/** 这条规则是否作用于「显示」 */
export function appliesToDisplay(r: Pick<RegexRule, "placement">): boolean {
  // 缺省 = 显示（历史行为）；显式给了就是给了
  return r.placement === undefined ? true : r.placement.includes(1);
}

/** 这条规则是否作用于「发给模型的消息」 */
export function appliesToPrompt(r: Pick<RegexRule, "placement">): boolean {
  return r.placement !== undefined && r.placement.includes(2);
}

/** 内置规则(默认启用):去 OOC 注释 + 去全大写括号指令 */
export const BUILTIN_REGEX_RULES: RegexRule[] = [
  {
    id: "regex-ooc",
    name: "去 OOC 注释",
    enabled: true,
    pattern: "\\(OOC:\\s*.*?\\)|\\(ooc:\\s*.*?\\)|（OOC：.*?）",
    replacement: "",
  },
  {
    id: "regex-caps",
    name: "去全大写括号指令",
    enabled: true,
    pattern: "\\([A-Z\\s]{4,}\\)",
    replacement: "",
  },
  {
    id: "regex-quote",
    name: "「」→ 中文引号",
    enabled: false,
    pattern: "「([^」]*)」",
    replacement: "“$1”",
  },
];

/** 逐条应用规则(顺序 = 数组顺序),坏正则跳过
 *
 *  只应用「作用于显示」的规则 —— 出站清理走 lib/outgoing-regex.ts 的
 *  applyOutgoingRegex（那里还要处理深度窗口）。
 *  缺省 placement 的规则算显示（历史行为），所以内置 3 条与用户手建规则不受影响。 */
export function applyRegexRules(content: string, rules: RegexRule[]): string {
  let out = content;
  for (const r of rules) {
    if (!r.enabled || !r.pattern) continue;
    if (!appliesToDisplay(r)) continue;
    try {
      // 标志：规则自带优先（酒馆导入的带 i），否则沿用历史上的 "g"
      out = out.replace(new RegExp(r.pattern, r.flags || "g"), r.replacement);
    } catch {
      /* 坏正则跳过 */
    }
  }
  return out;
}
