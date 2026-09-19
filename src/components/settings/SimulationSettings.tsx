import { FlaskConical } from "lucide-react";
import { useT } from "@/lib/i18n";

/** 推演子模式设置:玩法说明与配置参考(具体配置在会话创建/会话内完成) */
export function SimulationSettings() {
  const t = useT();
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <FlaskConical className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">{t("sim.settingsTitle")}</span>
        <span className="text-[10px] text-muted-foreground">{t("sim.settingsSubtitle")}</span>
      </div>

      {/* 三种形态说明 */}
      <div className="space-y-2">
        {(["story", "sandbox", "tactical"] as const).map((type) => (
          <div key={type} className="p-2.5 border border-border rounded-md">
            <div
              className={`text-xs font-medium mb-0.5 ${
                type === "story"
                  ? "text-primary"
                  : type === "sandbox"
                    ? "text-emerald-500"
                    : "text-amber-500"
              }`}
            >
              {t(`sim.type.${type}`)}
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {t(`sim.typeDesc.${type}`)}
            </p>
          </div>
        ))}
      </div>

      {/* 三组可选配置 */}
      <div className="space-y-1.5 text-[11px] text-muted-foreground leading-relaxed">
        <p>
          <span className="text-foreground">{t("sim.settingsStateLabel")}</span>{" "}
          {t("sim.settingsStateDesc")}
        </p>
        <p>
          <span className="text-foreground">{t("sim.settingsPacingLabel")}</span>{" "}
          {t("sim.settingsPacingDesc")}
        </p>
        <p>
          <span className="text-foreground">{t("sim.settingsUpdateLabel")}</span>{" "}
          {t("sim.settingsUpdateDesc")}
        </p>
      </div>
    </div>
  );
}
