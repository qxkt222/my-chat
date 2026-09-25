import { useState } from "react";
import {
  Wrench,
  Plus,
  Trash2,
  Upload,
  Eye,
  X,
  Save,
  Check,
  ArrowLeft,
  ChevronUp,
  ChevronDown,
  AlertTriangle,
} from "lucide-react";
import { useCharacterStore } from "@/stores/useCharacterStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useT } from "@/lib/i18n";
import { readFile, pickFile } from "@/lib/tauri";
import { parseLorebook } from "@/lib/lorebook-import";
import { parseCharacterJson } from "@/lib/character-card";
import { showToast } from "@/components/ui/Toast";
import { budgetFor } from "@/lib/context-budget";
import { countTokens } from "@/lib/token-counter";
import {
  charCount,
  enabledCharTotal,
  enabledCount,
  emptyRosterIndex,
  isEntryEnabled,
  splitByGroup,
} from "@/lib/preset-roster";
import type { PromptPreset } from "@/types";

/** 提示词预设管理 —— **全局条目名册**（2026-09-25 改造）
 *
 *  与旧版的根本差别：启用单位从「一套预设（角色卡绑一个）」变成「名册里逐条开关」。
 *  开关与顺序都是**全局**的、与角色无关 —— 开发者原话：
 *  「它是通用的，就像酒馆里面那个一样，它与角色的状态无关，
 *    角色状态应该是由角色自己的提示词以及世界书决定」。
 *
 *  已启用的条目按 order 升序拼成实际提示词（见 lib/preset-roster.ts 的 assembleRoster）；
 *  一条都没启用时，发送链路回退到角色卡绑定的单套预设。
 *
 *  还有一条历史包袱：项目里那个「返回」曾经接到 onClose，把整个设置弹窗关掉了，
 *  开发者原话「我点了是退出弹窗反而不是回到当初的设置那一筐」。现在接的是 onBack。 */
