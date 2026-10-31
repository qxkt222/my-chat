import { create } from "zustand";
import type { ApiTemplate } from "@/types";
import { getAppDir, readFile, writeFile, listDir, deleteItem, logDiag } from "@/lib/tauri";
import { sanitizeApiTemplate } from "@/lib/persist-sanitize";

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
        // T-136:adapters/*.json 是用户可手改的不可信输入,必须过 persist-sanitize;
        // 单个坏文件隔离(跳过)而不是让整个 load 抛错、全部模板消失。
        try {
          const raw = await readFile(`${appDir}/adapters/${f}`);
          const template = sanitizeApiTemplate(JSON.parse(raw) as unknown);
          if (!template.id) {
            logDiag(`adapters/${f}: 缺少 id,已隔离`);
            continue;
          }
          templates.push(template);
        } catch (e) {
          logDiag(`adapters/${f}: 解析失败,已隔离 (${String(e)})`);
        }
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
      // 导入同样走 sanitize(外部 JSON 和磁盘文件一样不可信)
      const template = sanitizeApiTemplate(JSON.parse(json) as unknown);
      // 完全无意义的对象(没名字也没 URL)直接拒绝,不生成垃圾模板
      if (!template.name.trim() && !template.api_url.trim()) return;
      await get().create({
        name: `${template.name || "导入的适配器"} (imported)`,
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
