// lib/quick-reply.ts — Quick Reply 按钮/宏面板(30)+ STscript 轻量(32)
//
// 酒馆/推演输入区:用户自定义快捷按钮(掷骰/切表情/触发设定),带宏占位符。
// STscript 轻量子集:模板支持 {{char}}/{{user}}/{{input}} 宏 + 内置动作
// `[roll D100 65]`(掷骰并拼入)与 `[ask 问题]`(弹出输入框取用户输入)。
// 不引入完整 DSL——聚焦常用交互子集(对齐 ST Quick Reply + /input /buttons)。

import { rollDice } from "./sim-prompt";

export interface QuickReply {
  id: string;
  name: string;
  /** 模板,支持宏与内置动作 */
  template: string;
  /** 图标 emoji(可选) */
  icon?: string;
}

const QR_KEY = "quick_replies";

/** 内置快捷按钮(酒馆/推演通用) */
const BUILTIN_QUICK: QuickReply[] = [
  { id: "qr-roll", name: "掷骰", template: "[roll D100 65]", icon: "🎲" },
  { id: "qr-continue", name: "继续", template: "继续推演,自然发展。", icon: "▶" },
  { id: "qr-note", name: "加注", template: "[ask 想注入什么设定?]", icon: "📝" },
];

/** 加载全部快捷按钮(内置 + 自定义) */
export function loadQuickReplies(): QuickReply[] {
  try {
    const custom = JSON.parse(localStorage.getItem(QR_KEY) || "[]") as QuickReply[];
    return [...BUILTIN_QUICK, ...custom.filter((q) => q && q.id && q.template)];
  } catch {
    return BUILTIN_QUICK;
  }
}

export function saveQuickReplies(custom: QuickReply[]): void {
  localStorage.setItem(QR_KEY, JSON.stringify(custom));
}

/**
 * 渲染快捷按钮模板为最终输入文本:
 *  - 宏:{{char}}/{{user}} 替换;{{input}} 取当前输入框内容
 *  - 内置动作:[roll D100 65] → 骰子结果文本; [ask 问题] → 同步 prompt 用户输入
 * 返回 { text, ask }(ask 非空时调用方需先弹出输入框再发送)。
 */
export function renderQuickReply(
  q: QuickReply,
  vars: { char: string; user: string; input: string }
): { text: string; ask: string | null } {
  let text = q.template
    .split("{{char}}")
    .join(vars.char)
    .split("{{user}}")
    .join(vars.user)
    .split("{{input}}")
    .join(vars.input);

  // STscript 轻量:内置动作 [roll ...] / [ask ...]
  let ask: string | null = null;
  const rollRe = /\[roll\s+([A-Za-z]+\d+)(?:\s+(\d+))?\]/g;
  text = text.replace(rollRe, (_, dice: string, th?: string) => {
    const r = rollDice(dice, th ? Number(th) : null);
    return r.text;
  });
  const askRe = /\[ask\s+([^\]]+)\]/g;
  const askMatch = askRe.exec(text);
  if (askMatch) {
    ask = (askMatch[1] ?? "").trim();
    text = text.replace(askRe, "").trim();
  }
  return { text, ask };
}
