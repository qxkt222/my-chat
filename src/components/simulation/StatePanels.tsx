// components/simulation/StatePanels.tsx — 世界状态 + 事件时间线面板（从 SimulationView 搬出）
//
// 草稿默认只在挂载时初始化,还必须跟随外部自动同步:
// useSimulationStore.afterTurn → updateStateAndTimeline 会在推演后改写
// conv.worldState / conv.stateTable;若面板只认挂载时的值,「保存」会把旧文本
// 写回并覆盖自动同步的结果(T-023 / FE-UR)。
// 规则:
//   - 未聚焦且草稿未 dirty:外部变化直接同步进草稿;
//   - 聚焦中或草稿 dirty(用户改过未保存):不覆盖,只记下待同步值,
//     失焦且 dirty 已清时再应用;此时标题旁显示一个提示点;
//   - 切换 convId:草稿整体重置为新会话的值,避免串会话。

import { useEffect, useRef, useState, type FocusEvent } from "react";
import { BookOpen, Save, ScrollText, X } from "lucide-react";
import { useSimulationStore } from "@/stores/useSimulationStore";
import { useT } from "@/lib/i18n";
import type { SimulationConversation } from "@/types";

/** stateTable 内容相等（patch 会换对象引用，不能直接比引用） */
function sameTable(a: Record<string, string>, b: Record<string, string>) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

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
  // 草稿本地态:从会话初始化(编辑后点保存才落盘)
  const [wsDraft, setWsDraft] = useState(conv.worldState);
  const [tableDraft, setTableDraft] = useState<[string, string][]>(() =>
    Object.entries(conv.stateTable)
  );
  // 用户改过但未保存
  const [wsDirty, setWsDirty] = useState(false);
  const [tableDirty, setTableDirty] = useState(false);
  // 被拦下的外部更新(用于显示提示点)
  const [hasPending, setHasPending] = useState(false);

  // 已处理过的外部值快照:只有真正的外部变化才动草稿
  const convIdRef = useRef(conv.id);
  const seenWsRef = useRef(conv.worldState);
  const seenTableRef = useRef(conv.stateTable);
  // 聚焦中的状态面板不接收外部覆盖(保留光标/选区)
  const stateFocusedRef = useRef(false);
  // 聚焦/ dirty 期间到达的外部值,等失焦后再应用
  const pendingWsRef = useRef<string | null>(null);
  const pendingTableRef = useRef<Record<string, string> | null>(null);
  // 时间线手动新增
  const [tlTime, setTlTime] = useState("");
  const [tlEvent, setTlEvent] = useState("");

  useEffect(() => {
    // 切会话:草稿整体重置为新会话内容(优先于聚焦/dirty 保护)
    if (convIdRef.current !== conv.id) {
      convIdRef.current = conv.id;
      seenWsRef.current = conv.worldState;
      seenTableRef.current = conv.stateTable;
      pendingWsRef.current = null;
      pendingTableRef.current = null;
      setWsDraft(conv.worldState);
      setTableDraft(Object.entries(conv.stateTable));
      setWsDirty(false);
      setTableDirty(false);
      setHasPending(false);
      return;
    }

    const wsChanged = conv.worldState !== seenWsRef.current;
    const tableChanged = !sameTable(conv.stateTable, seenTableRef.current);
    if (!wsChanged && !tableChanged) return;

    const blocked = stateFocusedRef.current;
    if (wsChanged) {
      seenWsRef.current = conv.worldState;
      if (blocked || wsDirty) {
        pendingWsRef.current = conv.worldState;
      } else {
        pendingWsRef.current = null;
        setWsDraft(conv.worldState);
      }
    }
    if (tableChanged) {
      seenTableRef.current = conv.stateTable;
      if (blocked || tableDirty) {
        pendingTableRef.current = conv.stateTable;
      } else {
        pendingTableRef.current = null;
        setTableDraft(Object.entries(conv.stateTable));
      }
    }
    setHasPending(pendingWsRef.current !== null || pendingTableRef.current !== null);
    // wsDraft/tableDraft 不进依赖:只有外部值与 dirty 变化需要重新比对
  }, [conv.id, conv.worldState, conv.stateTable, wsDirty, tableDirty]);

  /** 失焦后:没有未保存编辑的草稿才接收被拦下的外部更新 */
  const applyPendingIfClean = () => {
    let applied = false;
    if (pendingWsRef.current !== null && !wsDirty) {
      setWsDraft(pendingWsRef.current);
      pendingWsRef.current = null;
      applied = true;
    }
    if (pendingTableRef.current !== null && !tableDirty) {
      setTableDraft(Object.entries(pendingTableRef.current));
      pendingTableRef.current = null;
      applied = true;
    }
    if (applied) setHasPending(pendingWsRef.current !== null || pendingTableRef.current !== null);
  };

  const onStateFocus = () => {
    stateFocusedRef.current = true;
  };

  const onStateBlur = (e: FocusEvent<HTMLDivElement>) => {
    // 面板内换焦点(key ↔ value)不算离开
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return;
    stateFocusedRef.current = false;
    applyPendingIfClean();
  };

  const saveWorldState = async () => {
    await sim.patch(conv.id, { worldState: wsDraft.trim() });
    setWsDirty(false);
    pendingWsRef.current = null;
    setHasPending(pendingTableRef.current !== null);
  };

  const saveTable = async () => {
    const table: Record<string, string> = {};
    for (const [k, v] of tableDraft) {
      if (k.trim() && v.trim()) table[k.trim()] = v.trim();
    }
    await sim.patch(conv.id, { stateTable: table });
    setTableDirty(false);
    pendingTableRef.current = null;
    setHasPending(pendingWsRef.current !== null);
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
          <div onFocus={onStateFocus} onBlur={onStateBlur}>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
              <BookOpen className="w-3 h-3 text-primary" />
              {t("sim.statePanel")}
              <span className="text-[9px] opacity-70">{t(`sim.stateMode.${conv.stateMode}`)}</span>
              {hasPending && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
                  title={t("sim.sync")}
                />
              )}
            </div>
            {conv.stateMode === "text" && (
              <>
                <textarea
                  value={wsDraft}
                  onChange={(e) => {
                    setWsDraft(e.target.value);
                    setWsDirty(true);
                  }}
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
                        onChange={(e) => {
                          setTableDraft((p) =>
                            p.map((r, j) => (j === i ? [e.target.value, r[1]] : r))
                          );
                          setTableDirty(true);
                        }}
                        placeholder={t("sim.tableKey")}
                        className="w-1/3 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
                      />
                      <input
                        value={v}
                        onChange={(e) => {
                          setTableDraft((p) =>
                            p.map((r, j) => (j === i ? [r[0], e.target.value] : r))
                          );
                          setTableDirty(true);
                        }}
                        placeholder={t("sim.tableValue")}
                        className="flex-1 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
                      />
                      <button
                        onClick={() => {
                          setTableDraft((p) => p.filter((_, j) => j !== i));
                          setTableDirty(true);
                        }}
                        className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-1 mt-1">
                  <button
                    onClick={() => {
                      setTableDraft((p) => [...p, ["", ""]]);
                      setTableDirty(true);
                    }}
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
