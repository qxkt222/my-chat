import { useEffect, useState, useCallback } from "react";
import {
  Settings,
  Moon,
  Sun,
  Monitor,
  RefreshCw,
  MessageSquare,
  Languages,
  Palette,
  Martini,
} from "lucide-react";
import { useThemeStore } from "@/stores/useThemeStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useViewStore } from "@/stores/useViewStore";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useT } from "@/lib/i18n";
import {
  getSubModels,
  fetchModelsFromAPI,
  getCachedModels,
  setCachedModels,
} from "@/lib/model-presets";
import type { ThemeMode } from "@/types";

interface Props {
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
}

/** 顶部导航条（规范 5.1）：通栏蓝底 #1A6FB5，无圆角，标签/图标蓝色系 */
export function Header({ settingsOpen, onOpenSettings, onCloseSettings }: Props) {
  const t = useT();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const models = useSettingsStore((s) => s.models);
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);
  const mode = useAppModeStore((s) => s.mode);
  const setMode = useAppModeStore((s) => s.setMode);
  const subMode = useAppModeStore((s) => s.tavernSubMode);

  // Active provider → get its sub-models
  const activeProvider = models.find((m) => m.name === activeModel);
  const providerId = activeProvider?.provider || "";
  const [subModels, setSubModels] = useState<string[]>(
    () => getCachedModels(activeModel) || getSubModels(providerId)
  );
  const [subModel, setSubModel] = useState(activeProvider?.model || subModels[0] || "");
  const [fetching, setFetching] = useState(false);

  // Refresh sub-models when active model changes
  useEffect(() => {
    const p = models.find((m) => m.name === activeModel);
    const pid = p?.provider || "";
    const cached = getCachedModels(activeModel);
    const list = cached || getSubModels(pid);
    // 异步更新,避免 effect 内同步 setState 触发级联渲染(react-hooks 新规则)
    const id = window.setTimeout(() => {
      setSubModels(list);
      setSubModel(p?.model || list[0] || "");
    }, 0);
    return () => window.clearTimeout(id);
  }, [activeModel, models]);

  // Fetch models from API
  const handleFetch = useCallback(async () => {
    if (!activeProvider || fetching) return;
    setFetching(true);
    try {
      const list = await fetchModelsFromAPI(activeProvider.api_url, activeProvider.api_key);
      setSubModels(list);
      setCachedModels(activeModel, list);
      const first = list[0];
      if (list.length > 0 && first && !list.includes(subModel)) setSubModel(first);
    } catch {
      // Fall back to presets
    } finally {
      setFetching(false);
    }
  }, [activeProvider, activeModel, subModel, fetching]);

  // Update active model's sub-model when changed
  const handleSubModelChange = (v: string) => {
    setSubModel(v);
    if (activeProvider) {
      // F5: 只重写该模型记录，不再全量 save() 所有模型
      useSettingsStore.getState().updateModel(activeProvider.name, { model: v });
      useSettingsStore.getState().persistModel(activeProvider.name);
    }
  };

  const cycleTheme = () => {
    const modes: ThemeMode[] = ["light", "dark", "system"];
    const next = modes[(modes.indexOf(theme) + 1) % modes.length];
    if (next) setTheme(next);
  };

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  // 导航条内元素一律蓝色系（规范 2.3）
  const navIcon = "text-[#98BEDE] hover:text-white transition-colors";
  const navBtn = `p-1.5 rounded transition-colors ${navIcon}`;
  const navTab = (active: boolean) =>
    `px-2 py-1 rounded text-xs transition-colors ${
      active ? "bg-[#155D93] text-white" : "text-[#98BEDE] hover:text-white hover:bg-white/10"
    }`;

  return (
    <>
      <header className="flex items-center gap-2 px-3 h-10 bg-[#1A6FB5] shrink-0">
        {/* 品牌区：白字加粗 + 前缀图标 */}
        <span className="text-white font-semibold text-[15px] mr-2 flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 bg-white rounded-sm" />
          {t("app.title")}
        </span>

        {/* 双模式切换:工作 / 酒馆(角色扮演)——会话完全隔离,互不干扰 */}
        <div className="flex items-center gap-0.5 mr-2 bg-[#155D93]/60 rounded p-0.5">
          <button
            onClick={() => setMode("work")}
            className={`px-2.5 py-0.5 rounded text-[11px] transition-colors ${mode === "work" ? "bg-white text-[#155D93] font-semibold" : "text-[#98BEDE] hover:text-white"}`}
            title={t("appMode.workHint")}
          >
            <span className="flex items-center gap-1">
              <MessageSquare className="w-3 h-3" /> {t("appMode.work")}
            </span>
          </button>
          <button
            onClick={() => setMode("tavern")}
            className={`px-2.5 py-0.5 rounded text-[11px] transition-colors ${mode === "tavern" ? "bg-white text-[#155D93] font-semibold" : "text-[#98BEDE] hover:text-white"}`}
            title={t("appMode.tavernHint")}
          >
            <span className="flex items-center gap-1">
              <Martini className="w-3 h-3" /> {t("appMode.tavern")}
            </span>
          </button>
        </div>

        {/* 工作区标签（仅工作模式;激活 = 深蓝底白字） */}
        {mode === "work" && (
          <>
            <button
              onClick={() => setView("chat")}
              className={navTab(view === "chat")}
              title={`${t("header.chat")}（Ctrl+K）`}
            >
              <span className="flex items-center gap-1">
                <MessageSquare className="w-3.5 h-3.5" /> {t("header.chat")}
              </span>
            </button>
            <button
              onClick={() => setView("translation")}
              className={navTab(view === "translation")}
              title={t("palette.openTranslate")}
            >
              <span className="flex items-center gap-1">
                <Languages className="w-3.5 h-3.5" /> {t("header.translate")}
              </span>
            </button>
            <button
              onClick={() => setView("drawing")}
              className={navTab(view === "drawing")}
              title={t("palette.openDraw")}
            >
              <span className="flex items-center gap-1">
                <Palette className="w-3.5 h-3.5" /> {t("header.draw")}
              </span>
            </button>
          </>
        )}

        <div className="w-px h-5 bg-white/20 mx-1" />

        {/* Provider Dropdown（仅工作模式 + 对话视图显示） */}
        {mode === "work" && view === "chat" && (
          <>
            <select
              value={activeModel}
              onChange={(e) => {
                // F5: 只持久化 active_model 单条设置，不重写全部模型
                useSettingsStore.getState().persistActiveModel(e.target.value);
              }}
              className="px-1.5 py-0.5 text-[11px] bg-[#155D93] text-white border border-white/20 rounded max-w-[130px] cursor-pointer"
              title={t("header.providerHint")}
            >
              <option value="">{t("no.model")}</option>
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
            {activeModel && (
              <select
                value={subModel}
                onChange={(e) => handleSubModelChange(e.target.value)}
                className="px-1.5 py-0.5 text-[11px] bg-[#155D93] text-white border border-white/20 rounded max-w-[150px] cursor-pointer"
                title={t("header.subModelHint")}
              >
                {subModels.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            )}
            {activeModel && (
              <button
                onClick={handleFetch}
                disabled={fetching}
                className={`${navBtn} ${fetching ? "animate-spin" : ""}`}
                title={t("header.fetchModels")}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            )}
          </>
        )}

        <div className="flex-1" />

        <button
          onClick={cycleTheme}
          className={navBtn}
          title={
            theme === "dark"
              ? t("theme.dark")
              : theme === "light"
                ? t("theme.light")
                : t("theme.system")
          }
        >
          <ThemeIcon className="w-4 h-4" />
        </button>
        {/* 开关语义：开着再点就关。
            2026-09-25 开发者反馈「重新点击设置结果又来到了原来那个窗口」——
            原先这里只有 onOpenSettings，点它永远是「开」，弹窗开着时点它毫无反应。 */}
        <button
          onClick={settingsOpen ? onCloseSettings : onOpenSettings}
          className={`${navBtn} ${settingsOpen ? "bg-muted" : ""}`}
          title={
            mode === "tavern"
              ? subMode === "simulate"
                ? t("settings.simTitle")
                : t("settings.tavernTitle")
              : t("settings.title")
          }
        >
          <Settings className="w-4 h-4" />
        </button>
      </header>

      {/* key={mode}:切换工作/酒馆时重挂载,tab 默认值按新模式初始化(替代 effect 重置) */}
      <SettingsDialog key={mode} open={settingsOpen} onClose={onCloseSettings} />
    </>
  );
}
