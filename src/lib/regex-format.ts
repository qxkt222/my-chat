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

/** 逐条应用规则(顺序 = 数组顺序),坏正则跳过 */
export function applyRegexRules(content: string, rules: RegexRule[]): string {
  let out = content;
  for (const r of rules) {
    if (!r.enabled || !r.pattern) continue;
    try {
      out = out.replace(new RegExp(r.pattern, "g"), r.replacement);
    } catch {
      /* 坏正则跳过 */
    }
  }
  return out;
}
