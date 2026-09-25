import { useState } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useAppConfigStore, applyFontSize } from "@/stores/useAppConfigStore";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { useChatStore } from "@/stores/useChatStore";
import { useT } from "@/lib/i18n";
import { showToast } from "@/components/ui/Toast";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { PluginManager } from "@/components/plugins/PluginManager";
import { KnowledgeManager } from "@/components/knowledge/KnowledgeManager";
import { DataManager } from "./DataManager";
import { ModelWizard } from "./ModelWizard";
import { AdapterConfigDialog } from "@/components/adapters/AdapterConfigDialog";
import { McpManager } from "./McpManager";
import { SkillManager } from "@/components/skills/SkillManager";
import { MemoryManager } from "./MemoryManager";
import { CharacterManager } from "@/components/characters/CharacterManager";
import { LorebookManager } from "@/components/characters/LorebookManager";
import { TranslateManager } from "./TranslateManager";
import { PresetManager } from "./PresetManager";
import { SamplerManager } from "./SamplerManager";
import { BudgetPanel } from "./BudgetPanel";
import { RegexManager } from "./RegexManager";
import { CacheManager } from "./CacheManager";
import { TavernAssistant } from "./TavernAssistant";
import { SimulationSettings } from "./SimulationSettings";
import type { ModelConfig, ModelParameters } from "@/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 工作模式专属设置 tab */
const WORK_TABS = [
  "models",
  "general",
  "plugins",
  "kb",
  "adapter",
  "mcp",
  "skills",
  "memory",
] as const;
/** 酒馆模式专属设置 tab */
const TAVERN_TABS = ["characters", "lore", "presets", "regex", "cache", "assistant"] as const;
/** 酒馆推演子模式专属设置 tab */
const SIMULATE_TABS = ["simulate"] as const;
/** 两种模式共用的 tab */
const COMMON_TABS = ["data", "translate", "sampler", "budget"] as const;

type TabKey =
  | (typeof WORK_TABS)[number]
  | (typeof TAVERN_TABS)[number]
  | (typeof SIMULATE_TABS)[number]
  | (typeof COMMON_TABS)[number];

