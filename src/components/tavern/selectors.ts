// components/tavern/selectors.ts — TavernView 的派生计算（从组件里抽出）
//
// 这两块原先是组件体里的 useMemo：一个把角色卡按搜索词过滤，一个把会话按角色分组。
// 抽出来的好处有二：能测，以及把「群聊为什么单独分组」这类约定从 1000 行的 jsx 中间
// 挪到明处 —— 之前它只是一行注释，改坏了没人拦。

import type { CharacterCard, TavernConversation } from "@/types";

/** 会话列表里代表「群聊」的分组键（群聊不挂在任何单个角色名下） */
export const GROUP_KEY = "__group__";

/** 按搜索词过滤角色卡：匹配名字或任一 tag（大小写不敏感）；空查询原样返回 */
export function filterCharacters(cards: CharacterCard[], query: string): CharacterCard[] {
  const q = query.trim().toLowerCase();
  if (!q) return cards;
  return cards.filter(
    (c) => c.name.toLowerCase().includes(q) || c.tags.some((x) => x.toLowerCase().includes(q))
  );
}

/**
 * 会话按所属角色分组。
 *
 * 群聊（`groupCharIds` 长度 ≥ 2）统一归到 `GROUP_KEY` 下 —— 此前它们被塞进
 * 首个角色的名下，导致分组与搜索结果错位。**只有一个角色 id 的会话不算群聊**，
 * 仍按 `character_id` 归组。
 */
export function groupConversationsByCharacter(
  convs: readonly TavernConversation[]
): Record<string, TavernConversation[]> {
  const map: Record<string, TavernConversation[]> = {};
  for (const c of convs) {
    const key = (c.groupCharIds?.length || 0) >= 2 ? GROUP_KEY : c.character_id;
    (map[key] ||= []).push(c);
  }
  return map;
}
