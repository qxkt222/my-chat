import { useState } from "react";
import { X, ChevronRight, ChevronLeft, ArrowRight, Settings2 } from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useT } from "@/lib/i18n";
import { BUILTIN_PRESETS } from "@/adapters/registry";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import type { ApiTemplate } from "@/types";

export function ModelWizard({ onDone }: { onDone: () => void }) {
  const t = useT();
  const s = useSettingsStore();
  // Escape 关闭(此前只有右上角 X)
  useEscapeClose(onDone);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [preset, setPreset] = useState<ApiTemplate | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  // Custom provider fields (step 3)
  const [customUrl, setCustomUrl] = useState("");
  const [customName, setCustomName] = useState("");
  const [customModel, setCustomModel] = useState("");

  const pick = (p: ApiTemplate) => {
    setPreset(p);
    setName(p.name);
    setModel("");
    setStep(2);
  };

  const save = async (requireKey: boolean) => {
    if (!preset) return;
    if (requireKey && !apiKey.trim()) return;
    s.addModel({
      name: name || preset.name,
      provider: preset.id,
      api_url: preset.api_url,
      api_key: apiKey,
      model: model || "",
    });
    s.setActiveModel(name || preset.name);
    await s.save();
    onDone();
  };

  const saveCustom = async () => {
    if (!customUrl.trim() || !customName.trim()) return;
    s.addModel({
      name: customName.trim(),
      provider: "custom",
      api_url: customUrl.trim(),
      api_key: apiKey,
      model: customModel.trim() || "model",
    });
    s.setActiveModel(customName.trim());
    await s.save();
    onDone();
  };

  const stepTitle =
    step === 1 ? t("wizard.title1") : step === 2 ? t("wizard.title2") : t("wizard.title3");

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center"
      onClick={onDone}
    >
      <div
        className="bg-card border border-border rounded-lg w-[550px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          {step !== 1 && (
            <button onClick={() => setStep(1)} className="p-1 rounded hover:bg-muted">
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
          <h3 className="text-sm font-semibold">{stepTitle}</h3>
          <div className="flex-1" />
          <span className="text-xs text-muted-foreground">{t("wizard.stepOf", { n: step })}</span>
          <button onClick={onDone} className="p-1 rounded hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        {step === 1 && (
          <div className="p-4">
            {/* Custom provider entry */}
            <button
              onClick={() => {
                setPreset({ id: "custom" } as ApiTemplate);
                setStep(3);
              }}
              className="w-full mb-3 flex items-center gap-3 p-3 border-2 border-dashed border-primary/40 rounded-lg hover:border-primary hover:bg-primary/5 transition-colors text-left"
            >
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                <Settings2 className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-primary">{t("wizard.custom")}</div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {t("wizard.customDesc")}
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 ml-auto" />
            </button>

            <div className="grid grid-cols-2 gap-2 max-h-[45vh] overflow-y-auto">
              {BUILTIN_PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pick(p)}
                  className="flex items-center gap-3 p-3 border border-border rounded-lg hover:border-primary hover:bg-primary/5 transition-colors text-left"
                >
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-sm font-bold text-primary shrink-0">
                    {p.name[0]}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{p.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{p.api_url}</div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 ml-auto" />
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && preset && (
          <div className="p-4 space-y-3">
            <div className="p-3 bg-primary/5 border border-primary/20 rounded-md text-xs">
              <strong>{preset.name}</strong>
              <span className="text-muted-foreground ml-2">{preset.api_url}</span>
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">
                {t("wizard.name")}
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={preset.name}
                className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">
                {t("wizard.apiKey")}
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
                autoFocus
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">
                {t("wizard.modelName")}
              </label>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-4 / deepseek-chat ..."
                className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
            </div>
            <button
              onClick={() => save(true)}
              disabled={!apiKey.trim()}
              className="w-full py-2 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40 flex items-center justify-center gap-1"
            >
              <ArrowRight className="w-3.5 h-3.5" /> {t("wizard.saveUse")}
            </button>
            <p className="text-[10px] text-muted-foreground text-center">{t("wizard.multiKey")}</p>
          </div>
        )}

        {step === 3 && (
          <div className="p-4 space-y-3">
            <div className="p-3 bg-primary/5 border border-primary/20 rounded-md text-xs">
              {t("wizard.urlHint")}
              <br />• {t("wizard.urlHint1", { code: "https://example.com" })}
              <br />• {t("wizard.urlHint2", { code: ".../v1" })}
              <br />• {t("wizard.urlHint3", { code: ".../chat/completions" })}
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">
                {t("wizard.customName")}
              </label>
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="My Relay / 我的中转站"
                className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
                autoFocus
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">
                {t("wizard.apiUrl")}
              </label>
              <input
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://api.example.com/v1 或完整 /chat/completions 地址"
                className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">
                {t("wizard.apiKeyOptional")}
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-... (optional)"
                className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">
                {t("wizard.modelId")}
              </label>
              <input
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="model-id"
                className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
            </div>
            <button
              onClick={saveCustom}
              disabled={!customUrl.trim() || !customName.trim()}
              className="w-full py-2 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40 flex items-center justify-center gap-1"
            >
              <ArrowRight className="w-3.5 h-3.5" /> {t("wizard.saveUseCustom")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
