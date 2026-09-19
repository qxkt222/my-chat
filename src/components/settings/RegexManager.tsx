import { useState } from "react";
import { Wand2, Plus, Trash2, Eye } from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useT } from "@/lib/i18n";
import { applyRegexRules } from "@/lib/regex-format";

/** AI 回复样式后处理(酒馆 Regex):内置规则 + 自定义,渲染前生效 */
export function RegexManager() {
  const t = useT();
  const s = useSettingsStore();
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    pattern: string;
    replacement: string;
  } | null>(null);
  const [preview, setPreview] = useState("");

  const startNew = () => setEditing({ id: "", name: "", pattern: "", replacement: "" });
  const startEdit = (id: string) => {
    const r = s.regexRules.find((x) => x.id === id);
    if (r) setEditing({ id: r.id, name: r.name, pattern: r.pattern, replacement: r.replacement });
  };

  const save = async () => {
    if (!editing || !editing.pattern.trim()) return;
    await s.saveRegexRule({
      id: editing.id || `user-${crypto.randomUUID()}`,
      name: editing.name.trim() || "自定义规则",
      pattern: editing.pattern,
      replacement: editing.replacement,
      enabled: true,
    });
    setEditing(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <Wand2 className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">{t("regex.title")}</span>
        <span className="text-[10px] text-muted-foreground">{t("regex.subtitle")}</span>
        <div className="flex-1" />
        <button
          onClick={startNew}
          className="px-2 py-1 text-[11px] rounded border border-input hover:bg-muted flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> {t("regex.new")}
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground">{t("regex.hint")}</p>

      {/* 规则列表 */}
      <div className="space-y-1">
        {s.regexRules.map((r) => (
          <div
            key={r.id}
            className="flex items-center gap-2 px-2 py-1.5 rounded border border-border bg-card text-xs"
          >
            <input
              type="checkbox"
              checked={r.enabled}
              onChange={() => s.toggleRegexRule(r.id)}
              className="accent-[#1A6FB5]"
            />
            <span
              className={`font-medium ${r.enabled ? "" : "line-through text-muted-foreground"}`}
            >
              {r.name}
            </span>
            <code className="text-[10px] text-muted-foreground truncate flex-1">{r.pattern}</code>
            <button
              onClick={() => startEdit(r.id)}
              className="p-0.5 rounded hover:bg-muted text-muted-foreground"
            >
              <Eye className="w-3 h-3" />
            </button>
            {!r.id.startsWith("regex-") && (
              <button
                onClick={() => s.removeRegexRule(r.id)}
                className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* 编辑 */}
      {editing && (
        <div className="p-3 rounded-md border border-border bg-muted/30 space-y-2">
          <div className="flex gap-2">
            <input
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder={t("regex.name")}
              className="w-36 px-2 py-1.5 text-xs bg-background border border-input rounded"
            />
            <input
              value={editing.pattern}
              onChange={(e) => setEditing({ ...editing, pattern: e.target.value })}
              placeholder={t("regex.pattern")}
              className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded font-mono"
            />
            <input
              value={editing.replacement}
              onChange={(e) => setEditing({ ...editing, replacement: e.target.value })}
              placeholder={t("regex.replacement")}
              className="w-36 px-2 py-1.5 text-xs bg-background border border-input rounded font-mono"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setEditing(null)}
              className="px-3 py-1 text-xs rounded border border-input hover:bg-muted"
            >
              {t("settings.cancel")}
            </button>
            <button
              onClick={save}
              disabled={!editing.pattern.trim()}
              className="px-3 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              {t("settings.save")}
            </button>
          </div>
        </div>
      )}

      {/* 实时预览 */}
      <div className="pt-2 border-t border-border space-y-2">
        <span className="text-[11px] text-muted-foreground">{t("regex.preview")}</span>
        <textarea
          value={preview}
          onChange={(e) => setPreview(e.target.value)}
          rows={4}
          placeholder="(OOC: 这是作者旁白) *她微笑着说* (JUST TESTING)"
          className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
        />
        {preview.trim() && (
          <div className="p-2 rounded bg-muted text-xs whitespace-pre-wrap">
            <span className="text-[10px] text-primary block mb-1">{t("regex.result")}:</span>
            {applyRegexRules(
              preview,
              s.regexRules.filter((r) => r.enabled)
            )}
          </div>
        )}
        {/* 逐规则命中指示(34):哪些规则命中、替换了几处——可视化调试 */}
        {preview.trim() && (
          <div className="flex flex-wrap gap-1">
            {s.regexRules
              .filter((r) => r.enabled)
              .map((r) => {
                try {
                  const re = new RegExp(r.pattern, "g");
                  const hits = (preview.match(re) || []).length;
                  return (
                    <span
                      key={r.id}
                      className={`text-[9px] px-1.5 py-px rounded-full ${
                        hits > 0
                          ? "bg-emerald-500/15 text-emerald-500"
                          : "bg-muted text-muted-foreground/60"
                      }`}
                      title={r.pattern}
                    >
                      {r.name} ×{hits}
                    </span>
                  );
                } catch {
                  return (
                    <span
                      key={r.id}
                      className="text-[9px] px-1.5 py-px rounded-full bg-destructive/15 text-destructive"
                      title={r.pattern}
                    >
                      {r.name} ⚠
                    </span>
                  );
                }
              })}
          </div>
        )}
      </div>
    </div>
  );
}