export function PresetManager({ onBack }: { onBack?: (() => void) | undefined }) {
  const t = useT();
  const store = useCharacterStore();
  const settings = useSettingsStore();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTemplate, setNewTemplate] = useState("");
  // 查看/编辑条目(点预设展开;自定义可改,内置只读)
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editTemplate, setEditTemplate] = useState("");

  // 预算：与发送链路同源（当前模型 × 使用率），超限只标红不拦。
  // 模型取全局 activeModel —— 会话级覆盖由会话自己管，这里只是给个数量级参考。
  const model = settings.models.find((m) => m.name === settings.activeModel);
  const budget = budgetFor(model, settings.budgetConfig);

  const groups = splitByGroup(store.presets, store.rosterIndex ?? emptyRosterIndex());
  // 用 token 口径与预算比较（countTokens 与 countTokens 同源）；字数另列供直观参考
  const enabledTokens = store.presets
    .filter(isEntryEnabled)
    .reduce((s, p) => s + countTokens(p.template), 0);
  const overBudget = enabledTokens > budget;

  /** 切换某条是否参与拼装（全局开关，不碰角色卡） */
  const toggle = (p: PromptPreset) => {
    void store.togglePresetEnabled(p.id);
  };

  const openPreset = (p: PromptPreset) => {
    setEditId(p.id);
    setEditName(p.name);
    setEditTemplate(p.template);
  };

  const saveEdit = async () => {
    if (!editId || !editName.trim() || !editTemplate.trim()) return;
    const cur = store.presets.find((p) => p.id === editId);
    if (!cur) return;
    await store.savePreset({
      ...cur,
      name: editName.trim(),
      template: editTemplate,
      description: cur.description,
    });
    setEditId(null);
    showToast("success", t("preset.saved"));
  };

  const importFromFile = async () => {
    const path = await pickFile("预设 JSON", ["json"]);
    if (!path) return;
    try {
      const raw = await readFile(path);
      const n = await store.importPresets(raw);
      if (n > 0) {
        showToast("success", t("preset.imported", { n }));
        return;
      }
      // 不是预设:自动识别文件类型,避免放错 tab 干瞪眼
      const lore = parseLorebook(raw);
      if (lore) {
        await store.importLorebook(raw);
        showToast("info", t("preset.isLorebook"));
        return;
      }
      const card = parseCharacterJson(raw);
      if (card) {
        showToast("info", t("preset.isCharacter"));
        return;
      }
      showToast("error", t("preset.importFail"));
    } catch (e) {
      showToast("error", `${t("preset.importFail")} ${String(e)}`);
    }
  };

  const createCustom = async () => {
    if (!newName.trim() || !newTemplate.trim()) return;
    await store.savePreset({
      id: `custom-${crypto.randomUUID()}`,
      name: newName.trim(),
      is_preset: false,
      description: "自定义预设",
      template: newTemplate,
      created_at: new Date().toISOString(),
    });
    setShowNew(false);
    setNewName("");
    setNewTemplate("");
    showToast("success", t("preset.saved"));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <Wrench className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">{t("preset.title")}</span>
        <span className="text-[10px] text-muted-foreground">{t("preset.subtitle")}</span>
        <div className="flex-1" />
        {onBack && (
          <button
            onClick={onBack}
            className="px-2.5 py-1 text-[11px] rounded border border-input hover:bg-muted flex items-center gap-1"
            title={t("preset.back")}
          >
            <ArrowLeft className="w-3 h-3" /> {t("preset.back")}
          </button>
        )}
        <button
          onClick={() => setShowNew(!showNew)}
          className="px-2 py-1 text-[11px] rounded border border-input hover:bg-muted flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> {t("preset.new")}
        </button>
        <button
          onClick={importFromFile}
          className="px-2 py-1 text-[11px] rounded bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1"
        >
          <Upload className="w-3 h-3" /> {t("preset.import")}
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground">{t("preset.importHint")}</p>

      {showNew && (
        <div className="p-3 rounded-md border border-border bg-muted/30 space-y-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("preset.name")}
            className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
          />
          <textarea
            value={newTemplate}
            onChange={(e) => setNewTemplate(e.target.value)}
            rows={5}
            placeholder={t("preset.templatePlaceholder")}
            className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowNew(false)}
              className="px-3 py-1 text-xs rounded border border-input hover:bg-muted"
            >
              {t("settings.cancel")}
            </button>
            <button
              onClick={createCustom}
              disabled={!newName.trim() || !newTemplate.trim()}
              className="px-3 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              {t("settings.save")}
            </button>
          </div>
        </div>
      )}

      {/* 预算条：已启用合计 vs 上下文预算。超了**只标红提醒，不拦发送**
          （开发者 2026-09-25 选定：「显示字数 + 超了提醒，但不阻止」）。 */}
      <div
        className={`flex items-center gap-2 px-2 py-1.5 rounded border text-[10px] ${
          overBudget
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "border-border bg-muted/30 text-muted-foreground"
        }`}
      >
        <span>
          {t("preset.enabledSummary", {
            n: String(enabledCount(store.presets)),
            chars: String(enabledCharTotal(store.presets)),
            tokens: String(enabledTokens),
            budget: String(budget),
          })}
        </span>
        {overBudget && (
          <span className="flex items-center gap-1 font-medium">
            <AlertTriangle className="w-3 h-3" /> {t("preset.overBudget")}
          </span>
        )}
      </div>

      {groups.map((g) => {
        const groupEnabled = g.entries.filter(isEntryEnabled).length;
        return (
          <div key={g.key} className="border border-border rounded-md overflow-hidden">
            {/* 包头：包名 + 该包启用数 + 整包开/关 */}
            <div className="flex items-center gap-2 px-2 py-1.5 bg-muted/40">
              <span className="text-[11px] font-semibold truncate">{g.label}</span>
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                {t("preset.groupCount", {
                  on: String(groupEnabled),
                  all: String(g.entries.length),
                })}
              </span>
              <div className="flex-1" />
              <button
                onClick={() => {
                  // 整包开/关：只在需要翻转的条目上动手，避免无谓落盘
                  for (const e of g.entries) {
                    if (isEntryEnabled(e) !== (groupEnabled !== g.entries.length)) continue;
                    toggle(e);
                  }
                }}
                className="px-2 py-0.5 text-[10px] rounded border border-input hover:bg-muted whitespace-nowrap"
              >
                {groupEnabled === g.entries.length ? t("preset.groupOff") : t("preset.groupOn")}
              </button>
            </div>

            <div className="divide-y divide-border">
              {g.entries.map((p, idx) => {
                const on = isEntryEnabled(p);
                return (
                  <div key={p.id}>
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      {/* 上下移：包内调顺序，决定拼装先后 */}
                      <div className="flex flex-col">
                        <button
                          onClick={() => void store.movePresetInGroup(p.id, -1)}
                          disabled={idx === 0}
                          className="p-0.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-20"
                          title={t("preset.moveUp")}
                        >
                          <ChevronUp className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => void store.movePresetInGroup(p.id, 1)}
                          disabled={idx === g.entries.length - 1}
                          className="p-0.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-20"
                          title={t("preset.moveDown")}
                        >
                          <ChevronDown className="w-3 h-3" />
                        </button>
                      </div>

                      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openPreset(p)}>
                        <div className="text-xs font-medium">
                          {p.name}{" "}
                          {p.is_preset && (
                            <span className="text-[9px] text-muted-foreground">
                              {t("preset.builtinTag")}
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground truncate">
                          {p.description}
                          {" · "}
                          <span className="whitespace-nowrap">
                            {t("preset.charCount", { n: String(charCount(p)) })}
                          </span>
                        </p>
                      </div>

                      {/* 全局开关（可开可关）——不再绑角色卡 */}
                      <button
                        onClick={() => toggle(p)}
                        className={`px-2 py-0.5 text-[10px] rounded border flex items-center gap-1 whitespace-nowrap ${
                          on
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-input text-muted-foreground hover:bg-muted"
                        }`}
                        title={on ? t("preset.active") : t("preset.activate")}
                      >
                        {on ? <Check className="w-3 h-3" /> : null}
                        {on ? t("preset.active") : t("preset.activate")}
                      </button>
                      <button
                        onClick={() => openPreset(p)}
                        className="p-0.5 rounded hover:bg-muted text-muted-foreground"
                        title={t("preset.view")}
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      {!p.is_preset && (
                        <button
                          onClick={() => store.removePreset(p.id)}
                          className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    {/* 展开查看/编辑条目(自定义可改,内置只读) */}
                    {editId === p.id && (
                      <div className="px-2 pb-2 space-y-1.5 border-t border-border pt-1.5">
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder={t("preset.name")}
                          readOnly={p.is_preset}
                          className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
                        />
                        <textarea
                          value={editTemplate}
                          onChange={(e) => setEditTemplate(e.target.value)}
                          rows={8}
                          readOnly={p.is_preset}
                          placeholder={t("preset.templatePlaceholder")}
                          className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded resize-none font-mono"
                        />
                        <div className="flex justify-end gap-2">
                          {!p.is_preset && (
                            <button
                              onClick={saveEdit}
                              disabled={!editName.trim() || !editTemplate.trim()}
                              className="px-2.5 py-1 text-[11px] rounded bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-1"
                            >
                              <Save className="w-3 h-3" /> {t("settings.save")}
                            </button>
                          )}
                          <button
                            onClick={() => setEditId(null)}
                            className="px-2.5 py-1 text-[11px] rounded border border-input hover:bg-muted text-muted-foreground flex items-center gap-1"
                          >
                            <X className="w-3 h-3" /> {t("preset.collapse")}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
