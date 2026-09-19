import { useMemo } from "react";
import { Gauge, Eye, Zap } from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useConversationStore } from "@/stores/useConversationStore";
import { useT } from "@/lib/i18n";
import { budgetFor } from "@/lib/context-budget";

/**
 * Token 预算面板(设置→预算,跨三模式共用):
 * 自动/手动开关 + 窗口×使用率滑杆 + 当前会话各槽实时占用条(绿/黄/红)。
 * 手动模式:超限只提示不自动砍。
 */
export function BudgetPanel() {
  const t = useT();
  const s = useSettingsStore();
  const activeConv = useConversationStore((s) => s.conversations.find((c) => c.id === s.activeId));

  const model = s.models.find((m) => m.name === s.activeModel);
  const budget = budgetFor(model, s.budgetConfig);

  // 当前会话各槽占用(用 countTokens 估算;system 段按前缀归类)
  const segments = useMemo(() => {
    const msgs = activeConv?.messages || [];
    const groups = new Map<string, number>();
    let hist = 0;
    for (const m of msgs) {
      const c = m.content || "";
      if (m.role === "user" || m.role === "assistant") {
        hist += c.length * 0.25;
      } else if (c.startsWith("【对话摘要】")) {
        groups.set("摘要", (groups.get("摘要") || 0) + c.length * 0.6);
      } else if (c.startsWith("【世界书")) {
        groups.set("世界书", (groups.get("世界书") || 0) + c.length * 0.6);
      } else {
        groups.set("系统提示", (groups.get("系统提示") || 0) + c.length * 0.6);
      }
    }
    const rows = [...groups.entries()].map(([name, chars]) => ({
      name,
      tokens: Math.round(chars),
    }));
    rows.push({ name: t("budget.history"), tokens: Math.round(hist) });
    return rows;
  }, [activeConv, t]);

  const total = segments.reduce((s2, x) => s2 + x.tokens, 0);
  const over = total > budget;

  const barColor = (usedPct: number) =>
    usedPct >= 100 ? "bg-destructive" : usedPct >= 80 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <Gauge className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">{t("budget.title")}</span>
        <span className="text-[10px] text-muted-foreground">{t("budget.subtitle")}</span>
      </div>

      {/* 自动/手动开关 */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground w-28">{t("budget.mode")}:</label>
        <button
          onClick={() =>
            void s.setBudgetConfig({
              ...s.budgetConfig,
              mode: s.budgetConfig.mode === "auto" ? "manual" : "auto",
            })
          }
          className={`px-3 py-1 text-xs rounded border transition-colors ${
            s.budgetConfig.mode === "auto"
              ? "bg-primary/20 border-primary text-primary"
              : "border-input bg-background text-muted-foreground"
          }`}
        >
          {s.budgetConfig.mode === "auto" ? t("budget.auto") : t("budget.manual")}
        </button>
        <span className="text-[10px] text-muted-foreground">
          {s.budgetConfig.mode === "auto" ? t("budget.autoHint") : t("budget.manualHint")}
        </span>
      </div>

      {/* 使用率滑杆 */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground w-28">{t("budget.usage")}:</label>
        <input
          type="range"
          min={50}
          max={100}
          step={5}
          value={s.budgetConfig.usage_pct}
          onChange={(e) =>
            void s.setBudgetConfig({ ...s.budgetConfig, usage_pct: +e.target.value })
          }
          className="flex-1"
        />
        <span className="text-xs w-10 text-right">{s.budgetConfig.usage_pct}%</span>
      </div>

      {/* 当前模型窗口信息 */}
      <div className="p-3 rounded-md border border-border bg-muted/30 text-[11px] text-muted-foreground space-y-1">
        <p>
          {t("budget.window")}:{" "}
          <span className="text-foreground">
            {model?.parameters?.context_window ?? s.budgetConfig.default_context_window}
          </span>{" "}
          × {s.budgetConfig.usage_pct}% = <span className="text-foreground">{budget}</span> tokens
        </p>
        <p className="flex items-center gap-1">
          <Eye className="w-3 h-3" /> {t("budget.estimateHint")}
        </p>
      </div>

      {/* 当前会话各槽占用 */}
      <div className="space-y-1.5">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
          {t("budget.currentSession")}
        </div>
        {segments.map((seg) => {
          const usedPct = budget > 0 ? (seg.tokens / budget) * 100 : 0;
          return (
            <div key={seg.name} className="flex items-center gap-2 text-[11px]">
              <span className="w-24 truncate text-muted-foreground">{seg.name}</span>
              <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
                <div
                  className={`h-full ${barColor(usedPct)} transition-all`}
                  style={{ width: `${Math.min(100, usedPct)}%` }}
                />
              </div>
              <span className="w-16 text-right text-muted-foreground">{seg.tokens}</span>
            </div>
          );
        })}
        <div className="flex items-center gap-2 text-[11px] pt-1 border-t border-border">
          <span className="w-24 truncate text-foreground font-medium">{t("budget.total")}</span>
          <div className="flex-1 h-2.5 rounded bg-muted overflow-hidden">
            <div
              className={`h-full ${over ? "bg-destructive" : "bg-primary"} transition-all`}
              style={{ width: `${Math.min(100, (total / budget) * 100)}%` }}
            />
          </div>
          <span
            className={`w-16 text-right ${over ? "text-destructive font-medium" : "text-muted-foreground"}`}
          >
            {total}/{budget}
          </span>
        </div>
        {over && (
          <div className="flex items-center gap-1.5 p-2 rounded-md border border-amber-500/30 bg-amber-500/5 text-amber-500 text-[11px]">
            <Zap className="w-3 h-3" />
            {s.budgetConfig.mode === "auto" ? t("budget.overAuto") : t("budget.overManual")}
          </div>
        )}
      </div>
    </div>
  );
}
