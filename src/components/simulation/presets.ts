// components/simulation/presets.ts — 从 SimulationView 抽出的常量与派生计算
//
// 抽出来的理由：类型预设卡与骰子选项是**配置**，会话过滤与按类型分组是**纯计算**；
// 它们混在 900 行的视图文件里时，既不好找，也没法单独测。

import type {
  SimPacing,
  SimStateMode,
  SimStateUpdate,
  SimType,
  SimulationConversation,
} from "@/types";

/** 类型预设卡:推荐状态/节奏/更新策略 + 说明文案 key */
export const TYPE_PRESETS: {
  type: SimType;
  stateMode: SimStateMode;
  pacing: SimPacing;
  stateUpdate: SimStateUpdate;
}[] = [
  { type: "story", stateMode: "text", pacing: "turn", stateUpdate: "every" },
  { type: "sandbox", stateMode: "text", pacing: "time", stateUpdate: "lazy" },
  { type: "tactical", stateMode: "table", pacing: "turn", stateUpdate: "every" },
];

export const DICE_OPTIONS = ["D100", "D20", "D12", "D10", "D8", "D6", "D4"];

/** 按搜索词过滤推演会话：匹配标题或世界观设定（大小写不敏感）；空查询返回副本 */
export function filterSimConversations(
  convs: readonly SimulationConversation[],
  query: string
): SimulationConversation[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...convs];
  return convs.filter(
    (c) => c.title.toLowerCase().includes(q) || c.setup.toLowerCase().includes(q)
  );
}

/** 按类型分组；三种类型恒存在，左栏可直接渲染空分组的标题 */
export function groupSimByType(
  convs: readonly SimulationConversation[]
): Record<SimType, SimulationConversation[]> {
  const map: Record<SimType, SimulationConversation[]> = { story: [], sandbox: [], tactical: [] };
  for (const c of convs) map[c.type].push(c);
  return map;
}
