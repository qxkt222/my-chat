// components/simulation/NewSimulationModal.tsx — 新建推演弹层（从 SimulationView 搬出）
//
// 纯粹是搬家：行为一字未改，只是让视图文件别再背着这 195 行。

import { useState } from "react";
import { FlaskConical, X } from "lucide-react";
import { useSimulationStore, type CreateSimOptions } from "@/stores/useSimulationStore";
import { useT } from "@/lib/i18n";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import type { SimPacing, SimStateMode, SimStateUpdate } from "@/types";
import { TYPE_PRESETS } from "./presets";

/** 新建推演弹层:类型预设卡 + 高级选项(形态/状态/节奏/更新策略) */
export function NewSimulationModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const sim = useSimulationStore();
  // Escape 关闭(此前只有遮罩点击 + 底部取消)
  useEscapeClose(onClose);
  const [draft, setDraft] = useState<CreateSimOptions>({
    type: "story",
    stateMode: "text",
    pacing: "turn",
    stateUpdate: "every",
    autoRounds: 3,
    setup: "",
  });
  const [advanced, setAdvanced] = useState(false);
  const [setupDraft, setSetupDraft] = useState("");

  const pickType = (p: (typeof TYPE_PRESETS)[number]) => {
    // 点卡片重置高级选项为该卡推荐
    setDraft((d) => ({
      ...d,
      type: p.type,
      stateMode: p.stateMode,
      pacing: p.pacing,
      stateUpdate: p.stateUpdate,
    }));
  };

  const create = async () => {
    await sim.create({ ...draft, setup: setupDraft.trim() });
    onClose();
  };

  const typeCard = (p: (typeof TYPE_PRESETS)[number]) => {
    const on = draft.type === p.type;
    return (
      <button
        key={p.type}
        onClick={() => pickType(p)}
        className={`text-left p-3 rounded-lg border transition-colors ${
          on ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
        }`}
      >
        <div className="flex items-center gap-1.5 mb-1">
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
              p.type === "story"
                ? "bg-primary/10 text-primary"
                : p.type === "sandbox"
                  ? "bg-emerald-500/10 text-emerald-500"
                  : "bg-amber-500/10 text-amber-500"
            }`}
          >
            {t(`sim.type.${p.type}`)}
          </span>
          {on && <span className="text-[10px] text-primary font-medium">✓</span>}
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {t(`sim.typeDesc.${p.type}`)}
        </p>
      </button>
    );
  };

  const sel = (
    label: string,
    value: string,
    options: { v: string; label: string }[],
    onChange: (v: string) => void
  ) => (
    <label className="flex items-center gap-2 text-[11px]">
      <span className="text-muted-foreground w-20 shrink-0">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[92vw] bg-card border border-border rounded-lg shadow-xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 mb-3">
          <FlaskConical className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">{t("sim.new")}</span>
          <span className="text-[10px] text-muted-foreground">{t("sim.newHint")}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1 rounded hover:bg-muted text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 类型预设卡 */}
        <div className="grid grid-cols-3 gap-2 mb-3">{TYPE_PRESETS.map(typeCard)}</div>

        {/* 世界观设定 */}
        <div className="mb-2">
          <label className="text-[10px] text-muted-foreground block mb-0.5">
            {t("sim.setupLabel")}
          </label>
          <textarea
            value={setupDraft}
            onChange={(e) => setSetupDraft(e.target.value)}
            rows={3}
            placeholder={t("sim.setupPlaceholder")}
            className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
          />
        </div>

        {/* 高级选项 */}
        <button
          onClick={() => setAdvanced(!advanced)}
          className="text-[11px] text-primary hover:underline flex items-center gap-1"
        >
          {advanced ? "▾" : "▸"} {t("sim.advanced")}
        </button>
        {advanced && (
          <div className="mt-2 space-y-1.5 p-2 rounded border border-border bg-muted/30">
            {sel(
              t("sim.stateModeLabel"),
              draft.stateMode,
              [
                { v: "text", label: t("sim.stateMode.text") },
                { v: "table", label: t("sim.stateMode.table") },
                { v: "none", label: t("sim.stateMode.none") },
              ],
              (v) => setDraft((d) => ({ ...d, stateMode: v as SimStateMode }))
            )}
            {sel(
              t("sim.pacingLabel"),
              draft.pacing,
              [
                { v: "turn", label: t("sim.pacing.turn") },
                { v: "time", label: t("sim.pacing.time") },
                { v: "auto", label: t("sim.pacing.auto") },
              ],
              (v) => setDraft((d) => ({ ...d, pacing: v as SimPacing }))
            )}
            {sel(
              t("sim.stateUpdateLabel"),
              draft.stateUpdate,
              [
                { v: "every", label: t("sim.stateUpdate.every") },
                { v: "lazy", label: t("sim.stateUpdate.lazy") },
                { v: "inline", label: t("sim.stateUpdate.inline") },
              ],
              (v) => setDraft((d) => ({ ...d, stateUpdate: v as SimStateUpdate }))
            )}
            <label className="flex items-center gap-2 text-[11px]">
              <span className="text-muted-foreground w-20 shrink-0">{t("sim.autoRounds")}</span>
              <input
                type="number"
                min={1}
                max={10}
                value={draft.autoRounds}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, autoRounds: Math.max(1, +e.target.value || 1) }))
                }
                className="w-16 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
              />
            </label>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-3">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-input text-muted-foreground hover:text-foreground"
          >
            {t("settings.cancel")}
          </button>
          <button
            onClick={create}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {t("sim.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
