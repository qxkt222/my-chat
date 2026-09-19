import { create } from "zustand";
import type { ApiTemplate } from "@/types";
import { getAppDir, readFile, writeFile, listDir, deleteItem } from "@/lib/tauri";

interface AdapterState {
  templates: ApiTemplate[];
  activeTemplateId: string | null;
  loaded: boolean;

  load: () => Promise<void>;
  save: (template: ApiTemplate) => Promise<void>;
  create: (template: Omit<ApiTemplate, "id" | "created_at" | "updated_at">) => Promise<ApiTemplate>;
  remove: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  exportTemplate: (id: string) => string;
  importTemplate: (json: string) => Promise<void>;
  getActive: () => ApiTemplate | undefined;
}

export const useAdapterStore = create<AdapterState>((set, get) => ({
  templates: [],
  activeTemplateId: null,
  loaded: false,

  load: async () => {
    try {
      const appDir = await getAppDir();
      // Load user templates
      const userFiles = await listDir(`${appDir}/adapters`);
      const templates: ApiTemplate[] = [];
      for (const f of userFiles) {
        if (!f.endsWith(".json")) continue;
        const raw = await readFile(`${appDir}/adapters/${f}`);
        templates.push(JSON.parse(raw));
      }
      set({ templates, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  save: async (template) => {
    const appDir = await getAppDir();
    await writeFile(`${appDir}/adapters/${template.id}.json`, JSON.stringify(template, null, 2));
    set((s) => ({
      templates: s.templates.map((t) => (t.id === template.id ? template : t)),
    }));
  },

  create: async (input) => {
    const template: ApiTemplate = {
      ...input,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await get().save(template);
    set((s) => ({ templates: [...s.templates, template] }));
    return template;
  },

  remove: async (id) => {
    // F3 真删除：删模板文件（旧实现写空文件会残留）
    const appDir = await getAppDir();
    try {
      await deleteItem(`${appDir}/adapters/${id}.json`);
    } catch {
      /* ignore */
    }
    set((s) => ({
      templates: s.templates.filter((t) => t.id !== id),
      activeTemplateId: s.activeTemplateId === id ? null : s.activeTemplateId,
    }));
  },

  setActive: (id) => set({ activeTemplateId: id }),

  exportTemplate: (id) => {
    const tpl = get().templates.find((t) => t.id === id);
    return tpl ? JSON.stringify(tpl, null, 2) : "";
  },

  importTemplate: async (json) => {
    try {
      const template = JSON.parse(json) as ApiTemplate;
      await get().create({
        name: template.name + " (imported)",
        mode: template.mode,
        api_url: template.api_url,
        request_method: template.request_method,
        request_headers: template.request_headers,
        request_body_template: template.request_body_template,
        sse_enabled: template.sse_enabled,
        sse_data_prefix: template.sse_data_prefix,
        sse_done_marker: template.sse_done_marker,
        sse_content_path: template.sse_content_path,
        response_content_path: template.response_content_path,
        pre_script: template.pre_script,
        parse_script: template.parse_script,
        category: template.category,
        is_preset: false,
      });
    } catch {
      // invalid JSON
    }
  },

  getActive: () => {
    const { templates, activeTemplateId } = get();
    return templates.find((t) => t.id === activeTemplateId);
  },
}));
