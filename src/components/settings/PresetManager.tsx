import { useState } from "react";
import { Wrench, Plus, Trash2, Upload, Eye, X, Save, Check, ArrowLeft } from "lucide-react";
import { useCharacterStore } from "@/stores/useCharacterStore";
import { useTavernStore } from "@/stores/useTavernStore";
import { useT } from "@/lib/i18n";
import { readFile, pickFile } from "@/lib/tauri";
import { parseLorebook } from "@/lib/lorebook-import";
import { parseCharacterJson } from "@/lib/character-card";
import { showToast } from "@/components/ui/Toast";
import type { PromptPreset } from "@/types";

/** 提示词预设管理:导入酒馆预设(单条或 Freaky 完整导出)+ 列表 + 查看/编辑 + 删除 + 启用
 *
 *  2026-09-25 开发者反馈两件事,这里都兑现了：
 *   1.「预设没有单独启用按钮，不能决定启用什么预设」—— 原先「启用」只能去角色编辑器
 *      的下拉里选(CharacterEditor)，这一页只有眼睛和垃圾桶。现在每行有「启用」，
 *      作用对象是**当前角色卡**(prompt_preset_id 就存在角色卡上)，点一下即切换。
 *   2.「找不到退出键」—— 页顶给了一个一直看得见的「返回」。
 *
 *  注：本轮只做到「一套预设生效」(角色卡绑一个)。酒馆那种「同一预设内多条目各自开关、
 *  叠加生效」是另一套数据模型(需要条目分组 + 多选拼装)，未在本轮范围内。 */
export function PresetManager({ onClose }: { onClose?: (() => void) | undefined }) {
  const t = useT();
  const store = useCharacterStore();
  const tavern = useTavernStore();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTemplate, setNewTemplate] = useState("");
  // 查看/编辑条目(点预设展开;自定义可改,内置只读)
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editTemplate, setEditTemplate] = useState("");

  // 当前生效的预设 id —— 存在**当前酒馆会话的角色卡**上（字段名 presetId）。
  // 空表示回落经典 Chat，与酒馆发送链路的兜底（card.presetId || "preset-classic-char"）一致。
  const activeCard = (() => {
    const conv = tavern.getActive();
    return conv ? (store.characters.find((c) => c.id === conv.character_id) ?? null) : null;
  })();
  const activePresetId = activeCard?.presetId || "preset-classic-char";

  /** 把某套预设设为当前角色卡生效 —— 与角色编辑器里那个下拉是同一个字段 presetId */
  const activatePreset = async (p: PromptPreset) => {
    if (!activeCard) {
      showToast("info", t("preset.needCard"));
      return;
    }
    await store.saveCharacter({ ...activeCard, presetId: p.id });
    showToast("success", t("preset.activated", { name: p.name }));
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
        {onClose && (
          <button
            onClick={onClose}
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

      <div className="space-y-1">
        {store.presets.map((p) => {
          const isActive = p.id === activePresetId;
          return (
            <div key={p.id} className="border border-border rounded-md bg-card">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openPreset(p)}>
                  <div className="text-xs font-medium">
                    {p.name}{" "}
                    {p.is_preset && (
                      <span className="text-[9px] text-muted-foreground">(内置)</span>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground truncate">{p.description}</p>
                </div>
                <button
                  onClick={() => void activatePreset(p)}
                  className={`px-2 py-0.5 text-[10px] rounded border flex items-center gap-1 whitespace-nowrap ${
                    isActive
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-input text-muted-foreground hover:bg-muted"
                  }`}
                  title={isActive ? t("preset.active") : t("preset.activate")}
                >
                  {isActive ? <Check className="w-3 h-3" /> : null}
                  {isActive ? t("preset.active") : t("preset.activate")}
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
                      <X className="w-3 h-3" /> {t("settings.cancel")}
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
}
