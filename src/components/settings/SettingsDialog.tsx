import { useEffect, useRef, useState } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { useSettingsStore, type DrawEngineSetting } from "@/stores/useSettingsStore";
import { probeDrawService } from "@/lib/tauri";
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
import type { DrawEngine, ModelConfig, ModelParameters } from "@/types";

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
const COMMON_TABS = ["data", "translate", "drawing", "sampler", "budget"] as const;

type TabKey =
  | (typeof WORK_TABS)[number]
  | (typeof TAVERN_TABS)[number]
  | (typeof SIMULATE_TABS)[number]
  | (typeof COMMON_TABS)[number];

/** 停止串的落盘格式：每行一个，去首尾空白、丢空行。
 *  ⚠️ 只在 blur / 保存时调用 —— 输入期间必须保留 textarea 原文（含换行），
 *  否则 onChange 里立刻 trim+filter 会把回车产生的尾随换行当场吞掉，
 *  用户永远敲不出第二行（T-027）。 */
function parseStoppingStrings(text: string): string[] {
  return text
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function SettingsDialog({ open, onClose }: Props) {
  const t = useT();
  const s = useSettingsStore();
  const cfg = useAppConfigStore();
  const mode = useAppModeStore((s) => s.mode);
  const subMode = useAppModeStore((s) => s.tavernSubMode);
  const workSubMode = useAppModeStore((s) => s.workSubMode);
  const [models, setModels] = useState<ModelConfig[]>(s.models);
  const [active, setActive] = useState(s.activeModel);
  const [temp, setTemp] = useState(s.defaultParameters.temperature || 0.7);
  const [maxT, setMaxT] = useState(s.defaultParameters.max_tokens || 2048);
  // T-027: 停止串先用本地草稿承接原始文本（含换行），blur/保存时才解析落盘。
  // 旧实现 value 直接取 store 数组 join("\n") + onChange 立刻 split/trim/filter，
  // 回车换行当场消失（无法输入第二行），且每个按键写一次 sled。
  const [stoppingDraft, setStoppingDraft] = useState((s.stoppingStrings || []).join("\n"));
  const [fontSize, setFontSize] = useState(cfg.fontSize);
  const [locale, setLocale] = useState(cfg.locale);
  const [profileName, setProfileName] = useState("");
  /** 绘图「测试连接」状态：ok/offline 显示服务信息，error 显示可读错误 */
  const [drawProbe, setDrawProbe] = useState<{
    kind: "ok" | "offline" | "error";
    text: string;
  } | null>(null);
  const [drawTesting, setDrawTesting] = useState(false);
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

  // ⚠️ 跨 scope 串值修复(2026-10-23):上面几个 useState 只在挂载那一刻取值,
  //    而 Header 是**常驻挂载**(原先 key 只有 mode,连工作子模式都不重挂),
  //    用户切过 对话/工作 再打开设置,看到的是启动时那套值,保存就把旧 scope
  //    的采样参数写进新 scope。这里在「关闭→打开」或 scope 变化时重新从 store 同步。
  //    只在两个时机同步,**不随 store 变化实时覆盖** —— 否则用户正在表单里改的值
  //    会被一次无关的 store 更新(如模型列表刷新)打回原样。
  // T-133: key 必须包含 tavernSubMode —— rp↔simulate 切换时 tab 集合与默认面板
  // 完全不同;不含子模式会保留旧 tab(按钮无高亮、渲染错面板)。
  const scopeKey = `${mode}:${workSubMode}:${subMode}`;
  const prevOpen = useRef(false);
  const prevScopeKey = useRef(scopeKey);
  useEffect(() => {
    const justOpened = open && !prevOpen.current;
    const scopeChanged = prevScopeKey.current !== scopeKey;
    prevOpen.current = open;
    prevScopeKey.current = scopeKey;
    if (!open || (!justOpened && !scopeChanged)) return;
    // 用 getState() 而不是渲染期快照 `s`:effect 执行时 store 可能已经换成新 scope
    const st = useSettingsStore.getState();
    setModels([...st.models]);
    setActive(st.activeModel);
    setTemp(st.defaultParameters.temperature ?? 0.7);
    setMaxT(st.defaultParameters.max_tokens ?? 2048);
    setStoppingDraft((st.stoppingStrings || []).join("\n"));
    // 子模式变化后旧 tab 可能不在新 tabs 列表里 —— 切回该模式的首页
    if (scopeChanged) setTab(homeTab);
  }, [open, scopeKey, homeTab]);

  // 当前模式的 tab 顺序:专属在前,通用在后(酒馆按子模式分)
  const tabs: TabKey[] =
    mode === "tavern"
      ? [...(subMode === "simulate" ? SIMULATE_TABS : TAVERN_TABS), ...COMMON_TABS]
      : [...WORK_TABS, ...COMMON_TABS];

  // T-133 渲染守卫:旧 tab 若不属于当前模式的 tabs,按首页渲染(而不是渲染
  // 一个已不存在的面板,例如 rp→simulate 后仍显示角色管理)。
  const activeTab: TabKey = tabs.includes(tab) ? tab : homeTab;

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
      drawing: t("settings.drawing"),
      sampler: t("settings.sampler"),
      budget: t("settings.budget"),
    };
    return map[k];
  };

  /** 把停止串草稿解析后落盘；与已存值相同则跳过（blur 与保存不重复写） */
  const commitStoppingStrings = async () => {
    const next = parseStoppingStrings(stoppingDraft);
    const prev = useSettingsStore.getState().stoppingStrings || [];
    if (next.length === prev.length && next.every((v, i) => v === prev[i])) return;
    await s.setStoppingStrings(next);
  };

  // T-097: s.save() 失败必须提示且不关闭弹窗 —— 旧实现 floating promise,
  //        用户以为保存成功、实际什么都没落盘。
  const save = async () => {
    try {
      await commitStoppingStrings();
      commitModelParams();
      s.setDefaultParameters({ temperature: temp, max_tokens: maxT });
      cfg.setFontSize(fontSize);
      applyFontSize(fontSize);
      cfg.setLocale(locale);
      await s.save();
    } catch (e) {
      showToast("error", `${t("settings.saveFailed")} ${String(e)}`);
      return;
    }
    onClose();
  };

  /** 思考开关/强度是即时生效的：here be floating promise — 显式 catch 并提示 */
  const saveThinkingConfig = () => {
    void s.save().catch((e: unknown) => {
      showToast("error", `${t("settings.saveFailed")} ${String(e)}`);
    });
  };

  // F2 per-model 参数行内编辑：只改本地草稿，保存按钮才提交到 store/落盘。
  // T-098: 旧实现每敲一个键就 updateModel 全局 store —— 点「取消」不回滚，
  //        之后任何一次 save() 都会把已取消的值落库。
  // T-095: 清空输入框(undefined)必须 delete 该键，否则旧值被原样保留、
  //        无法回到 scope 默认值。
  const patchModelParams = (
    i: number,
    params: { temperature?: number | undefined; max_tokens?: number | undefined }
  ) => {
    const merged: ModelParameters = { ...(models[i]?.parameters || {}) };
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        merged[k as keyof ModelParameters] = v;
      } else {
        delete merged[k as keyof ModelParameters];
      }
    }
    setModels(models.map((m, j) => (j === i ? { ...m, parameters: merged } : m)));
  };

  /** 把 per-model 草稿提交到 store（保存时调用；取消则直接丢弃） */
  const commitModelParams = () => {
    for (const m of models) {
      if (m.parameters === undefined) continue;
      s.updateModel(m.name, { parameters: m.parameters });
    }
  };

  /**
   * 测试绘图服务连接。`chat-model` 旧行为没有独立服务地址，沿用当前聊天模型的
   * api_url/api_key（Rust 侧会归一化并补 /images/generations）。
   */
  const runDrawProbe = async () => {
    if (drawTesting) return;
    const st = useSettingsStore.getState();
    const dc = st.drawConfig;
    let engine: DrawEngine = "openai";
    let baseUrl = dc.baseUrl.trim();
    let apiKey = dc.apiKey;
    if (dc.engine === "chat-model") {
      const model = st.models.find((m) => m.name === st.activeModel);
      baseUrl = model?.api_url || "";
      apiKey = model?.api_key || "";
    } else {
      engine = dc.engine;
    }
    if (!baseUrl) {
      setDrawProbe({ kind: "error", text: t("draw.needBaseUrl") });
      return;
    }
    setDrawTesting(true);
    setDrawProbe(null);
    try {
      const info = await probeDrawService(engine, baseUrl, apiKey);
      const parts: string[] = [];
      if (!info.online) {
        // online=false 表示连不上；此时不能再追加「未返回模型列表」，否则双重误导
        parts.push(t("draw.testOffline"));
      } else if (info.models.length === 0) {
        parts.push(t("draw.testOnlineNoModels"));
      } else {
        parts.push(t("draw.testOnline"));
        parts.push(`${t("draw.modelsLabel")}: ${info.models.join(", ")}`);
      }
      if (info.samplers.length > 0) {
        parts.push(`${t("draw.samplersLabel")}: ${info.samplers.join(", ")}`);
      }
      setDrawProbe({ kind: info.online ? "ok" : "offline", text: parts.join(" · ") });
    } catch (e) {
      setDrawProbe({ kind: "error", text: `${t("draw.testFailed")}${String(e)}` });
    } finally {
      setDrawTesting(false);
    }
  };

  const patchDrawDefaults = (patch: Partial<typeof s.drawConfig.defaults>) => {
    void s.setDrawConfig({ defaults: { ...s.drawConfig.defaults, ...patch } });
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
              : workSubMode === "chat"
                ? t("settings.workChatTitle")
                : t("settings.workWorkTitle")}
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
              className={`px-3 py-2 text-xs border-b-2 whitespace-nowrap ${activeTab === k ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}
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
          {activeTab === "models" && (
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
          {activeTab === "general" && (
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
                    saveThinkingConfig();
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
                    saveThinkingConfig();
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
                  value={stoppingDraft}
                  onChange={(e) => setStoppingDraft(e.target.value)}
                  onBlur={() => {
                    void commitStoppingStrings();
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
          {activeTab === "plugins" && <PluginManager />}
          {activeTab === "kb" && <KnowledgeManager />}
          {activeTab === "data" && <DataManager />}
          {activeTab === "adapter" && (
            <AdapterConfigDialog open embedded onClose={() => setTab("models")} />
          )}
          {activeTab === "mcp" && <McpManager />}
          {activeTab === "skills" && <SkillManager />}
          {activeTab === "memory" && <MemoryManager />}
          {activeTab === "characters" && <CharacterManager />}
          {activeTab === "lore" && <LorebookManager onBack={() => setTab(homeTab)} />}
          {activeTab === "translate" && <TranslateManager />}
          {activeTab === "drawing" && (
            <div className="space-y-4">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-semibold">{t("draw.settingsTitle")}</span>
                <span className="text-[10px] text-muted-foreground">{t("draw.engineHint")}</span>
              </div>

              <div className="flex items-center gap-2">
                <label htmlFor="draw-engine" className="text-xs text-muted-foreground w-28">
                  {t("draw.engine")}:
                </label>
                <select
                  id="draw-engine"
                  value={s.drawConfig.engine}
                  onChange={(e) => {
                    const engine = e.target.value as DrawEngineSetting;
                    const patch: { engine: DrawEngineSetting; baseUrl?: string } = { engine };
                    // 首次切到本地服务时填默认端口，避免空输入框
                    if (!s.drawConfig.baseUrl.trim()) {
                      if (engine === "comfyui") patch.baseUrl = "http://127.0.0.1:8188";
                      else if (engine === "sdwebui") patch.baseUrl = "http://127.0.0.1:7860";
                    }
                    void s.setDrawConfig(patch);
                  }}
                  className="px-2 py-1.5 text-xs bg-background border border-input rounded"
                >
                  <option value="chat-model">{t("draw.engineChatModel")}</option>
                  <option value="openai">{t("draw.engineOpenai")}</option>
                  <option value="comfyui">{t("draw.engineComfyui")}</option>
                  <option value="sdwebui">{t("draw.engineSdwebui")}</option>
                </select>
              </div>

              {s.drawConfig.engine === "chat-model" ? (
                <p className="text-[10px] text-muted-foreground pl-[7.5rem]">
                  {t("draw.needModel")}
                </p>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label htmlFor="draw-base-url" className="text-xs text-muted-foreground w-28">
                      {t("draw.baseUrl")}:
                    </label>
                    <input
                      id="draw-base-url"
                      value={s.drawConfig.baseUrl}
                      onChange={(e) => void s.setDrawConfig({ baseUrl: e.target.value })}
                      placeholder={
                        s.drawConfig.engine === "comfyui"
                          ? "http://127.0.0.1:8188"
                          : s.drawConfig.engine === "sdwebui"
                            ? "http://127.0.0.1:7860"
                            : "https://api.openai.com"
                      }
                      className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
                    />
                  </div>
                  <div className="pl-[7.5rem] text-[10px] text-muted-foreground">
                    {t("draw.baseUrlHint")}
                  </div>
                  <div className="flex items-center gap-2">
                    <label htmlFor="draw-api-key" className="text-xs text-muted-foreground w-28">
                      {t("draw.apiKey")}:
                    </label>
                    <input
                      id="draw-api-key"
                      type="password"
                      value={s.drawConfig.apiKey}
                      onChange={(e) => void s.setDrawConfig({ apiKey: e.target.value })}
                      placeholder={t("draw.apiKeyHint")}
                      className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label htmlFor="draw-model" className="text-xs text-muted-foreground w-28">
                      {t("draw.model")}:
                    </label>
                    <input
                      id="draw-model"
                      value={s.drawConfig.model}
                      onChange={(e) => void s.setDrawConfig({ model: e.target.value })}
                      placeholder={t("draw.modelHint")}
                      className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={() => void runDrawProbe()}
                  disabled={drawTesting}
                  className="px-3 py-1.5 text-xs border border-input rounded hover:bg-muted disabled:opacity-40"
                >
                  {drawTesting ? t("draw.testing") : t("draw.test")}
                </button>
                {drawProbe && (
                  <span
                    role="status"
                    className={`text-[11px] whitespace-pre-wrap ${
                      drawProbe.kind === "error" ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {drawProbe.text}
                  </span>
                )}
              </div>

              {s.drawConfig.engine === "comfyui" && (
                <div>
                  <label
                    htmlFor="draw-workflow"
                    className="text-xs text-muted-foreground block mb-1"
                  >
                    {t("draw.workflowJson")}
                  </label>
                  <textarea
                    id="draw-workflow"
                    value={s.drawConfig.comfyWorkflow}
                    onChange={(e) => void s.setDrawConfig({ comfyWorkflow: e.target.value })}
                    rows={5}
                    placeholder={t("draw.workflowPlaceholder")}
                    className="w-full px-2 py-1.5 text-xs font-mono bg-background border border-input rounded resize-y"
                  />
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {t("draw.workflowHint")}
                  </div>
                </div>
              )}

              <div className="pt-3 border-t border-border space-y-2">
                <div className="text-xs font-medium">{t("draw.defaults")}</div>
                <div className="flex flex-wrap items-center gap-3">
                  <label htmlFor="draw-default-size" className="text-xs text-muted-foreground">
                    {t("draw.size")}:
                  </label>
                  <input
                    id="draw-default-size"
                    list="draw-size-options"
                    value={s.drawConfig.defaults.size}
                    onChange={(e) => patchDrawDefaults({ size: e.target.value })}
                    className="w-28 px-2 py-1.5 text-xs bg-background border border-input rounded"
                  />
                  <datalist id="draw-size-options">
                    {["512x512", "768x768", "1024x1024", "1024x1536", "1536x1024"].map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>

                  <label htmlFor="draw-default-steps" className="text-xs text-muted-foreground">
                    {t("draw.steps")}:
                  </label>
                  <input
                    id="draw-default-steps"
                    type="number"
                    min="1"
                    step="1"
                    value={s.drawConfig.defaults.steps}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n) && n > 0) patchDrawDefaults({ steps: n });
                    }}
                    className="w-20 px-2 py-1.5 text-xs bg-background border border-input rounded"
                  />

                  <label htmlFor="draw-default-cfg" className="text-xs text-muted-foreground">
                    {t("draw.cfg")}:
                  </label>
                  <input
                    id="draw-default-cfg"
                    type="number"
                    min="0"
                    step="0.1"
                    value={s.drawConfig.defaults.cfgScale}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n) && n >= 0) patchDrawDefaults({ cfgScale: n });
                    }}
                    className="w-20 px-2 py-1.5 text-xs bg-background border border-input rounded"
                  />

                  <label htmlFor="draw-default-seed" className="text-xs text-muted-foreground">
                    {t("draw.seed")}:
                  </label>
                  <input
                    id="draw-default-seed"
                    type="number"
                    step="1"
                    value={s.drawConfig.defaults.seed}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) patchDrawDefaults({ seed: Math.trunc(n) });
                    }}
                    className="w-24 px-2 py-1.5 text-xs bg-background border border-input rounded"
                  />
                  <span className="text-[10px] text-muted-foreground">{t("draw.seedHint")}</span>

                  <label htmlFor="draw-default-sampler" className="text-xs text-muted-foreground">
                    {t("draw.sampler")}:
                  </label>
                  <input
                    id="draw-default-sampler"
                    value={s.drawConfig.defaults.sampler}
                    onChange={(e) => patchDrawDefaults({ sampler: e.target.value })}
                    placeholder={t("draw.samplerHint")}
                    className="w-32 px-2 py-1.5 text-xs bg-background border border-input rounded"
                  />
                </div>
              </div>

              {/* 搭建指引：只给官方链接与命令示例，不做任何下载/启动动作 */}
              <div className="pt-3 border-t border-border space-y-1.5 text-[11px] text-muted-foreground">
                <div className="text-xs font-medium text-foreground">{t("draw.guide")}</div>
                <div>
                  {t("draw.guideComfyDesc")} ·{" "}
                  <a
                    href="https://github.com/comfyanonymous/ComfyUI/releases"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    {t("draw.download")}
                  </a>{" "}
                  · {t("draw.startCommand")}:{" "}
                  <code>python main.py --listen 127.0.0.1 --port 8188</code>
                  <div className="text-[10px]">{t("draw.startComfy")}</div>
                </div>
                <div>
                  {t("draw.guideSdDesc")} ·{" "}
                  <a
                    href="https://github.com/AUTOMATIC1111/stable-diffusion-webui"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    {t("draw.download")}
                  </a>{" "}
                  · {t("draw.startCommand")}: <code>webui-user.bat --api --listen --port 7860</code>
                  <div className="text-[10px]">{t("draw.startSd")}</div>
                </div>
                <div>
                  {t("draw.modelSources")}:{" "}
                  <a
                    href="https://civitai.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    Civitai
                  </a>{" "}
                  ·{" "}
                  <a
                    href="https://huggingface.co/models"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    Hugging Face
                  </a>
                </div>
                <div className="text-[10px]">{t("draw.guideNote")}</div>
              </div>
            </div>
          )}
          {activeTab === "presets" && <PresetManager onBack={() => setTab(homeTab)} />}
          {activeTab === "sampler" && <SamplerManager />}
          {activeTab === "budget" && <BudgetPanel />}
          {activeTab === "regex" && <RegexManager onBack={() => setTab(homeTab)} />}
          {activeTab === "cache" && <CacheManager />}
          {activeTab === "assistant" && <TavernAssistant />}
          {activeTab === "simulate" && <SimulationSettings />}
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