export function SettingsDialog({ open, onClose }: Props) {
  const t = useT();
  const s = useSettingsStore();
  const cfg = useAppConfigStore();
  const mode = useAppModeStore((s) => s.mode);
  const subMode = useAppModeStore((s) => s.tavernSubMode);
  const [models, setModels] = useState<ModelConfig[]>(s.models);
  const [active, setActive] = useState(s.activeModel);
  const [temp, setTemp] = useState(s.defaultParameters.temperature || 0.7);
  const [maxT, setMaxT] = useState(s.defaultParameters.max_tokens || 2048);
  const [fontSize, setFontSize] = useState(cfg.fontSize);
  const [locale, setLocale] = useState(cfg.locale);
  const [profileName, setProfileName] = useState("");
  /** 进入设置时落在哪个 tab —— 也是「返回」要回到的那一格。
   *  2026-09-25 开发者反馈：「点了是退出弹窗，反而不是回到当初的设置那一筐」。
   *  根因是这里原先**没有「上一层」的概念**，面板只能拿 onClose 当返回键，
   *  于是「返回」= 整个弹窗关掉。现在「返回」= 回到这一格，弹窗不动。 */
  const homeTab: TabKey =
    mode === "tavern" ? (subMode === "simulate" ? "simulate" : "characters") : "models";
  const [tab, setTab] = useState<TabKey>(homeTab);
  const [showWizard, setShowWizard] = useState(false);
  // 工作模式自动记忆(记忆卡)开关 + 临时会话:实时同步 store
  const workAutoSummarize = useChatStore((s) => s.workAutoSummarize);
  const workTempMode = useChatStore((s) => s.workTempMode);

  // 当前模式的 tab 顺序:专属在前,通用在后(酒馆按子模式分)
  const tabs: TabKey[] =
    mode === "tavern"
      ? [...(subMode === "simulate" ? SIMULATE_TABS : TAVERN_TABS), ...COMMON_TABS]
      : [...WORK_TABS, ...COMMON_TABS];

  // Escape 关闭(此前只有右上角小 X,按 Esc 退不出;打开时才监听)
  useEscapeClose(open ? onClose : undefined);

  if (!open) return null;

  const tabLabel = (k: TabKey): string => {
    const map: Record<TabKey, string> = {
      models: t("settings.models"),
      general: t("settings.general"),
      plugins: t("settings.plugins"),
      kb: t("kb.title"),
      adapter: t("settings.adapter"),
      mcp: t("settings.mcp"),
      skills: t("settings.skills"),
      memory: t("settings.memory"),
      characters: t("settings.characters"),
      lore: t("settings.lore"),
      presets: t("settings.presets"),
      regex: t("settings.regex"),
      cache: t("settings.cache"),
      assistant: t("settings.assistant"),
      simulate: t("settings.simulate"),
      data: t("settings.data"),
      translate: t("settings.translate"),
      sampler: t("settings.sampler"),
      budget: t("settings.budget"),
    };
    return map[k];
  };

  const save = async () => {
    s.setDefaultParameters({ temperature: temp, max_tokens: maxT });
    cfg.setFontSize(fontSize);
    applyFontSize(fontSize);
    cfg.setLocale(locale);
    await s.save();
    onClose();
  };

  // F2 per-model 参数行内编辑：更新本地 models state；保存按钮走 s.save() 全量落盘
  const patchModelParams = (
    i: number,
    params: { temperature?: number | undefined; max_tokens?: number | undefined }
  ) => {
    // exactOptionalPropertyTypes: 丢弃 undefined 值,只留有效字段
    const merged: ModelParameters = { ...(models[i]?.parameters || {}) };
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === "number") merged[k as keyof ModelParameters] = v;
    }
    const list = models.map((m, j) => (j === i ? { ...m, parameters: merged } : m));
    setModels(list);
    // exactOptionalPropertyTypes: 不传 undefined 键(参数对象可能为空)
    const patch: Partial<ModelConfig> = {};
    const target = list[i];
    if (target?.parameters) patch.parameters = target.parameters;
    if (target) s.updateModel(target.name, patch);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg w-[600px] max-h-[80vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">
            {mode === "tavern"
              ? subMode === "simulate"
                ? t("settings.simTitle")
                : t("settings.tavernTitle")
              : t("settings.title")}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex border-b border-border px-4 overflow-x-auto">
          {tabs.map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 py-2 text-xs border-b-2 whitespace-nowrap ${tab === k ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}
            >
              {tabLabel(k)}
            </button>
          ))}
        </div>
        {/* ⚠️ min-h-0 不能删：flex 子项的 min-height 默认是 auto（=不许缩到内容高度以下），
            少了它，超长内容（如展开一个几千字的预设模板）会把弹窗顶高、把底部「取消/保存」
            整条推出视口 —— 实测 1264x569 下取消按钮 top=796、visibleH=0，用户按不到任何退出键。
            加上 min-h-0 后滚动条才真正接管，底部按钮恒定可见。 */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {tab === "models" && (
            <>
              {models.length > 0 && (
                <div className="flex items-center gap-2 mb-4 p-3 bg-primary/5 border border-primary/20 rounded-md">
                  <label className="text-xs font-medium whitespace-nowrap">
                    {t("settings.defaultModel")}:
                  </label>
                  <select
                    value={active}
                    onChange={(e) => {
                      setActive(e.target.value);
                      s.setActiveModel(e.target.value);
                      s.persistActiveModel(e.target.value);
                    }}
                    className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
                  >
                    <option value="">-- {t("no.model")} --</option>
                    {models.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {models.map((m, i) => (
                <div key={i} className="p-3 border border-border rounded-md bg-card mb-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium">{m.name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {m.api_url} / {m.model || m.name}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        s.removeModel(m.name);
                        setModels(models.filter((_, j) => j !== i));
                        if (active === m.name) setActive("");
                      }}
                      className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {/* F2 per-model 参数（随「保存」按钮一起落盘到 params_json） */}
                  <div className="flex items-center gap-3 mt-2 pl-1 text-[10px] text-muted-foreground">
                    <label className="flex items-center gap-1">
                      {t("settings.tempLabel")}
                      <input
                        type="number"
                        min="0"
                        max="2"
                        step="0.1"
                        value={m.parameters?.temperature ?? ""}
                        placeholder={(s.defaultParameters.temperature ?? 0.7).toFixed(1)}
                        onChange={(e) =>
                          patchModelParams(i, {
                            temperature: e.target.value === "" ? undefined : +e.target.value,
                          })
                        }
                        className="w-16 px-1.5 py-0.5 bg-background border border-input rounded"
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      {t("settings.maxTokens")}
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={m.parameters?.max_tokens ?? ""}
                        placeholder={String(s.defaultParameters.max_tokens ?? 2048)}
                        onChange={(e) =>
                          patchModelParams(i, {
                            max_tokens: e.target.value === "" ? undefined : +e.target.value,
                          })
                        }
                        className="w-20 px-1.5 py-0.5 bg-background border border-input rounded"
                      />
                    </label>
                    <span className="ml-auto opacity-70">{t("settings.perModelHint")}</span>
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-muted-foreground mb-2">{t("settings.multiKeyHint")}</p>
              {/* 连接配置档案(酒馆 Connection Profiles):多套 API 连接一键切换 */}
              <div className="p-3 border border-border rounded-md bg-card mb-2">
                <div className="text-xs font-medium mb-1 flex items-center gap-1.5">
                  <span className="text-primary">▦</span> {t("settings.profiles")}
                  <span className="text-[9px] text-muted-foreground">
                    {t("settings.profileHint")}
                  </span>
                </div>
                {s.connectionProfiles.length > 0 && (
                  <div className="space-y-1 mb-2">
                    {s.connectionProfiles.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 text-[11px]">
                        <span className="flex-1 min-w-0 truncate">
                          <span className="font-medium">{p.name}</span>
                          <span className="text-muted-foreground"> · {p.model}</span>
                        </span>
                        <button
                          onClick={() => {
                            void s.applyConnectionProfile(p.id).then((ok) => {
                              showToast(
                                ok ? "success" : "error",
                                ok ? t("settings.profileApplied") : t("settings.profileNeedModel")
                              );
                              setModels([...useSettingsStore.getState().models]);
                            });
                          }}
                          className="px-2 py-0.5 rounded border border-input hover:bg-muted"
                        >
                          {t("settings.profileApply")}
                        </button>
                        <button
                          onClick={() => void s.removeConnectionProfile(p.id)}
                          className="p-0.5 rounded hover:bg-destructive/20 text-destructive"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <input
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    placeholder={t("settings.profileName")}
                    className="flex-1 px-2 py-1 text-[11px] bg-background border border-input rounded"
                  />
                  <button
                    onClick={() => {
                      if (!profileName.trim()) {
                        showToast("error", t("settings.profileNeedName"));
                        return;
                      }
                      const m = models.find((x) => x.name === active);
                      if (!m) {
                        showToast("error", t("settings.profileNeedModel"));
                        return;
                      }
                      void s.saveConnectionProfile({
                        id: crypto.randomUUID(),
                        name: profileName.trim(),
                        api_url: m.api_url,
                        api_key: m.api_key,
                        model: m.model,
                        created_at: new Date().toISOString(),
                      });
                      setProfileName("");
                      showToast("success", t("settings.profileSaved"));
                    }}
                    className="px-2 py-1 text-[11px] rounded bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
                  >
                    {t("settings.profileSave")}
                  </button>
                </div>
              </div>
              <button
                onClick={() => setShowWizard(true)}
                className="w-full py-3 border-2 border-dashed border-border rounded-lg text-xs text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> {t("settings.addModel")}
              </button>

              {showWizard && (
                <ModelWizard
                  onDone={() => {
                    setShowWizard(false);
                    setModels([...useSettingsStore.getState().models]);
                    setActive(useSettingsStore.getState().activeModel);
                  }}
                />
              )}
            </>
          )}
          {tab === "general" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground w-28">
                  {t("settings.fontSize")}:
                </label>
                <select
                  value={fontSize}
                  onChange={(e) => {
                    setFontSize(e.target.value as "small" | "medium" | "large");
                    applyFontSize(e.target.value as "small" | "medium" | "large");
                  }}
                  className="w-24 px-2 py-1 text-xs bg-background border border-input rounded"
                >
                  <option value="small">{t("settings.small")}</option>
                  <option value="medium">{t("settings.medium")}</option>
                  <option value="large">{t("settings.large")}</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground w-28">
                  {t("settings.language")}:
                </label>
                <select
                  value={locale}
                  onChange={(e) => setLocale(e.target.value as "zh" | "en")}
                  className="w-24 px-2 py-1 text-xs bg-background border border-input rounded"
                >
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </div>
              {/* Reasoning / thinking controls (DeepSeek v4 etc.) */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground w-28">
                  {t("settings.thinking")}:
                </label>
                <button
                  onClick={() => {
                    s.setThinkingConfig(!s.thinkingEnabled, s.reasoningEffort);
                    s.save();
                  }}
                  className={`px-3 py-1 text-xs rounded border transition-colors ${s.thinkingEnabled ? "bg-primary/20 border-primary text-primary" : "border-input bg-background text-muted-foreground"}`}
                >
                  {s.thinkingEnabled ? t("settings.thinkingOn") : t("settings.thinkingOff")}
                </button>
                <span className="text-[10px] text-muted-foreground">
                  {t("settings.thinkingHint")}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground w-28">
                  {t("settings.effort")}:
                </label>
                <select
                  value={s.reasoningEffort}
                  onChange={(e) => {
                    s.setThinkingConfig(
                      s.thinkingEnabled,
                      e.target.value as "low" | "medium" | "high" | "max"
                    );
                    s.save();
                  }}
                  className="w-24 px-2 py-1 text-xs bg-background border border-input rounded"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="max">Max</option>
                </select>
                <span className="text-[10px] text-muted-foreground">
                  {t("settings.effortHint")}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground w-28">
                  {t("settings.temperature")}:
                </label>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temp}
                  onChange={(e) => setTemp(+e.target.value)}
                  className="flex-1"
                />
                <span className="text-xs w-8 text-right">{temp}</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground w-28">
                  {t("settings.maxTokens")}:
                </label>
                <input
                  type="number"
                  value={maxT}
                  onChange={(e) => setMaxT(+e.target.value || 2048)}
                  className="w-24 px-2 py-1 text-xs bg-background border border-input rounded"
                />
              </div>
              {/* 工作模式自动记忆(记忆卡):历史超阈值自动摘要注入上下文,省 token 保记忆 */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground w-28">
                  {t("settings.workAutoSummarize")}:
                </label>
                <button
                  onClick={() => useChatStore.getState().setWorkAutoSummarize(!workAutoSummarize)}
                  className={`px-3 py-1 text-xs rounded border transition-colors ${workAutoSummarize ? "bg-primary/20 border-primary text-primary" : "border-input bg-background text-muted-foreground"}`}
                >
                  {workAutoSummarize ? t("settings.thinkingOn") : t("settings.thinkingOff")}
                </button>
                <span className="text-[10px] text-muted-foreground">
                  {t("settings.workAutoSummarizeHint")}
                </span>
              </div>
              {/* 临时会话(免记忆):开启后本次会话完全不读写记忆(ChatGPT Memory 临时对话) */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground w-28">
                  {t("settings.workTempMode")}:
                </label>
                <button
                  onClick={() => useChatStore.getState().setWorkTempMode(!workTempMode)}
                  className={`px-3 py-1 text-xs rounded border transition-colors ${workTempMode ? "bg-primary/20 border-primary text-primary" : "border-input bg-background text-muted-foreground"}`}
                >
                  {workTempMode ? t("settings.thinkingOn") : t("settings.thinkingOff")}
                </button>
                <span className="text-[10px] text-muted-foreground">
                  {t("settings.workTempModeHint")}
                </span>
              </div>
              {/* 停止字符串(酒馆 Stopping Strings):生成到这些串时提前终止;每行一个 */}
              <div>
                <label className="text-xs text-muted-foreground block mb-0.5">
                  {t("settings.stoppingStrings")}
                </label>
                <textarea
                  value={(s.stoppingStrings || []).join("\n")}
                  onChange={(e) => {
                    const ss = e.target.value
                      .split("\n")
                      .map((x) => x.trim())
                      .filter(Boolean);
                    void s.setStoppingStrings(ss);
                  }}
                  rows={2}
                  placeholder={"每行一个停止串,如:\n</s>\n<|im_end|>"}
                  className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
                />
                <span className="text-[10px] text-muted-foreground">
                  {t("settings.stoppingStringsHint")}
                </span>
              </div>
            </div>
          )}
          {tab === "plugins" && <PluginManager />}
          {tab === "kb" && <KnowledgeManager />}
          {tab === "data" && <DataManager />}
          {tab === "adapter" && (
            <AdapterConfigDialog open embedded onClose={() => setTab("models")} />
          )}
          {tab === "mcp" && <McpManager />}
          {tab === "skills" && <SkillManager />}
          {tab === "memory" && <MemoryManager />}
          {tab === "characters" && <CharacterManager />}
          {tab === "lore" && <LorebookManager />}
          {tab === "translate" && <TranslateManager />}
          {tab === "presets" && <PresetManager onBack={() => setTab(homeTab)} />}
          {tab === "sampler" && <SamplerManager />}
          {tab === "budget" && <BudgetPanel />}
          {tab === "regex" && <RegexManager />}
          {tab === "cache" && <CacheManager />}
          {tab === "assistant" && <TavernAssistant />}
          {tab === "simulate" && <SimulationSettings />}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs rounded border border-input hover:bg-muted"
          >
            {t("settings.cancel")}
          </button>
          <button
            onClick={save}
            className="px-4 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {t("settings.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
