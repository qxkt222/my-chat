// lib/memory-graph.ts — 记忆图谱数据层(33)
//
// 从酒馆/推演会话的消息 + 世界书 + 摘要中提取关系图:
// 节点 = 人物 / 地点 / 话题;边 = 关系词(宿主/敌对/盟友/…)。
// 数据层与渲染器解耦:同一份 RelationGraph 数据,B 档树形连线图 与
// C 档力导向图(未来升级)只换渲染器,不改数据。

export type GraphNodeKind = "person" | "place" | "topic";

export interface GraphNode {
  id: string;
  label: string;
  kind: GraphNodeKind;
  /** 首次出现的消息 id(点击跳转) */
  refMsgId?: string | undefined;
  /** 提及次数(重要性) */
  weight: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** 关系词(如 "宿敌" "盟友") */
  relation: string;
}

export interface RelationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// 中英常见人名/地名/话题指示词(用于抽取;本地轻量,不接 NER 服务)
const NAME_PATTERNS = [
  // 引号/书名号内的人名(角色对话中常见)
  /[「『""]([^「」""']{2,12})[」』""]/g,
];

/** 常见关系词(中文为主,匹配 "X 是 Y 的 关系" 模式) */
const RELATION_WORDS = [
  "宿敌",
  "盟友",
  "敌人",
  "好友",
  "爱人",
  "恋人",
  "仇人",
  "上司",
  "下属",
  "老师",
  "学生",
  "父亲",
  "母亲",
  "兄弟",
  "姐妹",
  "徒弟",
  "对手",
  "同伴",
];

/** 从会话消息 + 世界书提取关系图(轻量启发式:名字提及计数 + 关系句模式) */
export function extractGraph(
  messages: { id: string; role: string; content: string }[],
  loreText: string,
  maxNodes = 30
): RelationGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const nodeOf = (label: string, kind: GraphNodeKind, refMsgId?: string): string => {
    const key = `${kind}:${label}`;
    const existing = nodes.get(key);
    if (existing) {
      existing.weight += 1;
      if (!existing.refMsgId && refMsgId) existing.refMsgId = refMsgId;
      return key;
    }
    const node: GraphNode = { id: key, label, kind, refMsgId, weight: 1 };
    nodes.set(key, node);
    return key;
  };

  // 1) 扫描消息:找引号内名字 + 关系句
  for (const m of messages) {
    const text = m.content;
    // 名字:引号内片段(启发式,可后续换 NER)
    for (const re of NAME_PATTERNS) {
      const ms = text.matchAll(re);
      for (const hit of ms) {
        const name = (hit[1] ?? "").trim();
        if (name.length < 2 || name.length > 10) continue;
        if (name.includes("的") || name.includes("是") || name.includes("我")) continue;
        nodeOf(name, "person", m.id);
      }
    }
    // 关系句: "A 是 B 的 X" / "A 与 B 是 X"
    for (const rel of RELATION_WORDS) {
      const re = new RegExp(
        `[「『""]?([\\u4e00-\\u9fffA-Za-z]{2,8})[」』""]?(?:是|与|和|跟)(?:[「『""]?)([\\u4e00-\\u9fffA-Za-z]{2,8})(?:[」』""])?(?:的|是)?${rel}`,
        "g"
      );
      const ms = text.matchAll(re);
      for (const hit of ms) {
        const a = (hit[1] ?? "").trim();
        const b = (hit[2] ?? "").trim();
        if (a === b || a.includes("我") || b.includes("我")) continue;
        const idA = nodeOf(a, "person", m.id);
        const idB = nodeOf(b, "person", m.id);
        const ekey = [idA, idB].sort().join("|");
        if (!edges.has(ekey)) {
          edges.set(ekey, { from: idA, to: idB, relation: rel });
        }
      }
    }
  }

  // 2) 世界书/设定文本:提地名/话题关键词(粗提取:出现 ≥2 次的 2-4 字词)
  if (loreText) {
    const counts = new Map<string, number>();
    const cjk = loreText.match(/[\u4e00-\u9fff]{2,4}/g) || [];
    for (const w of cjk) {
      if (w.includes("的") || w.includes("是") || w.includes("和")) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
    for (const [w, c] of counts) {
      if (c >= 2 && nodes.size < maxNodes) {
        nodeOf(w, "place");
      }
    }
  }

  // 截断到 maxNodes
  const sorted = [...nodes.values()].sort((a, b) => b.weight - a.weight);
  const keep = new Set(sorted.slice(0, maxNodes).map((n) => n.id));
  const finalNodes = [...nodes.values()].filter((n) => keep.has(n.id));
  const finalEdges = [...edges.values()].filter((e) => keep.has(e.from) && keep.has(e.to));

  return { nodes: finalNodes, edges: finalEdges };
}
