import { TrendingUp, Trash2 } from "lucide-react";
import { useCacheStatsStore } from "@/stores/useCacheStatsStore";
import { useT } from "@/lib/i18n";

/** DeepSeek 缓存诊断面板:平均命中率 + 最近趋势 + 结构提示(验证三段式优化) */
export function CacheManager() {
  const t = useT();
  const store = useCacheStatsStore();
  const avg = store.avgRate();
  const recent = store.records.slice(-20);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <TrendingUp className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">{t("cache.title")}</span>
        <span className="text-[10px] text-muted-foreground">{t("cache.subtitle")}</span>
        <div className="flex-1" />
        <button
          onClick={store.clear}
          className="px-2 py-1 text-[11px] rounded border border-input hover:bg-muted flex items-center gap-1"
        >
          <Trash2 className="w-3 h-3" /> {t("cache.clear")}
        </button>
      </div>

      {/* 平均命中率大数字 */}
      <div className="p-4 rounded-lg border border-primary/30 bg-primary/5 text-center">
        <div className="text-4xl font-bold text-primary">{avg == null ? "—" : `${avg}%`}</div>
        <div className="text-[11px] text-muted-foreground mt-1">
          {avg == null ? t("cache.noData") : t("cache.avg", { n: store.records.length })}
        </div>
      </div>

      {/* 最近 20 次趋势 */}
      <div>
        <div className="text-[10px] text-[#8899A6] uppercase tracking-[0.6px] mb-1">
          {t("cache.trend")}
        </div>
        {recent.length === 0 ? (
          <p className="text-xs text-muted-foreground py-3 text-center">{t("cache.noData")}</p>
        ) : (
          <div className="space-y-0.5">
            {recent.map((r, i) => {
              const rate = Math.round((r.hit / (r.hit + r.miss)) * 100);
              return (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="w-24 text-muted-foreground truncate shrink-0">{r.model}</span>
                  <div className="flex-1 h-3 bg-muted rounded overflow-hidden">
                    <div className="h-full bg-primary" style={{ width: `${rate}%` }} />
                  </div>
                  <span
                    className={`w-12 text-right shrink-0 ${rate >= 80 ? "text-green-600" : rate >= 50 ? "text-amber-600" : "text-red-600"}`}
                  >
                    {rate}%
                  </span>
                  <span className="w-24 text-right text-muted-foreground shrink-0">
                    {new Date(r.ts).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 结构提示 */}
      <div className="p-3 rounded-md border border-border bg-muted/30 text-[11px] text-muted-foreground space-y-1">
        <div className="font-medium text-foreground">{t("cache.tipsTitle")}</div>
        <p>• {t("cache.tip1")}</p>
        <p>• {t("cache.tip2")}</p>
        <p>• {t("cache.tip3")}</p>
      </div>
    </div>
  );
}
