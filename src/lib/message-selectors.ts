// lib/message-selectors.ts — 消息列表的线性扫描工具
//
// 审计 SRC-03:TavernView 的 map 里对每一行执行
//   messages.slice(mi + 1).every((x) => x.role !== "assistant")
// 每行复制一次尾部数组 → O(n²)。改成「先扫一次拿到下标」后变成 O(n),
// 渲染里只做整数比较。
//
// 这里的函数只依赖 messages[i].role,不关心 Message 的其余字段,
// 因此既能用于酒馆(Message[]),也能用于只带 role/content 的待发副本。

export interface RoleBearing {
  role: string;
}

/**
 * 最后一条 assistant 消息的下标;没有则返回 -1。
 * 从尾部向前扫,遇到第一条 assistant 立即返回 —— O(n) 最坏、通常更快。
 */
export function lastAssistantIndex(messages: ReadonlyArray<RoleBearing>): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return i;
  }
  return -1;
}

/**
 * 第 index 条消息是否是「最后一条 assistant」(酒馆里唯一支持重新生成/继续的行)。
 *
 * ⚠️ 这是 O(n) 的单次判断。在逐行渲染里请**不要**对每行调用它(那还是 O(n²)),
 * 正确用法是渲染前算一次 `lastAssistantIndex(messages)`,行内比较下标。
 */
export function isLastAssistantMessage(
  messages: ReadonlyArray<RoleBearing>,
  index: number
): boolean {
  if (index < 0 || index >= messages.length) return false;
  if (messages[index]?.role !== "assistant") return false;
  return lastAssistantIndex(messages) === index;
}
