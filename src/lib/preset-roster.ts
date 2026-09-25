// lib/preset-roster.ts — 「全局条目名册」的纯函数层
//
// 背景（2026-09-25 改造）：原先预设是「一套生效」——角色卡绑一个 presetId。
// 导入一套酒馆预设会被压平成几十条互斥的候选，用户没法像酒馆那样「开 5 关 3」。
// 现在每条预设都可以作为名册里的一条**条目**参与拼装，开关是**全局**的、
// 与角色无关（角色只管自己的 system_prompt 与世界书）。
//
// 设计要点：
//   · 全纯函数，不读全局状态、不落盘 —— 便于单测钉死行为。
//   · 「已启用」只认 `=== true`：旧数据（34 个已落盘 JSON）没有这个键，
//     真值判断会把它们全当成启用，一下把 6.5 万字的「默认组合」默认开上。
//   · order 缺失/重复时排序必须**稳定**：拼装顺序直接决定 DeepSeek 缓存前缀，
//     顺序一抖缓存就失效（界面上看不出来，只是变慢变贵）。

import type { PromptPreset, PresetRosterIndex } from "@/types";

/** 未分组的预设（内置预设、手工新建的自定义预设）在 UI 里归到这一区 */
export const UNGROUPED = "__ungrouped__";
export const UNGROUPED_LABEL = "未分组（内置/自定义）";

/** 缺 order 的条目排在最后。不用 Infinity —— 参与算术会出 NaN。 */
const ORDER_LAST = Number.MAX_SAFE_INTEGER;

/** 这一条是否参与拼装。**只认 === true**（旧数据没有这个键）。 */
export function isEntryEnabled(p: Pick<PromptPreset, "enabled">): boolean {
  return p.enabled === true;
}

/** 取排序用的 order 值；非法值一律当「排最后」。 */
export function orderOf(p: Pick<PromptPreset, "order">): number {
  return Number.isFinite(p.order) ? (p.order as number) : ORDER_LAST;
}

/** 条目归属的包名（未分组返回 UNGROUPED）。 */
export function groupOf(p: Pick<PromptPreset, "group">): string {
  return typeof p.group === "string" && p.group.length > 0 ? p.group : UNGROUPED;
}

/**
 * 稳定排序：先按 order 升序，order 相同则保持入参相对顺序（Array.sort 在
 * 现代引擎里已是稳定排序，这里显式写明依赖它，并用 id 兜底避免误读）。
 */
function sortStable(list: PromptPreset[]): PromptPreset[] {
  return [...list]
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const d = orderOf(a.p) - orderOf(b.p);
      return d !== 0 ? d : a.i - b.i;
    })
    .map((x) => x.p);
}

/**
 * 拼装名册：取出所有**已启用**条目，按 order 升序拼接成最终提示词基座。
 * 全未启用时返回空串 —— 调用方据此回退到角色卡绑定的单套预设。
 */
export function assembleRoster(presets: PromptPreset[]): string {
  const enabled = sortStable(presets.filter(isEntryEnabled));
  return enabled
    .map((p) => p.template.trim())
    .filter((t) => t.length > 0)
    .join("\n\n");
}

/** 字数（与 UI 显示、预算比较同口径：按字符数，不估 token） */
export function charCount(p: Pick<PromptPreset, "template">): number {
  return p.template.length;
}

/** 已启用条目的字数合计（UI 实时显示用） */
export function enabledCharTotal(presets: PromptPreset[]): number {
  return presets.filter(isEntryEnabled).reduce((s, p) => s + charCount(p), 0);
}

/** 已启用条目数（UI 显示与「是否回退」判断共用） */
export function enabledCount(presets: PromptPreset[]): number {
  return presets.filter(isEntryEnabled).length;
}

export interface RosterGroup {
  /** 包标识（UNGROUPED 表示未分组） */
  key: string;
  /** 展示名 */
  label: string;
  /** 包内条目，已按 order 排好 */
  entries: PromptPreset[];
  /** 该包内已启用条目的字数合计 */
  enabledChars: number;
}

/**
 * 按包分区，供 UI 渲染。
 * 包顺序：优先用索引里的 groupOrder，未列出的包按包名排序兜底；
 * UNGROUPED 恒定排最后（内置/自定义不属于任何导入批次）。
 */
