import { useState } from "react";
import { BookOpen, Plus, Trash2, Pencil, Pin, Upload, Copy } from "lucide-react";
import { useCharacterStore } from "@/stores/useCharacterStore";
import { useT } from "@/lib/i18n";
import { readFile, pickFile } from "@/lib/tauri";
import { parseCharacterJson } from "@/lib/character-card";
import { showToast } from "@/components/ui/Toast";
import type { LoreEntry, Persona } from "@/types";

interface EditEntry extends LoreEntry {
  key: string;
}

/** 世界书管理:多本 + 导入酒馆世界书 + Persona 绑定 + 单本条目编辑 */
export function LorebookManager() {
  const t = useT();
  const store = useCharacterStore();
  const [activeId, setActiveId] = useState<string>("__main__");
  const [newBookName, setNewBookName] = useState("");
  const [editing, setEditing] = useState<EditEntry | null>(null);
  const [key, setKey] = useState("");
  const [content, setContent] = useState("");
  const [constant, setConstant] = useState(false);
  const [order, setOrder] = useState(0);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [probability, setProbability] = useState(100);
  const [recursive, setRecursive] = useState(false);
  const [regexMode, setRegexMode] = useState(false);
  const [position, setPosition] = useState("before_char");

  const book = activeId === "__main__" ? store.globalLorebook : store.lorebooks[activeId];
  const bookEntries = book?.entries || [];

  const openNew = () => {
    setEditing({
      key: "",
      keys: [],
      content: "",
      constant: false,
      insertion_order: bookEntries.length,
      enabled: true,
    });
    setKey("");
    setContent("");
    setConstant(false);
    setOrder(bookEntries.length);
    setCaseSensitive(false);
    setProbability(100);
    setRecursive(false);
    setPosition("before_char");
  };
  const openEdit = (e: LoreEntry, i: number) => {
    setEditing({ ...e, key: e.keys.join(",") });
    setKey(e.keys.join(","));
    setContent(e.content);
    setConstant(!!e.constant);
    setOrder(e.insertion_order ?? i);
    setCaseSensitive(!!e.case_sensitive);
    setProbability(e.probability ?? 100);
    setRecursive(!!e.recursive);
    setRegexMode(!!e.regex);
    setPosition(e.position || "before_char");
  };

  const save = async () => {
    if (!editing) return;
    const keys = key
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const entry: LoreEntry = {
      keys,
      content,
      constant,
      insertion_order: order,
      enabled: true,
      case_sensitive: caseSensitive,
      probability,
      recursive,
      regex: regexMode,
      position,
    };
    const entries = [...bookEntries];
    if (editing.keys.length > 0 || editing.content) {
      const idx = entries.findIndex(
        (e) =>
          e.content === editing.content &&
          (e.keys.join(",") === editing.keys.join(",") || editing.keys.length === 0)
      );
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
    } else {
      entries.push(entry);
    }
    const updated = { ...book, name: book?.name || "世界书", entries };
    if (activeId === "__main__") await store.saveGlobalLorebook(updated);
    else await store.saveLorebook(activeId, updated);
    setEditing(null);
  };

  const remove = async (i: number) => {
    const entries = bookEntries.filter((_, j) => j !== i);
    const updated = { ...book, name: book?.name || "世界书", entries };
    if (activeId === "__main__") await store.saveGlobalLorebook(updated);
    else await store.saveLorebook(activeId, updated);
  };

  const importBook = async () => {
    const path = await pickFile("世界书 JSON", ["json"]);
    if (!path) return;
    try {
      const raw = await readFile(path);
      // 1) 直接是世界书
      let book = await store.importLorebook(raw);
      if (book) {
        showToast("success", t("lore.imported", { n: book.entries.length }));
        return;
      }
      // 2) 可能是角色卡(内嵌 character_book)——自动提取
      const card = parseCharacterJson(raw);
      const embedded = card?.character_book;
      if (embedded && embedded.entries.length > 0) {
        await store.saveLorebook(crypto.randomUUID(), embedded);
        showToast("success", t("lore.importedFromCard", { n: embedded.entries.length }));
        return;
      }
      showToast("error", t("lore.importFail"));
    } catch (e) {
      showToast("error", `${t("lore.importFail")} ${String(e)}`);
    }
  };

  const createBook = async () => {
    if (!newBookName.trim()) return;
    const id = crypto.randomUUID();
    await store.saveLorebook(id, { name: newBookName.trim(), entries: [] });
    setNewBookName("");
    setActiveId(id);
  };

  const deleteBook = async () => {
    if (activeId === "__main__") {
      showToast("info", t("lore.mainProtected"));
      return;
    }
    await store.removeLorebook(activeId);
    setActiveId("__main__");
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <BookOpen className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">{t("lore.title")}</span>
        <span className="text-[10px] text-muted-foreground">{t("lore.subtitle")}</span>
        <div className="flex-1" />
        <button
          onClick={importBook}
          className="px-2 py-1 text-[11px] rounded border border-input hover:bg-muted flex items-center gap-1"
        >
          <Upload className="w-3 h-3" /> {t("lore.import")}
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground">{t("lore.importHint")}</p>

      {/* 世界书列表 + 新建 + 删除;每本(除主)可勾选启用,多本同时生效 */}
      <div className="flex items-center gap-1 flex-wrap">
        <select
          value={activeId}
          onChange={(e) => setActiveId(e.target.value)}
          className="px-2 py-1 text-xs bg-background border border-input rounded max-w-[220px]"
        >
          <option value="__main__">
            {t("lore.main")} ({store.globalLorebook.entries.length})
          </option>
          {Object.entries(store.lorebooks).map(([id, b]) => (
            <option key={id} value={id}>
              {b.name || id} ({b.entries.length})
            </option>
          ))}
        </select>
        <input
          value={newBookName}
          onChange={(e) => setNewBookName(e.target.value)}
          placeholder={t("lore.newBook")}
          onKeyDown={(e) => {
            if (e.key === "Enter") void createBook();
          }}
          className="w-32 px-2 py-1 text-xs bg-background border border-input rounded"
        />
        <button
          onClick={createBook}
          className="p-1 rounded border border-input hover:bg-muted text-muted-foreground"
        >
          <Plus className="w-3 h-3" />
        </button>
        <button
          onClick={deleteBook}
          className="p-1 rounded border border-input hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
          title={t("memory.delete")}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {/* 扫描深度 / 注入预算(酒馆 scan_depth / token_budget) */}
      {book && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border bg-muted/30 text-xs">
          <span className="text-muted-foreground">{t("lore.scanDepth")}:</span>
          <input
            type="number"
            min="1"
            max="50"
            value={book.scan_depth ?? 8}
            onChange={async (e) => {
              const v = +e.target.value;
              const updated = { ...book, name: book.name || "世界书", scan_depth: v };
              if (activeId === "__main__") await store.saveGlobalLorebook(updated);
              else await store.saveLorebook(activeId, updated);
            }}
            className="w-14 px-1.5 py-0.5 bg-background border border-input rounded"
          />
          <span className="text-muted-foreground">{t("lore.tokenBudget")}:</span>
          <input
            type="number"
            min="100"
            max="10000"
            step="100"
            value={book.token_budget ?? 1500}
            onChange={async (e) => {
              const v = +e.target.value;
              const updated = { ...book, name: book.name || "世界书", token_budget: v };
              if (activeId === "__main__") await store.saveGlobalLorebook(updated);
              else await store.saveLorebook(activeId, updated);
            }}
            className="w-20 px-1.5 py-0.5 bg-background border border-input rounded"
          />
          <span className="text-[10px] text-muted-foreground">{t("lore.budgetHint")}</span>
        </div>
      )}

      {/* 已启用的独立世界书(多选;主世界书恒启用,角色内嵌书随角色) */}
      {Object.keys(store.lorebooks).length > 0 && (
        <div className="px-2 py-1.5 rounded-md border border-border bg-muted/30 text-xs">
          <div className="text-[10px] text-muted-foreground mb-1">{t("lore.enabledBooks")}</div>
          <div className="flex gap-2 flex-wrap">
            {Object.entries(store.lorebooks).map(([id, b]) => (
              <label key={id} className="flex items-center gap-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={store.enabledLorebookIds.includes(id)}
                  onChange={() => store.toggleLorebookEnabled(id)}
                  className="accent-[#1A6FB5]"
                />
                <span
                  className={
                    store.enabledLorebookIds.includes(id)
                      ? "text-primary font-medium"
                      : "text-muted-foreground"
                  }
                >
                  {b.name || id}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Persona 绑定世界书(当前激活的"我的角色"用的世界书,可多选) */}
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border bg-muted/30 text-xs">
        <Copy className="w-3.5 h-3.5 text-primary" />
        <span className="text-muted-foreground">{t("lore.personaBind")}:</span>
        {store.getActivePersona() ? (
          <div className="flex-1 flex gap-2 flex-wrap">
            {Object.keys(store.lorebooks).length === 0 && (
              <span className="text-muted-foreground">{t("lore.noBooks")}</span>
            )}
            {Object.entries(store.lorebooks).map(([id, b]) => {
              const p = store.getActivePersona();
              const on = p?.lorebookIds?.includes(id) ?? false;
              return (
                <label key={id} className="flex items-center gap-1 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={async (e) => {
                      const cur = p?.lorebookIds || [];
                      const next = e.target.checked ? [...cur, id] : cur.filter((x) => x !== id);
                      await store.savePersona({ ...(p as Persona), lorebookIds: next });
                    }}
                    className="accent-[#1A6FB5]"
                  />
                  <span className={on ? "text-primary font-medium" : "text-muted-foreground"}>
                    {b.name || id}
                  </span>
                </label>
              );
            })}
          </div>
        ) : (
          <span className="text-muted-foreground">{t("lore.personaNone")}</span>
        )}
      </div>

      {/* 条目列表 */}
      <div className="space-y-1">
        {bookEntries.map((e, i) => (
          <div
            key={i}
            className="flex items-start gap-2 px-2 py-1.5 rounded border border-border bg-card"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1 text-[11px]">
                {e.constant && <Pin className="w-3 h-3 text-primary" />}
                <span className="font-medium">{e.keys.join("、") || "—"}</span>
                <span className="text-[10px] text-muted-foreground">#{e.insertion_order ?? i}</span>
              </div>
              <p className="text-[11px] text-muted-foreground truncate">{e.content}</p>
            </div>
            <button
              onClick={() => openEdit(e, i)}
              className="p-0.5 rounded hover:bg-muted text-muted-foreground"
            >
              <Pencil className="w-3 h-3" />
            </button>
            <button
              onClick={() => void remove(i)}
              className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
        {bookEntries.length === 0 && (
          <p className="text-[11px] text-muted-foreground py-3 text-center">{t("lore.empty")}</p>
        )}
      </div>

      {/* 新建条目按钮 */}
      <button
        onClick={openNew}
        className="px-3 py-1 text-[11px] rounded bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1"
      >
        <Plus className="w-3 h-3" /> {t("lore.new")}
      </button>

      {editing && (
        <div className="p-3 rounded-md border border-border bg-muted/30 space-y-2">
          <div className="flex gap-2">
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t("lore.keys")}
              className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
            />
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground whitespace-nowrap">
              <input
                type="checkbox"
                checked={constant}
                onChange={(e) => setConstant(e.target.checked)}
              />
              {t("lore.constant")}
            </label>
            <input
              type="number"
              value={order}
              onChange={(e) => setOrder(+e.target.value)}
              title={t("lore.order")}
              className="w-14 px-2 py-1.5 text-xs bg-background border border-input rounded"
            />
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            placeholder={t("lore.content")}
            className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
          />
          {/* 酒馆高级字段:大小写敏感 / 概率 / 递归激活 / 位置 */}
          <div className="flex items-center gap-3 flex-wrap text-[11px] text-muted-foreground">
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
                className="accent-[#1A6FB5]"
              />
              {t("lore.caseSensitive")}
            </label>
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={recursive}
                onChange={(e) => setRecursive(e.target.checked)}
                className="accent-[#1A6FB5]"
              />
              {t("lore.recursive")}
            </label>
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={regexMode}
                onChange={(e) => setRegexMode(e.target.checked)}
                className="accent-[#1A6FB5]"
              />
              {t("lore.regex")}
            </label>
            <label className="flex items-center gap-1">
              {t("lore.probability")}
              <input
                type="number"
                min="0"
                max="100"
                value={probability}
                onChange={(e) => setProbability(Math.min(100, Math.max(0, +e.target.value)))}
                className="w-16 px-1.5 py-0.5 bg-background border border-input rounded"
              />
              %
            </label>
            <label className="flex items-center gap-1">
              {t("lore.position")}
              <select
                value={position}
                onChange={(e) => setPosition(e.target.value)}
                className="px-1.5 py-0.5 text-[11px] bg-background border border-input rounded"
              >
                <option value="before_char">{t("lore.positionBefore")}</option>
                <option value="after_char">{t("lore.positionAfter")}</option>
              </select>
            </label>
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
              disabled={!content.trim() || (key.trim() === "" && !constant)}
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
