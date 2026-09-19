import { useState } from "react";
import { SlidersHorizontal, Save, Trash2, Check } from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useT } from "@/lib/i18n";
import { showToast } from "@/components/ui/Toast";
import type { ModelParameters } from "@/types";

/** 采样器字段定义:label / 区间 / 步长 */
const SLIDERS: {
  key: keyof ModelParameters;
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: "temperature", label: "Temperature", min: 0, max: 2, step: 0.05 },
  { key: "top_p", label: "Top P", min: 0, max: 1, step: 0.01 },
  { key: "top_k", label: "Top K", min: 0, max: 200, step: 1 },
  { key: "repetition_penalty", label: "Repetition Penalty", min: 0, max: 2, step: 0.01 },
  { key: "frequency_penalty", label: "Frequency Penalty", min: 0, max: 2, step: 0.01 },
  { key: "presence_penalty", label: "Presence Penalty", min: 0, max: 2, step: 0.01 },
  { key: "min_p", label: "Min P", min: 0, max: 1, step: 0.01 },
];

/** DRY / Mirostat (llama.cpp 本地端点) */
const DRY_MIROSTAT_SLIDERS: {
  key: keyof ModelParameters;
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: "mirostat_tau", label: "Mirostat Tau", min: 0, max: 10, step: 0.1 },
  { key: "mirostat_eta", label: "Mirostat Eta", min: 0, max: 1, step: 0.01 },
  { key: "dry_multiplier", label: "DRY Multiplier", min: 0, max: 2, step: 0.01 },
  { key: "dry_base", label: "DRY Base", min: 0, max: 5, step: 0.01 },
  { key: "dry_allowed_length", label: "DRY Allowed Length", min: 1, max: 20, step: 1 },
  { key: "dry_penalty_last_n", label: "DRY Penalty Last N", min: -1, max: 4096, step: 1 },
];

