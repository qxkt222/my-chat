import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { UserRound, Plus, Trash2, Star, ImagePlus } from "lucide-react";
import { useCharacterStore } from "@/stores/useCharacterStore";
import { useT } from "@/lib/i18n";
import { pickFile, readFileBytes, writeFileBytes, getAppDir } from "@/lib/tauri";
import type { Persona } from "@/types";

/** 用户自己的角色扮演(酒馆 Persona):多 persona + 头像 + 全局激活 */
export function PersonaManager() {
  const t = useT();
  const store = useCharacterStore();
  const [editing, setEditing] = useState<Persona | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");

  const openNew = () => {
    setEditing({ id: "", name: "", description: "", avatarPath: "", created_at: "" });
    setName("");
    setDesc("");
  };
  const openEdit = (p: Persona) => {
    setEditing(p);
    setName(p.name);
    setDesc(p.description);
  };

  const save = async () => {
    if (!editing || !name.trim()) return;
    if (editing.id) {
      await store.savePersona({ ...editing, name: name.trim(), description: desc.trim() });
    } else {
      await store.createPersona(name.trim(), desc.trim());
    }
    setEditing(null);
  };

  const setAvatar = async (p: Persona) => {
    const path = await pickFile("图片", ["png", "jpg", "jpeg", "webp"]);
    if (!path) return;
    const b64 = await readFileBytes(path);
    const appDir = await getAppDir();
    const avatarPath = `${appDir}/characters/avatars/persona-${p.id}.png`;
    await writeFileBytes(avatarPath, b64);
    await store.savePersona({ ...p, avatarPath });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <UserRound className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">{t("persona.title")}</span>
        <span className="text-[10px] text-muted-foreground">{t("persona.subtitle")}</span>
        <div className="flex-1" />
        <button
          onClick={openNew}
          className="px-2 py-1 text-[11px] rounded border border-input hover:bg-muted flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> {t("persona.new")}
        </button>
      </div>

      <div className="flex gap-2 flex-wrap">
        {store.personas.map((p) => (
          <div
            key={p.id}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-md border text-xs ${store.activePersonaId === p.id ? "border-primary bg-primary/10" : "border-border bg-card"}`}
          >
            <button
              onClick={() => setAvatar(p)}
              title={t("persona.avatar")}
              className="w-6 h-6 rounded-full overflow-hidden bg-muted shrink-0 flex items-center justify-center hover:opacity-80"
            >
              {p.avatarPath ? (
                <img
                  src={convertFileSrc(p.avatarPath)}
                  alt={p.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <ImagePlus className="w-3 h-3 text-muted-foreground" />
              )}
            </button>
            <div className="min-w-0">
              <div className="font-medium truncate max-w-[120px]">{p.name}</div>
              <div className="text-[10px] text-muted-foreground truncate max-w-[120px]">
                {p.description || "—"}
              </div>
            </div>
            <button
              onClick={() => store.setActivePersona(p.id)}
              title={t("persona.activate")}
              className={`p-0.5 rounded ${store.activePersonaId === p.id ? "text-yellow-400" : "text-muted-foreground hover:text-yellow-400"}`}
            >
              <Star className="w-3 h-3" />
            </button>
            <button
              onClick={() => openEdit(p)}
              title={t("memory.edit")}
              className="p-0.5 rounded hover:bg-muted text-muted-foreground"
            >
              <span className="text-[10px]">✎</span>
            </button>
            <button
              onClick={() => store.removePersona(p.id)}
              title={t("memory.delete")}
              className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
        {store.personas.length === 0 && (
          <p className="text-[11px] text-muted-foreground">{t("persona.empty")}</p>
        )}
      </div>

      {editing && (
        <div className="mt-2 p-3 rounded-md border border-border bg-muted/30 space-y-2">
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("persona.name")}
              className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
            />
          </div>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={3}
            placeholder={t("persona.descPlaceholder")}
            className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setEditing(null)}
              className="px-3 py-1 text-xs rounded border border-input hover:bg-muted"
            >
              {t("settings.cancel")}
            </button>
            <button
              onClick={save}
              disabled={!name.trim()}
              className="px-3 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              {t("settings.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
