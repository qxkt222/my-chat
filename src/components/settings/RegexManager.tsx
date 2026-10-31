import { useState } from "react";
import { Wand2, Plus, Trash2, Eye, Upload } from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useT } from "@/lib/i18n";
import { applyRegexRules, type RegexRule } from "@/lib/regex-format";
import { compileRegex } from "@/lib/regex-cache";
import { looksLikeRegexSuite, parseTavernRegexSuite } from "@/lib/regex-import";
import { readFile, pickFile } from "@/lib/tauri";
import { showToast } from "@/components/ui/Toast";
import { PanelHeader } from "./PanelHeader";

/** AI 回复样式后处理(酒馆 Regex):内置规则 + 自定义,渲染前生效
 *
 *  2026-09-25 加导入：酒馆的「正则脚本套件」（JSON 数组，每项 findRegex）此前
 *  在应用里没有入口 —— 开发者把它当预设导入，被误报成「这是角色卡」。
 *  现在「样式」tab 可以直接导入，规则保留原有的 gi 标志与启用状态。 */
export function RegexManager({ onBack }: { onBack?: (() => void) | undefined }) {
  const t = useT();
  const s = useSettingsStore();
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    pattern: string;
    replacement: string;
    /** 编辑既有规则时保留原对象,提交时展开,避免丢掉 flags/enabled/placement/depth */
    base?: RegexRule | undefined;
  } | null>(null);
  const [preview, setPreview] = useState("");

  const importFromFile = async () => {
    const path = await pickFile("正则套件 JSON", ["json"]);
    if (!path) return;
    try {
      const raw = await readFile(path);
      if (!looksLikeRegexSuite(raw)) {
        showToast("error", t("regex.importFail"));
        return;
      }
      const res = parseTavernRegexSuite(raw);
      if (res.rules.length === 0) {
        showToast("error", t("regex.importFail"));
        return;
      }
      for (const rule of res.rules) await s.saveRegexRule(rule);
      showToast(
        "success",
        res.promptCount > 0
          ? t("regex.importedMixed", {
              n: String(res.rules.length),
              k: String(res.promptCount),
            })
          : t("regex.imported", { n: String(res.rules.length) })
      );
    } catch (e) {
      showToast("error", `${t("regex.importFail")} ${String(e)}`);
    }
  };

  const startNew = () =>
    setEditing({ id: "", name: "", pattern: "", replacement: "", base: undefined });
  const startEdit = (id: string) => {
    const r = s.regexRules.find((x) => x.id === id);
    if (r)
      setEditing({
        id: r.id,
        name: r.name,
        pattern: r.pattern,
        replacement: r.replacement,
        base: r,
      });
  };

  const save = async () => {
    if (!editing || !editing.pattern.trim()) return;
    // T-099:编辑既有规则必须复制原对象。旧实现固定 enabled:true 且不带 flags,
    // 编辑一条带 i 的**已禁用**规则会把它静默启用并改变大小写匹配行为。
    const rule: RegexRule = editing.base
      ? {
          ...editing.base,
          name: editing.name.trim() || editing.base.name,
          pattern: editing.pattern,
          replacement: editing.replacement,
        }
      : {
          id: editing.id || `user-${crypto.randomUUID()}`,
          name: editing.name.trim() || "自定义规则",
          pattern: editing.pattern,
          replacement: editing.replacement,
          enabled: true,
          flags: "g",
        };
    await s.saveRegexRule(rule);
    setEditing(null);
  };

  return (
    <div className="space-y-4">
      {/* 吸顶头：导入几十条正则后，下面的规则列表不会把返回/新建/导入挤走 */}
      <PanelHeader
        icon={<Wand2 className="w-4 h-4 text-primary" />}
        title={t("regex.title")}
        subtitle={t("regex.subtitle")}
        onBack={onBack}
        right={
          <>
            <button
              onClick={importFromFile}
              className="px-2 py-1 text-[11px] rounded bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1 whitespace-nowrap"
            >
              <Upload className="w-3 h-3" /> {t("regex.import")}
            </button>
            <button
              onClick={startNew}
              className="px-2 py-1 text-[11px] rounded border border-input hover:bg-muted flex items-center gap-1 whitespace-nowrap"
            >
              <Plus className="w-3 h-3" /> {t("regex.new")}
            </button>
          </>
        }
      />
      <p className="text-[10px] text-muted-foreground">{t("regex.hint")}</p>
      <p className="text-[10px] text-muted-foreground">{t("regex.hint2")}</p>

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
                // 与 applyRegexRules 保持同一口径：规则自带 flags 优先，缺省 "g"。
                // 旧实现硬编码 "g" —— 带 `i` 的导入规则预览命中数与实际替换不一致。
                const flags = r.flags || "g";
                const re = compileRegex(r.pattern, flags);
                if (!re) {
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
                // 非全局规则 String.replace 只替换第一处，计数也按 1 算（与实际行为一致）
                const hits = flags.includes("g")
                  ? (preview.match(re) || []).length
                  : re.test(preview)
                    ? 1
                    : 0;
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
              })}
          </div>
        )}
      </div>
    </div>
  );
}