/** API 响应配置(酒馆 Sliders):采样器滑杆 + 预设存档 + 应用到模型 */
export function SamplerManager() {
  const t = useT();
  const s = useSettingsStore();
  const activeModel = s.models.find((m) => m.name === s.activeModel);
  const [params, setParams] = useState<ModelParameters>({
    ...(activeModel?.parameters || s.defaultParameters),
  });
  const [presetName, setPresetName] = useState("");

  const set = (key: keyof ModelParameters, v: number) => setParams((p) => ({ ...p, [key]: v }));
  const reset = (key: keyof ModelParameters) =>
    setParams((p) => {
      const n = { ...p };
      delete n[key];
      return n;
    });

  const applyToActive = () => {
    if (!s.activeModel) {
      showToast("error", t("sampler.noModel"));
      return;
    }
    void s.applySamplerToActive(params);
    showToast("success", t("sampler.applied", { name: s.activeModel }));
  };

  const savePreset = () => {
    if (!presetName.trim()) return;
    void s.saveSamplerPreset({
      id: `user-${crypto.randomUUID()}`,
      name: presetName.trim(),
      ...params,
    });
    setPresetName("");
    showToast("success", t("sampler.presetSaved"));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <SlidersHorizontal className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">{t("sampler.title")}</span>
        <span className="text-[10px] text-muted-foreground">{t("sampler.subtitle")}</span>
      </div>

      {/* 当前模型提示 */}
      <p className="text-[11px] text-muted-foreground">
        {t("sampler.activeFor")}:{" "}
        <span className="text-primary font-medium">{s.activeModel || t("no.model")}</span>
        {!s.activeModel && ` — ${t("sampler.noModel")}`}
      </p>
      <p className="text-[10px] text-muted-foreground">{t("sampler.extendedHint")}</p>

      {/* 滑杆面板 */}
      <div className="space-y-2">
        {SLIDERS.map(({ key, label, min, max, step }) => (
          <div key={key} className="flex items-center gap-2 text-xs">
            <span className="w-40 text-muted-foreground shrink-0">{label}</span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={params[key] ?? min}
              onChange={(e) => set(key, +e.target.value)}
              className="flex-1"
            />
            <span className="w-14 text-right">{params[key] ?? min}</span>
            <button
              onClick={() => reset(key)}
              className="p-0.5 rounded hover:bg-muted text-muted-foreground"
              title={t("sampler.reset")}
            >
              <span className="text-[10px]">↺</span>
            </button>
          </div>
        ))}
      </div>

      {/* Mirostat 模式(0=关 1/2=开) */}
      <div className="flex items-center gap-2 text-xs">
        <span className="w-40 text-muted-foreground shrink-0">Mirostat Mode</span>
        <select
          value={params.mirostat ?? 0}
          onChange={(e) => set("mirostat", +e.target.value)}
          className="px-2 py-1 text-xs bg-background border border-input rounded"
        >
          <option value={0}>0 - 关闭</option>
          <option value={1}>1 - Mirostat</option>
          <option value={2}>2 - Mirostat 2.0</option>
        </select>
        <button
          onClick={() => reset("mirostat")}
          className="p-0.5 rounded hover:bg-muted text-muted-foreground"
          title={t("sampler.reset")}
        >
          <span className="text-[10px]">↺</span>
        </button>
      </div>

      {/* DRY / Mirostat 参数(仅 llama.cpp 本地端点) */}
      <div className="space-y-2 border-t border-border pt-2">
        <div className="text-[10px] text-[#8899A6] uppercase tracking-[0.6px]">
          {t("sampler.local")}
        </div>
        {DRY_MIROSTAT_SLIDERS.map(({ key, label, min, max, step }) => (
          <div key={key} className="flex items-center gap-2 text-xs">
            <span className="w-40 text-muted-foreground shrink-0">{label}</span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={params[key] ?? min}
              onChange={(e) => set(key, +e.target.value)}
              className="flex-1"
            />
            <span className="w-14 text-right">{params[key] ?? min}</span>
            <button
              onClick={() => reset(key)}
              className="p-0.5 rounded hover:bg-muted text-muted-foreground"
              title={t("sampler.reset")}
            >
              <span className="text-[10px]">↺</span>
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
          placeholder={t("sampler.presetName")}
          className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
        />
        <button
          onClick={savePreset}
          disabled={!presetName.trim()}
          className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 flex items-center gap-1"
        >
          <Save className="w-3 h-3" /> {t("sampler.savePreset")}
        </button>
        <button
          onClick={applyToActive}
          className="px-3 py-1.5 text-xs rounded border border-primary text-primary hover:bg-primary/10 flex items-center gap-1"
        >
          <Check className="w-3 h-3" /> {t("sampler.applyModel")}
        </button>
      </div>

      {/* 预设列表 */}
      <div className="space-y-1">
        <div className="text-[10px] text-[#8899A6] uppercase tracking-[0.6px]">
          {t("sampler.presets")}
        </div>
        {s.samplerPresets.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-2 px-2 py-1.5 rounded border border-border bg-card text-xs"
          >
            <div className="flex-1 min-w-0">
              <span className="font-medium">{p.name}</span>
              <span className="text-[10px] text-muted-foreground ml-2 truncate">
                T={p.temperature ?? "–"} topP={p.top_p ?? "–"} topK={p.top_k ?? "–"} rep=
                {p.repetition_penalty ?? "–"} minP={p.min_p ?? "–"}
              </span>
            </div>
            <button
              onClick={() => {
                setParams({ ...p });
                showToast("info", t("sampler.loaded", { name: p.name }));
              }}
              className="px-2 py-0.5 rounded border border-input hover:bg-muted"
            >
              {t("sampler.load")}
            </button>
            {!p.id.startsWith("sampler-") && (
              <button
                onClick={() => s.removeSamplerPreset(p.id)}
                className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
