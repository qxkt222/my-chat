// components/simulation/StatePanels.tsx — 世界状态 + 事件时间线面板（从 SimulationView 搬出）
//
// 纯粹是搬家：行为一字未改。

import { useState } from "react";
import { BookOpen, Save, ScrollText, X } from "lucide-react";
import { useSimulationStore } from "@/stores/useSimulationStore";
import { useT } from "@/lib/i18n";
import type { SimulationConversation } from "@/types";

/** 世界状态 + 事件时间线面板(key=会话 id 重挂载,草稿跟随激活会话) */
export function StatePanels({
  conv,
  showState,
  showTimeline,
}: {
  conv: SimulationConversation;
  showState: boolean;
  showTimeline: boolean;
}) {
  const t = useT();
  const sim = useSimulationStore();
  // 草稿本地态:挂载时从会话初始化(编辑后点保存才落盘)
  const [wsDraft, setWsDraft] = useState(conv.worldState);
  const [tableDraft, setTableDraft] = useState<[string, string][]>(Object.entries(conv.stateTable));
  // 时间线手动新增
  const [tlTime, setTlTime] = useState("");
  const [tlEvent, setTlEvent] = useState("");

  const saveWorldState = async () => {
    await sim.patch(conv.id, { worldState: wsDraft.trim() });
  };

  const saveTable = async () => {
    const table: Record<string, string> = {};
    for (const [k, v] of tableDraft) {
      if (k.trim() && v.trim()) table[k.trim()] = v.trim();
    }
    await sim.patch(conv.id, { stateTable: table });
  };

  const addTimeline = () => {
    void sim.addTimelineEntry(conv.id, tlTime, tlEvent);
    setTlTime("");
    setTlEvent("");
  };

  return (
    <div className="border-b border-border bg-card/60 px-4 py-2 shrink-0 max-h-[40%] overflow-y-auto">
      <div className="max-w-3xl mx-auto grid grid-cols-2 gap-3">
        {/* 世界状态 */}
        {showState && (
          <div>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
              <BookOpen className="w-3 h-3 text-primary" />
              {t("sim.statePanel")}
              <span className="text-[9px] opacity-70">{t(`sim.stateMode.${conv.stateMode}`)}</span>
            </div>
            {conv.stateMode === "text" && (
              <>
                <textarea
                  value={wsDraft}
                  onChange={(e) => setWsDraft(e.target.value)}
                  rows={4}
                  placeholder={t("sim.worldStatePlaceholder")}
                  className="w-full px-2 py-1.5 text-[11px] bg-background border border-input rounded resize-none"
                />
                <button
                  onClick={saveWorldState}
                  className="mt-1 px-2 py-1 text-[10px] rounded bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-1"
                >
                  <Save className="w-3 h-3" /> {t("sim.saveState")}
                </button>
              </>
            )}
            {conv.stateMode === "table" && (
              <>
                <div className="space-y-1">
                  {tableDraft.map(([k, v], i) => (
                    <div key={i} className="flex gap-1">
                      <input
                        value={k}
                        onChange={(e) =>
                          setTableDraft((p) =>
                            p.map((r, j) => (j === i ? [e.target.value, r[1]] : r))
                          )
                        }
                        placeholder={t("sim.tableKey")}
                        className="w-1/3 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
                      />
                      <input
                        value={v}
                        onChange={(e) =>
                          setTableDraft((p) =>
                            p.map((r, j) => (j === i ? [r[0], e.target.value] : r))
                          )
                        }
                        placeholder={t("sim.tableValue")}
                        className="flex-1 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
                      />
                      <button
                        onClick={() => setTableDraft((p) => p.filter((_, j) => j !== i))}
                        className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-1 mt-1">
                  <button
                    onClick={() => setTableDraft((p) => [...p, ["", ""]])}
                    className="px-2 py-1 text-[10px] rounded border border-dashed border-primary/40 text-primary hover:bg-primary/5"
                  >
                    + {t("sim.tableAdd")}
                  </button>
                  <button
                    onClick={saveTable}
                    className="px-2 py-1 text-[10px] rounded bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-1"
                  >
                    <Save className="w-3 h-3" /> {t("sim.saveState")}
                  </button>
                </div>
              </>
            )}
            {conv.stateMode === "none" && (
              <p className="text-[11px] text-muted-foreground">{t("sim.stateNone")}</p>
            )}
          </div>
        )}

        {/* 事件时间线 */}
        {showTimeline && (
          <div>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
              <ScrollText className="w-3 h-3 text-primary" />
              {t("sim.timelinePanel")}
            </div>
            <div className="space-y-1 max-h-36 overflow-y-auto">
              {conv.timeline.length === 0 && (
                <p className="text-[11px] text-muted-foreground">{t("sim.timelineEmpty")}</p>
              )}
              {[...conv.timeline].reverse().map((e, ri) => {
                const idx = conv.timeline.length - 1 - ri;
                return (
                  <div key={idx} className="flex items-start gap-1.5 text-[11px] group">
                    {/* 时间线分层(38):milestone 高亮/ log 弱化 / event 常规 */}
                    <span
                      className={`shrink-0 font-mono ${
                        e.kind === "milestone"
                          ? "text-amber-500"
                          : e.kind === "log"
                            ? "text-muted-foreground/50"
                            : "text-muted-foreground"
                      }`}
                    >
                      {e.kind === "milestone" ? "★" : e.kind === "log" ? "·" : ""}
                      {e.time || "—"}
                    </span>
                    <span
                      className={`flex-1 ${
                        e.kind === "log" ? "text-muted-foreground/60" : "text-foreground/90"
                      }`}
                    >
                      {e.event}
                    </span>
                    <button
                      onClick={() => sim.removeTimelineEntry(conv.id, idx)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-1 mt-1">
              <input
                value={tlTime}
                onChange={(e) => setTlTime(e.target.value)}
                placeholder={t("sim.timelineTime")}
                className="w-1/4 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
              />
              <input
                value={tlEvent}
                onChange={(e) => setTlEvent(e.target.value)}
                placeholder={t("sim.timelineEvent")}
                className="flex-1 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
                onKeyDown={(e) => {
                  if (e.key === "Enter") addTimeline();
                }}
              />
              <button
                onClick={addTimeline}
                className="px-2 py-1 text-[10px] rounded border border-dashed border-primary/40 text-primary hover:bg-primary/5"
              >
                +
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
