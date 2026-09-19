import { create } from "zustand";
import type { CharacterCard, CharacterBook, Persona, PromptPreset } from "@/types";
import {
  getAppDir,
  readFile,
  writeFile,
  listDir,
  deleteItem,
  readFileBytes,
  writeFileBytes,
  dbGetSetting,
  dbSaveSetting,
} from "@/lib/tauri";
import { parseCharacterJson, toExportJson, buildExportPng } from "@/lib/character-card";
import { parseTavernPresets } from "@/lib/preset-import";
import { parseLorebook } from "@/lib/lorebook-import";

// ── 内置 RP 提示词预设(酒馆风格)───────────────────────────
export const BUILTIN_PRESETS: PromptPreset[] = [
  {
    id: "preset-classic-char",
    name: "经典 Char(酒馆原版)",
    is_preset: true,
    description: "SillyTavern 经典主提示词模板,占位符齐全",
    created_at: "",
    template: `角色扮演对话。严格以 {{char}} 的身份扮演,不要跳出角色。

角色设定:
{{description}}

性格:
{{personality}}

场景:
{{scenario}}

示例对话:
{{mes_example}}

{{lorebook}}

请以 {{char}} 的身份直接回应 {{user}},保持角色一致性与连贯性。`,
  },
  {
    id: "preset-immersive-zh",
    name: "中文沉浸 RP",
    is_preset: true,
    description: "中文沉浸式角色扮演,强调细节与氛围",
    created_at: "",
    template: `你正在扮演「{{char}}」,参与一段沉浸式中文角色扮演。

{{description}}
{{personality}}
{{scenario}}

{{lorebook}}

规则:
1. 始终保持 {{char}} 的身份、口吻与立场,绝不跳出角色。
2. 用中文回复,描写动作、神态、环境等细节,让场景生动。
3. 对话与旁白结合,旁白用 *斜体* 或 (括号)。
4. 不要替 {{user}} 做决定或代替其说话。

请开始。`,
  },
  {
    id: "preset-minimal-rp",
    name: "极简 RP",
    is_preset: true,
    description: "轻量角色扮演,提示词最短,适合强模型",
    created_at: "",
    template: `你扮演 {{char}}。{{description}} {{personality}} {{scenario}} {{lorebook}} 与 {{user}} 对话,保持角色。`,
  },
];

interface CharacterState {
  characters: CharacterCard[];
  personas: Persona[];
  activePersonaId: string;
  /** 全局世界书(独立于角色内嵌书) */
  globalLorebook: CharacterBook;
  presets: PromptPreset[];
  loaded: boolean;