export function splitByGroup(
  presets: PromptPreset[],
  index?: PresetRosterIndex | null | undefined
): RosterGroup[] {
  const buckets = new Map<string, PromptPreset[]>();
  for (const p of presets) {
    const g = groupOf(p);
    const arr = buckets.get(g);
    if (arr) arr.push(p);
    else buckets.set(g, [p]);
  }

  const declared = index?.groupOrder ?? [];
  const keys = [...buckets.keys()].filter((k) => k !== UNGROUPED);
  keys.sort((a, b) => {
    const ia = declared.indexOf(a);
    const ib = declared.indexOf(b);
    if (ia !== -1 || ib !== -1) {
      // 声明过的优先，未声明的排在声明过的之后
      return (ia === -1 ? declared.length : ia) - (ib === -1 ? declared.length : ib);
    }
    return a.localeCompare(b);
  });

  const ordered = buckets.has(UNGROUPED) ? [...keys, UNGROUPED] : keys;
  return ordered.map((k) => {
    const entries = sortStable(buckets.get(k) ?? []);
    return {
      key: k,
      label: k === UNGROUPED ? UNGROUPED_LABEL : k,
      entries,
      enabledChars: enabledCharTotal(entries),
    };
  });
}

/** 空索引（首次运行 / 文件缺失时用，避免各处判空） */
export function emptyRosterIndex(): PresetRosterIndex {
  return { groupOrder: [], entryOrder: {}, updated_at: new Date(0).toISOString() };
}

/** 取某包内条目的顺序；索引没记录时用现有 entries 的顺序兜底 */
export function entryOrderOf(
  index: PresetRosterIndex | null | undefined,
  group: string,
  fallbackIds: string[]
): string[] {
  const declared = index?.entryOrder?.[group];
  if (!Array.isArray(declared) || declared.length === 0) return [...fallbackIds];
  // 只保留仍然存在的条目，并把索引里没提到的新条目补到末尾
  const kept = declared.filter((id) => fallbackIds.includes(id));
  const missing = fallbackIds.filter((id) => !kept.includes(id));
  return [...kept, ...missing];
}

/**
 * 计算「把 withinGroup 里的第 i 条往上/下移一位」后的新顺序。
 * 返回 null 表示已在端点、不需要改动（调用方据此跳过落盘）。
 */
export function moveWithin(ids: string[], id: string, dir: -1 | 1): string[] | null {
  const i = ids.indexOf(id);
  if (i === -1) return null;
  const j = i + dir;
  if (j < 0 || j >= ids.length) return null;
  const next = [...ids];
  const a = next[i];
  const b = next[j];
  if (a === undefined || b === undefined) return null;
  next[i] = b;
  next[j] = a;
  return next;
}

/**
 * 把「包内顺序」写回各条目的 order 字段（0,1,2…）。
 * 返回需要落盘的副本列表；order 没变的条目也会包含在内（幂等，便于调用方统一写）。
 */
export function applyOrder(entries: PromptPreset[], idsInOrder: string[]): PromptPreset[] {
  const pos = new Map(idsInOrder.map((id, i) => [id, i]));
  return entries.map((p) => {
    const i = pos.get(p.id);
    return i === undefined ? p : { ...p, order: i };
  });
}

/**
 * 旧数据迁移：给没有 group/order 的导入条目补上，使它们能被分区与排序。
 *
 * ⚠️ 如实说明能力边界：旧数据里**没有**记录酒馆的启用标记（导入时被丢掉了），
 *    所以迁移只能补 group/order，**不能**恢复「哪些条目当年是启用的」——
 *    这部分一律按未启用处理。要拿回真实的启用状态，需要重新导入一次原始预设文件
 *    （新导入器会读 prompt_order 的 enabled）。
 */
export function migrateLegacyEntries(
  presets: PromptPreset[],
  groupName: string
): { presets: PromptPreset[]; changed: number } {
  // 只迁移「导入来的」且缺字段的条目：id 前缀 imp- 是本仓库导入器的约定
  const legacy = presets.filter(
    (p) => p.id.startsWith("imp-") && (p.group === undefined || p.order === undefined)
  );
  if (legacy.length === 0) return { presets, changed: 0 };

  // 序：按 created_at 升序；同刻则按 id 兜底，保证多次运行结果一致（可重现）
  const ordered = [...legacy].sort((a, b) => {
    const d = a.created_at.localeCompare(b.created_at);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  const pos = new Map(ordered.map((p, i) => [p.id, i]));

  let changed = 0;
  const next = presets.map((p) => {
    const i = pos.get(p.id);
    if (i === undefined) return p;
    changed += 1;
    return {
      ...p,
      group: p.group ?? groupName,
      order: p.order ?? i,
      // 旧数据一律按未启用：不知道当年开了哪些，宁可全关也不误开
      // （「（默认组合）」那条 6.5 万字尤其不能误开）
      enabled: p.enabled ?? false,
    };
  });
  return { presets: next, changed };
}
