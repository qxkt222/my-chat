import { useState } from "react";
import { Plus, Trash2, Brain, Save } from "lucide-react";
import { useMemoryStore } from "@/stores/useMemoryStore";
import { useT } from "@/lib/i18n";

/** 白盒记忆管理：结构化、可编辑、可启停、带标签（发送时按标签注入） */
export function MemoryManager() {
  const t = useT();
  const memory = useMemoryStore();
  const [content, setContent] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [editId, setEditId] = useState<string | null>(null);

  const parseTags = (s: string): string[] =>
    s
      .split(/[,，\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);

  const submit = async () => {
    if (!content.trim()) return;
    const tags = parseTags(tagsText);
    if (editId) {
      const m = memory.memories.find((x) => x.id === editId);
      if (m)
        await memory.save({
          ...m,
          content: content.trim(),
          tags,
          updated_at: new Date().toISOString(),
        });
    } else {
      await memory.create(content.trim(), tags);
    }
    setContent("");
    setTagsText("");
    setEditId(null);
  };

  const openEdit = (id: string) => {
    const m = memory.memories.find((x) => x.id === id);
    if (!m) return;
    setEditId(id);
    setContent(m.content);
    setTagsText(m.tags.join(", "));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <Brain className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">{t("memory.title")}</span>
        <span className="text-[10px] text-muted-foreground">{t("memory.subtitle")}</span>
      </div>

      {/* 新增 / 编辑 */}
      <div className="space-y-1.5">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          placeholder={t("memory.contentPlaceholder")}
          className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
        />
        <input
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder={t("memory.tagsPlaceholder")}
          className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
        />
        <button
          onClick={submit}
          disabled={!content.trim()}
          className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 flex items-center gap-1 disabled:opacity-40"
        >
          {editId ? <Save className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}{" "}
          {editId ? t("memory.saveEdit") : t("memory.add")}
        </button>
      </div>

      {/* 列表 */}
      <div className="space-y-1.5">
        {memory.memories.length === 0 && (
          <p className="text-[11px] text-muted-foreground">{t("memory.empty")}</p>
        )}
        {memory.memories.map((m) => (
          <div
            key={m.id}
            className="flex items-start gap-2 p-2.5 border border-border rounded-md bg-card"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    memory.save({ ...m, enabled: !m.enabled });
                  }}
                  className={`text-[10px] px-1.5 py-0.5 rounded-full ${m.enabled ? "bg-green-500/20 text-green-500" : "bg-muted text-muted-foreground"}`}
                >
                  {m.enabled ? t("memory.enabled") : t("memory.disabled")}
                </button>
                <div className="flex gap-1 flex-wrap">
                  {m.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
              <p className="text-xs mt-1.5 whitespace-pre-wrap break-words text-foreground/90">
                {m.content}
              </p>
            </div>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => openEdit(m.id)}
                className="p-1 rounded hover:bg-muted text-muted-foreground"
                title={t("memory.edit")}
              >
                <Save className="w-3 h-3" />
              </button>
              <button
                onClick={() => memory.remove(m.id)}
                className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                title={t("memory.delete")}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
