// lib/real-suite-check.test.tsx — 用**真实酒馆正则套件**做端到端校验
//
// 为什么留这条：2026-09-25 那次「预设被误判成角色卡」事故里，我自己造的合成数据
// （3 条脚本）**没能**暴露问题 —— 真实文件有 25 条、字段分布不同
// （gi/g 混、placement 有 [2] 与 [2,1]、markdownOnly/promptOnly 并存）。
//
// 真实内容由本机文件提供（只在开发者机器上存在时跑，否则整组 skip）：
//   · 仓库里不留个人路径以外的依赖；文件缺失就是 skip，不影响常规 CI
//   · 本项目没装 @types/node，所以 node:fs 的导入用 @ts-expect-error 放行
//     （运行时由 vitest（Node）提供，没问题）
//
// 想换文件：只改下面的 REAL_FILE。

import { describe, it, expect } from "vitest";
import { parseTavernRegexSuite } from "./regex-import";
import { applyOutgoingRegex, activeOutgoingCount } from "./outgoing-regex";
import { applyRegexRules } from "./regex-format";
import { parseCharacterJson } from "./character-card";
import type { Message } from "@/types";

const REAL_FILE = "C:/Users/1/Downloads/Compressed/FF5 Regex 3.0 Suite.json";

/** 读取真实文件；缺 @types/node 所以这里显式忽略类型检查 */
// @ts-expect-error 本项目未安装 @types/node，运行时由 Node 提供
const fsMod = (await import("node:fs")) as {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: string) => string;
};

const has = fsMod.existsSync(REAL_FILE);
const raw = has ? fsMod.readFileSync(REAL_FILE, "utf8") : "";

/** 造历史消息时收窄 role 的类型（对象字面量默认被推成 string） */
function msg(
  role: "user" | "assistant" | "system",
  content: string
): Pick<Message, "role" | "content"> {
  return { role, content };
}

// 实测计数（node 直读该文件算得，作为断言期望值）：
//   总数 25 · 含 placement 2 = 25 · 含 placement 1 = 2 · 只有 2 = 23 · disabled = 0
describe.skipIf(!has)("真实酒馆正则套件（端到端回归）", () => {
  it("25 条全部导入 —— 一条都不跳过", () => {
    const r = parseTavernRegexSuite(raw);
    expect(r.rules).toHaveLength(25);
    expect(r.disabledCount).toBe(0);
  });

  it("placement 分布：25 条作用于出站、2 条也作用于显示", () => {
    const r = parseTavernRegexSuite(raw);
    expect(r.promptCount).toBe(25); // 全是 [2] 系 —— 这是一套「出站清理」套件
    expect(r.displayCount).toBe(2); // 只有那两条 [2,1]
  });

  it("不再被误判成角色卡", () => {
    expect(parseCharacterJson(raw)).toBeNull();
  });

  it("启用中的出站规则数 = 25", () => {
    expect(activeOutgoingCount(parseTavernRegexSuite(raw).rules)).toBe(25);
  });

  it("出站清理剥掉标记，并尊重深度窗口（Context Saver minDepth=2）", () => {
    const r = parseTavernRegexSuite(raw);
    const dirty =
      "回答正文\n<internal_states>状态</internal_states>\n<!-- IMG_PROMPT: p -->\n" +
      "<!-- GFX_START --><div>图形正文</div><!-- GFX_END -->\n<thinking>想法</thinking>";

    // 三条历史 → depth 2 / 1 / 0。Context Saver 的 minDepth=2 只清 depth≥2 那条，
    // 最新两条保留 —— 这正是酒馆语义，不是我们发明的。
    const out = applyOutgoingRegex(
      [msg("assistant", dirty), msg("user", "中间那条"), msg("user", "最新那条")],
      r.rules
    );
    const oldest = out[0]?.content ?? "";

    expect(oldest).toContain("回答正文");
    expect(oldest).not.toContain("internal_states"); // minDepth=2 命中 depth 2
    expect(oldest).not.toContain("IMG_PROMPT");
    expect(oldest).not.toContain("GFX_START");
    expect(oldest).not.toContain("想法"); // 思考块（无深度限制）也被剥
    expect(oldest.length).toBeLessThan(dirty.length);

    expect(out[1]?.content).toBe("中间那条");
    expect(out[2]?.content).toBe("最新那条");

    // 显示侧：这套预设只有 2 条作用于显示，internal_states 仍在
    // （与酒馆一致 —— 出站清理不该让界面上的内容凭空消失）
    expect(applyRegexRules(dirty, r.rules)).toContain("internal_states");
  });
});
