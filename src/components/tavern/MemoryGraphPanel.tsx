import { useMemo } from "react";
import { useT } from "@/lib/i18n";
import type { GraphNode, RelationGraph } from "@/lib/memory-graph";

/**
 * 记忆图谱 B 档:树形连线图(33)——手写 SVG 分层连线,零美术资源/零新依赖。
 * 人物/地点/话题三类节点分三层,父子用线连接(带关系词标注),点击节点跳转对应消息。
 * 数据层(RelationGraph)与渲染器解耦:C 档力导向图升级只换此渲染器,不改数据。
 */

const KIND_COLOR: Record<GraphNode["kind"], string> = {
  person: "#1A6FB5",
  place: "#10B981",
  topic: "#F59E0B",
};

const KIND_LABEL: Record<GraphNode["kind"], string> = {
  person: "人物",
  place: "地点",
  topic: "话题",
};

/** 把关系图布局为树形坐标(按 kind 分三层,每层横向排布) */
function layout(g: RelationGraph): { node: GraphNode; x: number; y: number }[] {
  const persons = g.nodes.filter((n) => n.kind === "person");
  const places = g.nodes.filter((n) => n.kind === "place");
  const topics = g.nodes.filter((n) => n.kind === "topic");
  const rows: GraphNode[][] = [persons, places, topics];
  const out: { node: GraphNode; x: number; y: number }[] = [];
  const W = 520;
  const ROW_H = 96;
  const rowY = [20, ROW_H + 40, ROW_H * 2 + 60];
  rows.forEach((row, ri) => {
    row.forEach((n, ci) => {
      const x = row.length === 1 ? W / 2 : 30 + (ci * (W - 60)) / Math.max(1, row.length - 1);
      const y = rowY[ri];
      if (y != null) out.push({ node: n, x, y });
    });
  });
  return out;
}

export function MemoryGraphPanel({
  graph,
  onJump,
}: {
  graph: RelationGraph;
  onJump?: (msgId: string) => void;
}) {
  const t = useT();
  const laid = useMemo(() => layout(graph), [graph]);
  const pos = new Map(laid.map((l) => [l.node.id, l]));

  return (
    <div className="rounded-md border border-border bg-card p-2 overflow-auto">
      <div className="flex items-center gap-1.5 mb-1 text-[10px] text-muted-foreground">
        <span className="text-primary font-medium">{t("graph.title")}</span>
        <span>
          {graph.nodes.length} 节点 / {graph.edges.length} 关系
        </span>
        <span className="ml-auto flex gap-2">
          {(Object.keys(KIND_COLOR) as GraphNode["kind"][]).map((k) => (
            <span key={k} className="flex items-center gap-0.5">
              <span className="w-2 h-2 rounded-full" style={{ background: KIND_COLOR[k] }} />
              {KIND_LABEL[k]}
            </span>
          ))}
        </span>
      </div>
      <svg viewBox="0 0 580 300" className="w-full h-56">
        {/* 连线(父→子,带关系词) */}
        {graph.edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <g key={i}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#8899A6"
                strokeWidth="0.8"
                strokeDasharray="3 3"
              />
              <text x={mx} y={my - 4} textAnchor="middle" fontSize="8" fill="#8899A6">
                {e.relation}
              </text>
            </g>
          );
        })}
        {/* 节点 */}
        {laid.map(({ node, x, y }) => (
          <g
            key={node.id}
            onClick={() => node.refMsgId && onJump?.(node.refMsgId)}
            style={{ cursor: node.refMsgId ? "pointer" : "default" }}
          >
            <circle cx={x} cy={y} r={14} fill={KIND_COLOR[node.kind]} opacity={0.9} />
            <text x={x} y={y + 3} textAnchor="middle" fontSize="9" fill="#fff" fontWeight="600">
              {node.label.slice(0, 4)}
            </text>
            <text x={x} y={y + 26} textAnchor="middle" fontSize="8" fill="#8899A6">
              {node.weight}
            </text>
          </g>
        ))}
      </svg>
      {graph.nodes.length === 0 && (
        <p className="text-[10px] text-muted-foreground text-center py-4">{t("graph.empty")}</p>
      )}
    </div>
  );
}
