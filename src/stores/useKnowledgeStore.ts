import { create } from "zustand";
import type { KnowledgeBase, KnowledgeFile } from "@/types";
import { getAppDir, readFile, writeFile, listDir, createDir, deleteItem } from "@/lib/tauri";

/** 知识源元数据 localStorage key(认证/新鲜度徽标) */
const KB_META_KEY = "kb_meta";

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
        if (name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".json")) {
          const content = await readFile(`${appDir}/knowledge/${baseId}/${name}`);
          files.push({ name, content });
        }
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
        if (name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".json")) {
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
