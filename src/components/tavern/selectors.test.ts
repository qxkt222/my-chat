// components/tavern/selectors.test.ts — TavernView 派生计算的回归测试

import { describe, it, expect } from "vitest";
import { GROUP_KEY, filterCharacters, groupConversationsByCharacter } from "./selectors";
import type { CharacterCard, TavernConversation } from "@/types";

function card(id: string, name: string, tags: string[] = []): CharacterCard {
  return { id, name, tags } as CharacterCard;
}
function conv(id: string, characterId: string, groupCharIds?: string[]): TavernConversation {
  return { id, character_id: characterId, groupCharIds } as TavernConversation;
}

describe("filterCharacters", () => {
  const cards = [card("1", "爱丽丝", ["奇幻"]), card("2", "Bob", ["Sci-Fi"])];

  it("空查询原样返回（连引用都不换）", () => {
    expect(filterCharacters(cards, "")).toBe(cards);
    expect(filterCharacters(cards, "   ")).toBe(cards);
  });

  it("按名字匹配，且大小写不敏感", () => {
    expect(filterCharacters(cards, "bob").map((c) => c.id)).toEqual(["2"]);
    expect(filterCharacters(cards, "爱丽").map((c) => c.id)).toEqual(["1"]);
  });

  it("按标签匹配，同样大小写不敏感", () => {
    expect(filterCharacters(cards, "sci-fi").map((c) => c.id)).toEqual(["2"]);
    expect(filterCharacters(cards, "奇幻").map((c) => c.id)).toEqual(["1"]);
  });
});

describe("groupConversationsByCharacter", () => {
  it("普通会话按 character_id 分组", () => {
    const map = groupConversationsByCharacter([conv("a", "char-1"), conv("b", "char-1")]);
    expect(map["char-1"]?.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("两个及以上角色的会话归到 __group__，不挂在首角色名下", () => {
    const map = groupConversationsByCharacter([
      conv("g", "char-1", ["char-1", "char-2"]),
      conv("a", "char-1"),
    ]);
    expect(map[GROUP_KEY]?.map((c) => c.id)).toEqual(["g"]);
    expect(map["char-1"]?.map((c) => c.id)).toEqual(["a"]);
  });

  it("只有一个角色 id 的会话不算群聊（仍按 character_id）", () => {
    const map = groupConversationsByCharacter([conv("x", "char-1", ["char-1"])]);
    expect(map[GROUP_KEY]).toBeUndefined();
    expect(map["char-1"]?.map((c) => c.id)).toEqual(["x"]);
  });
});
