// stores/tavern/group-owner.ts — 群聊自动回应的角色归属解析（从 useTavernStore.ts 拆出）
//
// 纯函数、零 store 依赖，拆出来之后才第一次有了真测试（group-owner.test.ts）。
// 此前 `PROGRESS.md` 写的「群聊归属解析 8/8 通过」是用临时脚本跑的 —— 脚本没留下，
// 所以那 8 条其实不在 `npm test` 里，改坏了也没人知道。

/**
 * 解析群聊回复的角色归属(酒馆群聊:自动模式下 AI 回复按角色拆分)。
 * 支持格式:
 *   1. 【角色名】 开头          —— 酒馆规范格式
 *   2. 角色名: 开头(中英冒号)   —— 常见变体
 *   3. *角色名* 或 (角色名) 前缀 —— 动作描写风格
 *   4. 开头直接是角色名(模糊匹配)
 * 返回 { owner, content }(content 已去掉标记),识别失败返回 null。
 */
export function parseGroupOwner(
  content: string,
  roleNames: string[]
): { owner: string; content: string } | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  // 1) 【角色名】 开头
  const bracket = /^【([^】]+)】\s*/.exec(trimmed);
  if (bracket) {
    const owner = matchRole(bracket[1] ?? "", roleNames);
    if (owner) return { owner, content: trimmed.slice((bracket[0] ?? "").length) };
  }

  // 2) 角色名: 开头
  const colon = /^([^：:]{1,30})[：:]\s*/.exec(trimmed);
  if (colon) {
    const owner = matchRole((colon[1] ?? "").trim(), roleNames);
    if (owner) return { owner, content: trimmed.slice((colon[0] ?? "").length) };
  }

  // 3) *角色名* / (角色名) 前缀
  const star = /^\*([^*]{1,30})\*\s*/.exec(trimmed);
  if (star) {
    const owner = matchRole((star[1] ?? "").trim(), roleNames);
    if (owner) return { owner, content: trimmed.slice((star[0] ?? "").length) };
  }
  const paren = /^\(([^)]{1,30})\)\s*/.exec(trimmed);
  if (paren) {
    const owner = matchRole((paren[1] ?? "").trim(), roleNames);
    if (owner) return { owner, content: trimmed.slice((paren[0] ?? "").length) };
  }

  // 4) 开头直接是角色名(截取前几个字符模糊匹配)
  const head = trimmed.slice(0, 12);
  for (const name of roleNames) {
    if (head.startsWith(name)) {
      return { owner: name, content: trimmed.slice(name.length).replace(/^[：:]\s*/, "") };
    }
  }

  return null;
}

/** 精确匹配 → 去空格 → 大小写不敏感,任一命中即返回规范名 */
function matchRole(candidate: string, roleNames: string[]): string | null {
  const c = candidate.trim();
  if (!c) return null;
  for (const name of roleNames) {
    if (name === c || name.toLowerCase() === c.toLowerCase() || name.trim() === c) return name;
  }
  return null;
}
