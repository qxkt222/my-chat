import { useSettingsStore } from "@/stores/useSettingsStore";
import { useChatStore } from "@/stores/useChatStore";
import { useViewStore } from "@/stores/useViewStore";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { useTavernStore } from "@/stores/useTavernStore";
import { useSimulationStore } from "@/stores/useSimulationStore";
import { useT } from "@/lib/i18n";

/** 底部状态栏（规范 5.7）：深色 #2C3E50、32px；左状态灯+摘要，右快捷键提示 */
export function StatusBar() {
  const t = useT();
  const models = useSettingsStore((s) => s.models);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const tavernStreaming = useTavernStore((s) => s.isStreaming);
  const simStreaming = useSimulationStore((s) => s.isStreaming);
  const view = useViewStore((s) => s.view);
  const mode = useAppModeStore((s) => s.mode);
  const subMode = useAppModeStore((s) => s.tavernSubMode);

  const model = models.find((m) => m.name === activeModel);
  const streaming = isStreaming || tavernStreaming || simStreaming;
  const statusDot = streaming ? "bg-[#1E80CF]" : "bg-[#27AE60]"; // 运行中=蓝 / 就绪=绿
  // 酒馆模式按子模式显示(角色扮演/推演),不显示工作视图名(防混淆)
  const viewName =
    mode === "tavern"
      ? t(subMode === "simulate" ? "appMode.tavernSub.simulate" : "appMode.tavernSub.rp")
      : view === "chat"
        ? t("status.viewChat")
        : view === "translation"
          ? t("status.viewTranslate")
          : t("status.viewDraw");

  return (
    <footer className="flex items-center gap-2 px-3 h-8 bg-[#2C3E50] shrink-0 text-[#8899A6]">
      <span className={`inline-block w-2 h-2 rounded-full ${statusDot}`} />
      <span className="text-xs">
        {streaming ? t("status.generating") : t("status.ready")} · {viewName}
        {model && (
          <span className="ml-2 text-[11px] opacity-80">
            {t("status.model")}
            {model.name}
            {model.model ? ` / ${model.model}` : ""}
          </span>
        )}
      </span>
      <div className="flex-1" />
      <span className="text-[11px]">{t("status.paletteHint")}</span>
    </footer>
  );
}
