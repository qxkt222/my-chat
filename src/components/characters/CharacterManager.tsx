import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Plus, Trash2, Star, Upload, Download, Pencil, Users } from "lucide-react";
import { useCharacterStore } from "@/stores/useCharacterStore";
import { useT } from "@/lib/i18n";
import {
  pickFile,
  readFile,
  readFileBytes,
  writeFile,
  writeFileBytes,
  getAppDir,
} from "@/lib/tauri";
import { parseCharacterPng } from "@/lib/character-card";
import { showToast } from "@/components/ui/Toast";
import { CharacterEditor } from "./CharacterEditor";
import { PersonaManager } from "./PersonaManager";
import type { CharacterCard } from "@/types";

function emptyCard(): CharacterCard {
  return {
    id: crypto.randomUUID(),
    specVersion: "",
    name: "",
    description: "",
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "",
    character_version: "",
    avatarPath: "",
    created_at: "",
    updated_at: "",
  };
}

/** 角色卡管理(设置页「角色」tab,embedded):Persona 区块 + 卡片网格 + 导入导出 */
export function CharacterManager() {
  const t = useT();
  const store = useCharacterStore();
  const [editing, setEditing] = useState<CharacterCard | null>(null);
  const [isNew, setIsNew] = useState(false);

  const startNew = () => {
    setEditing(emptyCard());
    setIsNew(true);
  };
  const startEdit = (c: CharacterCard) => {
    setEditing(c);
    setIsNew(false);
  };

  const importCard = async () => {
    const path = await pickFile("角色卡", ["json", "png"]);
    if (!path) return;
    const ext = path.split(".").pop()?.toLowerCase() || "";
    try {
      if (ext === "png") {
        const b64 = await readFileBytes(path);
        const parsed = parseCharacterPng(b64);
        if (!parsed) {
          showToast("error", t("char.importFail"));
          return;
        }
        const card = await store.importCharacter(parsed.json, parsed.avatarBase64);
        if (card) showToast("success", t("char.imported", { name: card.name }));
        else showToast("error", t("char.importFail"));
      } else {
        const json = await readFile(path);
        const card = await store.importCharacter(json, null);
        if (card) showToast("success", t("char.imported", { name: card.name }));
        else showToast("error", t("char.importFail"));
      }
    } catch (e) {
      showToast("error", `${t("char.importFail")} ${String(e)}`);
    }
  };

  const exportCard = async (c: CharacterCard, asPng: boolean) => {
    try {
      const appDir = await getAppDir();
      const safe = c.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_") || "card";
      if (asPng) {
        const b64 = await store.exportCharacterPng(c.id);
        if (!b64) {
          showToast("error", t("char.exportNeedAvatar"));
          return;
        }
        await writeFileBytes(`${appDir}/exports/${safe}.png`, b64);
        showToast("success", t("char.exported", { path: `${appDir}\\exports\\${safe}.png` }));
      } else {
        const json = await store.exportCharacterJson(c.id);
        if (!json) return;
        await writeFile(`${appDir}/exports/${safe}.json`, json);
        showToast("success", t("char.exported", { path: `${appDir}\\exports\\${safe}.json` }));
      }
    } catch (e) {
      showToast("error", `${t("char.importFail")} ${String(e)}`);
    }
  };

  return (
    <div className="space-y-5">
      <PersonaManager />

      <div className="pt-3 border-t border-border">
        <div className="flex items-center gap-1.5 mb-2">
          <Users className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">{t("char.title")}</span>
          <span className="text-[10px] text-muted-foreground">{t("char.subtitle")}</span>
          <div className="flex-1" />
          <button
            onClick={importCard}
            className="px-2 py-1 text-[11px] rounded border border-input hover:bg-muted flex items-center gap-1"
          >
            <Upload className="w-3 h-3" /> {t("char.import")}
          </button>
          <button
            onClick={startNew}
            className="px-2 py-1 text-[11px] rounded bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> {t("char.new")}
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {store.characters.map((c) => (
            <div key={c.id} className="border border-border rounded-md bg-card p-2 flex gap-2">
              <div className="w-12 h-12 rounded-lg overflow-hidden bg-muted shrink-0 flex items-center justify-center">
                {c.avatarPath ? (
                  <img
                    src={convertFileSrc(c.avatarPath)}
                    alt={c.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <Users className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{c.name}</div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {c.tags.join(", ") || "—"}
                </div>
                <div className="flex gap-0.5 mt-1">
                  <button
                    onClick={() => startEdit(c)}
                    title={t("char.edit")}
                    className="p-0.5 rounded hover:bg-muted text-muted-foreground"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => store.toggleFavorite(c.id)}
                    title={t("persona.activate")}
                    className={`p-0.5 rounded ${c.favorite ? "text-yellow-400" : "text-muted-foreground hover:text-yellow-400"}`}
                  >
                    <Star className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => exportCard(c, false)}
                    title={t("char.exportJson")}
                    className="p-0.5 rounded hover:bg-muted text-muted-foreground"
                  >
                    <Download className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => store.removeCharacter(c.id)}
                    title={t("memory.delete")}
                    className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          ))}
          {store.characters.length === 0 && (
            <p className="col-span-3 text-[11px] text-muted-foreground py-4 text-center">
              {t("char.empty")}
            </p>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground mt-2">{t("char.importHint")}</p>
      </div>

      {editing && <CharacterEditor card={editing} isNew={isNew} onClose={() => setEditing(null)} />}
    </div>
  );
}
