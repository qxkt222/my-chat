// components/chat/input-triggers.ts — 输入框里的触发词检测（从 ChatInput 抽出）
//
// 两条都是纯字符串逻辑。抽出来才能测：`..` 什么时候算触发、`@` 后面取什么当搜索词，
// 边界一旦改错就表现为「菜单该弹不弹 / 不该弹乱弹」，而在一千行的组件里很难查。

/**
 * 行尾（或整段只有）`..` 触发 prompt 链。
 * 返回是否触发，以及**去掉触发词之后**的文本（避免触发词残留在输入框里）。
 */
export function detectChainTrigger(value: string): { triggered: boolean; stripped: string } {
  if (/\s\.\.\s*$/.test(value) || value.trim() === "..") {
    return { triggered: true, stripped: value.replace(/\s*\.\.\s*$/, "") };
  }
  return { triggered: false, stripped: value };
}

/**
 * 取行尾 `@` 之后的搜索词。
 *
 * 返回 `null` = 没有 `@` 触发；返回空串 = 刚敲下 `@` 还没输内容（此时菜单该弹出全部候选），
 * 两者语义不同，不能合并。
 */
export function detectMentionQuery(value: string): string | null {
  const m = /@([^\s@]*)$/.exec(value);
  return m ? (m[1] ?? "") : null;
}
