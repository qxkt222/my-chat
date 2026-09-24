// stores/tavern/group-owner.test.ts — 群聊归属解析的回归测试
//
// 为什么现在才写：这个函数此前只有「临时脚本跑过 8/8」的记载（见 PROGRESS.md V0.8），
// 而那个脚本没留在仓库里 —— 等于 `npm test` 从没覆盖过它，改坏了没人知道。
// 拆分时顺手把它固定成真测试。

import { describe, it, expect } from "vitest";
import { parseGroupOwner } from "./group-owner";

const ROLES = ["爱丽丝", "Bob", "凯尔"];

describe("parseGroupOwner", () => {
  it("【角色名】开头（酒馆规范格式）", () => {
    expect(parseGroupOwner("【爱丽丝】你好呀", ROLES)).toEqual({
      owner: "爱丽丝",
      content: "你好呀",
    });
  });

  it("角色名 + 中/英冒号两种写法", () => {
    expect(parseGroupOwner("Bob: hi there", ROLES)).toEqual({ owner: "Bob", content: "hi there" });
    expect(parseGroupOwner("凯尔：来了", ROLES)).toEqual({ owner: "凯尔", content: "来了" });
  });

  it("*角色名* 与 (角色名) 前缀（动作描写风格）", () => {
    expect(parseGroupOwner("*爱丽丝* 转过身", ROLES)).toEqual({
      owner: "爱丽丝",
      content: "转过身",
    });
    expect(parseGroupOwner("(Bob) waves", ROLES)).toEqual({ owner: "Bob", content: "waves" });
  });

  it("开头直接是角色名（含大小写不敏感）", () => {
    expect(parseGroupOwner("爱丽丝说了句话", ROLES)?.owner).toBe("爱丽丝");
    // 小写也要能匹配回规范名 Bob
    expect(parseGroupOwner("bob: 小写也算", ROLES)?.owner).toBe("Bob");
  });

  it("认不出来就返回 null（不瞎猜成第一个角色）", () => {
    expect(parseGroupOwner("随便一段旁白", ROLES)).toBeNull();
    expect(parseGroupOwner("   ", ROLES)).toBeNull();
  });
});
