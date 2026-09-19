import { create } from "zustand";
import { memList, memSave, memDelete } from "@/lib/tauri";

export interface Memory {
  id: string;
  content: string;
  tags: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** Shape returned by the Rust mem_list command */
interface MemoryDto {
  id: string;
  content: string;
  tags_json?: string;
  enabled?: boolean;
  created_at: string;
  updated_at: string;
}

interface MemoryState {
  memories: Memory[];
  loaded: boolean;
  load: () => Promise<void>;
  save: (m: Memory) => Promise<void>;
  create: (content: string, tags: string[]) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** 所有记忆条目的标签并集（供技能绑定选择） */
  allTags: () => string[];
  /** 按标签过滤启用的记忆文本（注入 system prompt 用） */
  byTags: (tags: string[]) => string;
}

function nowISO(): string {
  return new Date().toISOString();
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  loaded: false,

  load: async () => {
    try {
      const list = (await memList()) as MemoryDto[];
      set({
        memories: list.map((m) => ({
          id: m.id,
          content: m.content,
          tags: (() => {
            try {
              return JSON.parse(m.tags_json || "[]");
            } catch {
              return [];
            }
          })(),
          enabled: !!m.enabled,
          created_at: m.created_at,
          updated_at: m.updated_at,
        })),
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  save: async (m: Memory) => {
    await memSave({
      id: m.id,
      content: m.content,
      tags_json: JSON.stringify(m.tags),
      enabled: m.enabled,
      created_at: m.created_at,
      updated_at: nowISO(),
    });
    set((s) => ({
      memories: s.memories.map((x) => (x.id === m.id ? { ...m, updated_at: nowISO() } : x)),
    }));
  },

  create: async (content, tags) => {
    const m: Memory = {
      id: crypto.randomUUID(),
      content,
      tags,
      enabled: true,
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    await memSave({
      id: m.id,
      content: m.content,
      tags_json: JSON.stringify(m.tags),
      enabled: m.enabled,
      created_at: m.created_at,
      updated_at: m.updated_at,
    });
    set((s) => ({ memories: [m, ...s.memories] }));
  },

  remove: async (id) => {
    await memDelete(id);
    set((s) => ({ memories: s.memories.filter((m) => m.id !== id) }));
  },

  allTags: () => {
    const set_ = new Set<string>();
    for (const m of get().memories) for (const t of m.tags) set_.add(t);
    return [...set_];
  },

  byTags: (tags) => {
    if (tags.length === 0) return "";
    const parts: string[] = [];
    for (const m of get().memories) {
      if (!m.enabled) continue;
      if (m.tags.some((t) => tags.includes(t))) parts.push(m.content);
    }
    return parts.length > 0 ? `【长期记忆】\n${parts.join("\n")}` : "";
  },
}));
