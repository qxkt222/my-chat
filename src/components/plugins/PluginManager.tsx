import { useEffect } from "react";
import { ToggleLeft, ToggleRight, Puzzle } from "lucide-react";
import { usePluginStore } from "@/stores/usePluginStore";
import { useT } from "@/lib/i18n";

export function PluginManager() {
  const t = useT();
  const plugins = usePluginStore((s) => s.plugins);
  const load = usePluginStore((s) => s.load);
  const toggle = usePluginStore((s) => s.toggle);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Puzzle className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold">{t("plugins.title")}</h3>
        <span className="text-xs text-muted-foreground">({plugins.length})</span>
      </div>
      {plugins.length === 0 && (
        <p className="text-xs text-muted-foreground py-8 text-center">{t("plugins.empty")}</p>
      )}
      <div className="space-y-2">
        {plugins.map((p) => (
          <div
            key={p.manifest.id}
            className={`flex items-center justify-between p-3 border rounded-md ${p.enabled ? "border-primary/30 bg-primary/5" : "border-border bg-card"}`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{p.manifest.name}</span>
                <span className="text-[10px] text-muted-foreground">v{p.manifest.version}</span>
                {p.enabled && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-green-500/20 text-green-500 rounded-full">
                    {t("plugins.active")}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {p.manifest.description}
              </p>
            </div>
            <div className="flex items-center gap-1 ml-3">
              <button
                onClick={() => toggle(p.manifest.id)}
                className={`p-1.5 rounded ${p.enabled ? "text-green-500 hover:bg-green-500/10" : "text-muted-foreground hover:bg-muted"}`}
              >
                {p.enabled ? (
                  <ToggleRight className="w-5 h-5" />
                ) : (
                  <ToggleLeft className="w-5 h-5" />
                )}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