  load: () => Promise<void>;
  saveCharacter: (card: CharacterCard) => Promise<void>;
  /** input.id 可选——传了就用(头像先落盘时保证路径与卡 id 一致) */
  createCharacter: (
    input: Omit<CharacterCard, "created_at" | "updated_at">
  ) => Promise<CharacterCard>;
  removeCharacter: (id: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;

  saveAvatar: (id: string, base64: string) => Promise<string>;
  importCharacter: (json: string, avatarBase64?: string | null) => Promise<CharacterCard | null>;
  exportCharacterJson: (id: string) => Promise<string | null>;
  exportCharacterPng: (id: string) => Promise<string | null>;

  savePersona: (p: Persona) => Promise<void>;
  createPersona: (name: string, description: string) => Promise<Persona>;
  removePersona: (id: string) => Promise<void>;
  setActivePersona: (id: string) => Promise<void>;
  getActivePersona: () => Persona | undefined;

  saveGlobalLorebook: (book: CharacterBook) => Promise<void>;
  /** 多本全局世界书(按 id;支持"我的角色"绑定独立世界书) */
  lorebooks: Record<string, CharacterBook>;
  /** 已启用的独立世界书 id 列表(可多本同时生效,与主/角色内嵌/Persana 合并注入) */
  enabledLorebookIds: string[];
  saveLorebook: (id: string, book: CharacterBook) => Promise<void>;
  removeLorebook: (id: string) => Promise<void>;
  /** 切换某本独立世界书的启用状态(多本可同时启用) */
  toggleLorebookEnabled: (id: string) => Promise<void>;
  /** 从酒馆 JSON 导入世界书(独立或角色卡内嵌),返回导入后的 book */
  importLorebook: (rawJson: string) => Promise<CharacterBook | null>;
  /** 从酒馆 JSON 导入预设,返回导入数量 */
  importPresets: (rawJson: string) => Promise<number>;

  savePreset: (p: PromptPreset) => Promise<void>;
  removePreset: (id: string) => Promise<void>;
  getPreset: (id: string) => PromptPreset | undefined;
}

function nowISO(): string {
  return new Date().toISOString();
}
function uuid(): string {
  return crypto.randomUUID();
}

export const useCharacterStore = create<CharacterState>((set, get) => ({
  characters: [],
  personas: [],
  activePersonaId: "",
  globalLorebook: { entries: [] },
  lorebooks: {},
  enabledLorebookIds: [],
  presets: [...BUILTIN_PRESETS],
  loaded: false,

  load: async () => {
    try {
      const appDir = await getAppDir();
      const [charNames, presetNames] = await Promise.all([
        listDir(`${appDir}/characters`),
        listDir(`${appDir}/presets`),
      ]);
      const characters: CharacterCard[] = [];
      for (const f of charNames) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await readFile(`${appDir}/characters/${f}`);
          characters.push(JSON.parse(raw) as CharacterCard);
        } catch {
          /* 坏文件跳过 */
        }
      }
      const presets: PromptPreset[] = [...BUILTIN_PRESETS];
      for (const f of presetNames) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await readFile(`${appDir}/presets/${f}`);
          presets.push(JSON.parse(raw) as PromptPreset);
        } catch {
          /* skip */
        }
      }
      // Persona 存 settings 树(JSON 数组)+ 全局激活 id;旧单值 lorebookId 迁移到数组
      let personas: Persona[] = [];
      let activePersonaId = "";
      try {
        const raw = await dbGetSetting("personas");
        if (raw) {
          personas = (JSON.parse(raw) as Persona[]).map((p) => ({
            ...p,
            lorebookIds: p.lorebookIds || (p.lorebookId ? [p.lorebookId] : []),
          }));
        }
        const act = await dbGetSetting("active_persona_id");
        activePersonaId = act || "";
        if (activePersonaId && !personas.some((p) => p.id === activePersonaId))
          activePersonaId = "";
      } catch {
        /* ignore */
      }
      // 全局世界书(单一,兼容旧) + 多本世界书(按 id,Persona 可绑定)
      let globalLorebook: CharacterBook = { entries: [] };
      const lorebooks: Record<string, CharacterBook> = {};
      try {
        const raw = await readFile(`${appDir}/lorebook.json`);
        globalLorebook = JSON.parse(raw) as CharacterBook;
      } catch {
        /* 首次无文件 */
      }
      const loreNames = await listDir(`${appDir}/lorebooks`).catch(() => [] as string[]);
      for (const f of loreNames) {
        if (!f.endsWith(".json")) continue;
        try {
          const id = f.replace(/\.json$/, "");
          const raw = await readFile(`${appDir}/lorebooks/${f}`);
          lorebooks[id] = JSON.parse(raw) as CharacterBook;
        } catch {
          /* skip */
        }
      }
      // 已启用的独立世界书(settings 持久化,可多本同时生效)
      let enabledLorebookIds: string[] = [];
      try {
        const raw = await dbGetSetting("enabled_lorebooks");
        if (raw) enabledLorebookIds = JSON.parse(raw) as string[];
      } catch {
        /* ignore */
      }
      set({
        characters,
        personas,
        activePersonaId,
        globalLorebook,
        lorebooks,
        enabledLorebookIds,
        presets,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  saveCharacter: async (card) => {
    const appDir = await getAppDir();
    await writeFile(`${appDir}/characters/${card.id}.json`, JSON.stringify(card, null, 2));
    set((s) => ({
      characters: s.characters.map((c) => (c.id === card.id ? card : c)),
    }));
  },

  createCharacter: async (input) => {
    const card: CharacterCard = {
      ...input,
      id: input.id ?? uuid(),
      created_at: nowISO(),
      updated_at: nowISO(),
    };
    const appDir = await getAppDir();
    await writeFile(`${appDir}/characters/${card.id}.json`, JSON.stringify(card, null, 2));
    set((s) => ({ characters: [...s.characters, card] }));
    return card;
  },

  removeCharacter: async (id) => {
    const appDir = await getAppDir();
    try {
      await deleteItem(`${appDir}/characters/${id}.json`);
    } catch {
      /* ignore */
    }
    try {
      await deleteItem(`${appDir}/characters/avatars/${id}.png`);
    } catch {
      /* ignore */
    }
    set((s) => ({ characters: s.characters.filter((c) => c.id !== id) }));
  },

  toggleFavorite: async (id) => {
    const card = get().characters.find((c) => c.id === id);
    if (!card) return;
    await get().saveCharacter({ ...card, favorite: !card.favorite });
  },

  saveAvatar: async (id, base64) => {
    const appDir = await getAppDir();
    const path = `${appDir}/characters/avatars/${id}.png`;
    await writeFileBytes(path, base64);
    return path;
  },

  importCharacter: async (json, avatarBase64) => {
    const data = parseCharacterJson(json);
    if (!data) return null;
    const card: CharacterCard = {
      ...data,
      id: uuid(),
      created_at: nowISO(),
      updated_at: nowISO(),
      avatarPath: "",
    };
    if (avatarBase64) {
      card.avatarPath = await get().saveAvatar(card.id, avatarBase64);
    }
    const appDir = await getAppDir();
    await writeFile(`${appDir}/characters/${card.id}.json`, JSON.stringify(card, null, 2));
    set((s) => ({ characters: [...s.characters, card] }));
    return card;
  },

  exportCharacterJson: async (id) => {
    const card = get().characters.find((c) => c.id === id);
    if (!card) return null;
    return toExportJson(card);
  },

  exportCharacterPng: async (id) => {
    const card = get().characters.find((c) => c.id === id);
    if (!card || !card.avatarPath) return null;
    const avatarBase64 = await readFileBytes(card.avatarPath);
    return buildExportPng(avatarBase64, toExportJson(card));
  },

  savePersona: async (p) => {
    const list = get().personas.map((x) => (x.id === p.id ? p : x));
    set({ personas: list });
    await dbSaveSetting("personas", JSON.stringify(list));
  },

  createPersona: async (name, description) => {
    const p: Persona = { id: uuid(), name, description, avatarPath: "", created_at: nowISO() };
    const list = [...get().personas, p];
    set({ personas: list });
    await dbSaveSetting("personas", JSON.stringify(list));
    return p;
  },

  removePersona: async (id) => {
    const list = get().personas.filter((p) => p.id !== id);
    set({
      personas: list,
      activePersonaId: get().activePersonaId === id ? "" : get().activePersonaId,
    });
    await dbSaveSetting("personas", JSON.stringify(list));
    const appDir = await getAppDir();
    try {
      await deleteItem(`${appDir}/characters/avatars/persona-${id}.png`);
    } catch {
      /* ignore */
    }
  },

  setActivePersona: async (id) => {
    set({ activePersonaId: id });
    await dbSaveSetting("active_persona_id", id);
  },

  getActivePersona: () => {
    return get().personas.find((p) => p.id === get().activePersonaId);
  },

  saveGlobalLorebook: async (book) => {
    const appDir = await getAppDir();
    await writeFile(`${appDir}/lorebook.json`, JSON.stringify(book, null, 2));
    set({ globalLorebook: book });
  },

  saveLorebook: async (id, book) => {
    const appDir = await getAppDir();
    await writeFile(`${appDir}/lorebooks/${id}.json`, JSON.stringify(book, null, 2));
    set((s) => ({ lorebooks: { ...s.lorebooks, [id]: book } }));
  },

  toggleLorebookEnabled: async (id) => {
    const on = get().enabledLorebookIds.includes(id);
    const enabledLorebookIds = on
      ? get().enabledLorebookIds.filter((x) => x !== id)
      : [...get().enabledLorebookIds, id];
    set({ enabledLorebookIds });
    await dbSaveSetting("enabled_lorebooks", JSON.stringify(enabledLorebookIds));
  },

  removeLorebook: async (id) => {
    const appDir = await getAppDir();
    try {
      await deleteItem(`${appDir}/lorebooks/${id}.json`);
    } catch {
      /* ignore */
    }
    set((s) => {
      const lorebooks = { ...s.lorebooks };
      delete lorebooks[id];
      // 从全局启用列表移除
      const enabledLorebookIds = s.enabledLorebookIds.filter((x) => x !== id);
      // 解除 Persona 绑定(数组)
      const personas = s.personas.map((p) => ({
        ...p,
        lorebookIds: (p.lorebookIds || []).filter((x) => x !== id),
      }));
      if (personas.some((p, i) => p.lorebookIds !== s.personas[i]?.lorebookIds)) {
        void dbSaveSetting("personas", JSON.stringify(personas));
      }
      void dbSaveSetting("enabled_lorebooks", JSON.stringify(enabledLorebookIds));
      return { lorebooks, enabledLorebookIds, personas };
    });
  },

  importLorebook: async (rawJson) => {
    const book = parseLorebook(rawJson);
    if (!book) return null;
    const id = uuid();
    await get().saveLorebook(id, book);
    return book;
  },

  importPresets: async (rawJson) => {
    const presets = parseTavernPresets(rawJson);
    if (presets.length === 0) return 0;
    const appDir = await getAppDir();
    for (const p of presets) {
      await writeFile(`${appDir}/presets/${p.id}.json`, JSON.stringify(p, null, 2));
    }
    set((s) => ({ presets: [...s.presets, ...presets] }));
    return presets.length;
  },

  savePreset: async (p) => {
    const appDir = await getAppDir();
    if (!p.is_preset) {
      await writeFile(`${appDir}/presets/${p.id}.json`, JSON.stringify(p, null, 2));
    }
    set((s) => ({
      presets: s.presets.map((x) => (x.id === p.id ? p : x)),
    }));
  },

  removePreset: async (id) => {
    const appDir = await getAppDir();
    try {
      await deleteItem(`${appDir}/presets/${id}.json`);
    } catch {
      /* ignore */
    }
    set((s) => ({ presets: s.presets.filter((p) => p.id !== id) }));
  },

  getPreset: (id) => get().presets.find((p) => p.id === id),
}));
