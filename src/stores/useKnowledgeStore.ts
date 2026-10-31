import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { KnowledgeBase, KnowledgeFile } from "@/types";
import { getAppDir, readFile, writeFile, listDir, createDir, deleteItem } from "@/lib/tauri";

/** 知识源元数据 localStorage key(认证/新鲜度徽标) */
const KB_META_KEY = "kb_meta";

/** 可直接当文本编辑/参与上下文的扩展名(与历史 loadFiles 白名单一致) */
const TEXT_FILE_EXT = ["txt", "md", "json"];

/**
 * T-017：导入文件的落盘名。
 *
 * 导入 PDF/DOCX/图片时，提取出的文本统一存为 `<原文件名>.txt`
 * （如 `report.pdf.txt`）——列表只读文本文件，原名落盘会让条目从 UI 消失。
 * 本身就是 txt/md/json 的文件保持原名。
 */
export function knowledgeStoredName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_FILE_EXT.includes(ext) ? name : `${name}.txt`;
}

interface KnowledgeState {
  bases: KnowledgeBase[];
  activeBaseId: string | null;
  files: KnowledgeFile[];
  loaded: boolean;

  load: () => Promise<void>;
  createBase: (name: string, description: string) => Promise<KnowledgeBase>;
  removeBase: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  loadFiles: (baseId: string) => Promise<void>;
  saveFile: (baseId: string, name: string, content: string) => Promise<void>;
  deleteFile: (baseId: string, name: string) => Promise<void>;
  getContext: (baseId: string) => Promise<string>;
  /** 知识源认证/新鲜度元数据 */
  setKbMeta: (id: string, meta: NonNullable<KnowledgeBase["meta"]>) => void;
}

/** 读取全部知识源元数据(JSON) */
function loadKbMeta(): Record<string, NonNullable<KnowledgeBase["meta"]>> {
  try {
    return JSON.parse(localStorage.getItem(KB_META_KEY) || "{}") as Record<
      string,
      NonNullable<KnowledgeBase["meta"]>
    >;
  } catch {
    return {};
  }
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  bases: [],
  activeBaseId: null,
  files: [],
  loaded: false,

  load: async () => {
    try {
      const appDir = await getAppDir();
      const dirs = await listDir(`${appDir}/knowledge`);
      const meta = loadKbMeta();
      const bases: KnowledgeBase[] = [];
      for (const d of dirs) {
        const m = meta[d];
        const base: KnowledgeBase = {
          id: d,
          name: d,
          description: "",
          created_at: "",
        };
        if (m) base.meta = m;
        bases.push(base);
      }
      set({ bases, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  createBase: async (name, description) => {
    const appDir = await getAppDir();
    await createDir(`${appDir}/knowledge/${name}`);
    const base: KnowledgeBase = {
      id: name,
      name,
      description,
      created_at: new Date().toISOString(),
    };
    set((s) => ({ bases: [...s.bases, base] }));
    return base;
  },

  removeBase: async (id) => {
    // F3 真删除：递归删除整个知识库目录（旧实现写空文件会残留）
    const appDir = await getAppDir();
    try {
      await deleteItem(`${appDir}/knowledge/${id}`);
    } catch {
      /* ignore */
    }
    set((s) => ({
      bases: s.bases.filter((b) => b.id !== id),
      activeBaseId: s.activeBaseId === id ? null : s.activeBaseId,
    }));
  },

  setActive: (id) => {
    set({ activeBaseId: id });
    if (id) get().loadFiles(id);
  },

  setKbMeta: (id, meta) => {
    const all = loadKbMeta();
    all[id] = meta;
    localStorage.setItem(KB_META_KEY, JSON.stringify(all));
    set((s) => ({
      bases: s.bases.map((b) => (b.id === id ? { ...b, meta } : b)),
    }));
  },

  loadFiles: async (baseId) => {
    const appDir = await getAppDir();
    try {
      const names = await listDir(`${appDir}/knowledge/${baseId}`);
      const files: KnowledgeFile[] = [];
      for (const name of names) {
        // T-017：列出目录里的全部文件，不再只认 txt/md/json。
        // 旧版本导入的 `report.pdf`（内容其实是提取出的文本）以及任何
        // 读不出内容的历史文件都必须可见、可删除，不能从 UI 静默消失。
        let content = "";
        try {
          content = await readFile(`${appDir}/knowledge/${baseId}/${name}`);
        } catch {
          /* 读不出内容仍保留条目（空内容），留给用户删除 */
        }
        files.push({ name, content });
      }
      set({ files });
    } catch {
      set({ files: [] });
    }
  },

  saveFile: async (baseId, name, content) => {
    const appDir = await getAppDir();
    await writeFile(`${appDir}/knowledge/${baseId}/${name}`, content);
    set((s) => ({
      files: s.files.some((f) => f.name === name)
        ? s.files.map((f) => (f.name === name ? { name, content } : f))
        : [...s.files, { name, content }],
    }));
  },

  deleteFile: async (baseId, name) => {
    // T-016：先删 sled 里的 chunks，再删磁盘文件。
    // 顺序不能反：chunks 删失败时磁盘文件还在 —— 用户可以重试；
    // 若先删磁盘再删 chunks 失败，已删内容仍会被检索召回（原缺陷）。
    // 失败直接向上抛，由 KnowledgeManager 提示并保留列表项（不制造假删除）。
    await invoke<number>("rag_delete_document", { kbId: baseId, fileId: name });
    // F3 真删除：删文件而非写空占位（旧实现重启后残留空文件）
    const appDir = await getAppDir();
    try {
      await deleteItem(`${appDir}/knowledge/${baseId}/${name}`);
    } catch {
      /* ignore */
    }
    set((s) => ({ files: s.files.filter((f) => f.name !== name) }));
  },

  getContext: async (baseId) => {
    const appDir = await getAppDir();
    try {
      const names = await listDir(`${appDir}/knowledge/${baseId}`);
      let ctx = "";
      for (const name of names) {
        const ext = name.split(".").pop()?.toLowerCase() ?? "";
        if (TEXT_FILE_EXT.includes(ext)) {
          const content = await readFile(`${appDir}/knowledge/${baseId}/${name}`);
          ctx += `\n--- ${name} ---\n${content}\n`;
        }
      }
      return ctx;
    } catch {
      return "";
    }
  },
}));
