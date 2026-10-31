// lib/preset-roster.ts — 「全局条目名册」的纯函数层
//
// 背景（2026-09-25 改造）：原先预设是「一套生效」——角色卡绑一个 presetId。
// 导入一套酒馆预设会被压平成几十条互斥的候选，用户没法像酒馆那样「开 5 关 3」。
// 现在每条预设都可以作为名册里的一条**条目**参与拼装，开关是**全局**的、
// 与角色无关（角色只管自己的 system_prompt 与世界书）。
//
// 设计要点：
//   · 函数不落盘，单测可直接钉死行为。唯一的模块级状态是「当前名册索引」
//     的登记（见 registerRosterIndex）：生产入口只拿到 presets 数组、拿不到
//     索引，而包顺序（groupOrder）必须参与拼装才不会跨重启漂移。
//   · 「已启用」只认 `=== true`：旧数据（34 个已落盘 JSON）没有这个键，
//     真值判断会把它们全当成启用，一下把 6.5 万字的「默认组合」默认开上。
//   · order 缺失/重复时排序必须**稳定**：拼装顺序直接决定 DeepSeek 缓存前缀，
//     顺序一抖缓存就失效（界面上看不出来，只是变慢变贵）。
//   · 跨包顺序不能靠入参数组下标：每个导入包的 order 都从 0 开始，跨包必然
//     重复；入参数组在会话内是导入顺序、重启后是 listDir 顺序（文件名是随机
//     UUID）。故拼装先按 groupOrder/包名分组，再在组内按 order 排。

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
 * 组内稳定排序：先按 order 升序；order 相同用 id 兜底（不是入参下标）。
 *
 * 为什么不是入参下标：入参数组重启前后顺序不同（listDir 未排序），同 order
 * 的条目若按入参相对顺序排列，跨重启就会换位 —— 正好破坏缓存前缀。
 * id 是落盘的一部分，跨重启恒定；同一包内导入条目的 order 本就互不相同，
 * 这里只是给手工数据/旧数据一个确定性的兜底。
 */
function sortByOrderThenId(list: PromptPreset[]): PromptPreset[] {
  return [...list].sort((a, b) => {
    const d = orderOf(a) - orderOf(b);
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 跨组顺序：先按 groupOrder 声明序，未声明的包名按码点字典序；
 * UNGROUPED（内置/自定义）恒定最后 —— 与 UI 的分区顺序同口径。
 * 码点比较（而非 localeCompare）是为了跨机器/跨 locale 逐字一致。
 */
function orderedGroupKeys(keys: string[], declared: string[]): string[] {
  const rank = new Map<string, number>();
  declared.forEach((k, i) => {
    if (!rank.has(k)) rank.set(k, i);
  });
  return keys.sort((a, b) => {
    if (a === UNGROUPED || b === UNGROUPED) {
      return a === b ? 0 : a === UNGROUPED ? 1 : -1;
    }
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra !== undefined || rb !== undefined) {
      return (ra ?? declared.length) - (rb ?? declared.length);
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * 生产路径的「当前名册索引」。store 在载入/更新索引后登记它。
 *
 * 拼装入口（rp-prompt）只拿到 presets 数组、拿不到索引，而 groupOrder 是
 * 全局索引的一部分 —— 不登记它，UI 的包顺序就永远参与不了拼装。
 * assembleRoster 显式传入 index 时以参数为准，单测/纯调用不受此状态影响。
 */
let registeredIndex: PresetRosterIndex | null = null;

/** 登记全局名册索引（store 载入/移动包后调用；传 null 表示清空）。 */
export function registerRosterIndex(index: PresetRosterIndex | null): void {
  registeredIndex = index;
}

/**
 * 拼装名册：取出所有**已启用**条目，按「包 → 包内 order」拼接成最终提示词基座。
 * 全未启用时返回空串 —— 调用方据此回退到角色卡绑定的单套预设。
 *
 * 包顺序：groupOrder 声明序 → 未声明包按包名字典序 → UNGROUPED 最后。
 * 包内顺序：order 升序，同 order 按 id 兜底。两者都与入参数组顺序无关，
 * 所以重启后 listDir 乱序不会改变拼出的 system 前缀。
 *
 * @param index 显式索引；省略时用 registerRosterIndex 登记的全局索引。
 */
export function assembleRoster(presets: PromptPreset[], index?: PresetRosterIndex | null): string {
  const declared = (index === undefined ? registeredIndex : index)?.groupOrder ?? [];

  const buckets = new Map<string, PromptPreset[]>();
  for (const p of presets) {
    if (!isEntryEnabled(p)) continue;
    const g = groupOf(p);
    const arr = buckets.get(g);
    if (arr) arr.push(p);
    else buckets.set(g, [p]);
  }
  if (buckets.size === 0) return "";

  const out: string[] = [];
  for (const k of orderedGroupKeys([...buckets.keys()], declared)) {
    for (const p of sortByOrderThenId(buckets.get(k) ?? [])) {
      const t = p.template.trim();
      if (t.length > 0) out.push(t);
    }
  }
  return out.join("\n\n");
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
  const ordered = orderedGroupKeys([...buckets.keys()], declared);
  return ordered.map((k) => {
    const entries = sortByOrderThenId(buckets.get(k) ?? []);
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
