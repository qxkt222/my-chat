import { create } from "zustand";
import type {
  CharacterCard,
  CharacterBook,
  Persona,
  PromptPreset,
  PresetRosterIndex,
} from "@/types";
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
import {
  applyOrder,
  emptyRosterIndex,
  entryOrderOf,
  groupOf,
  migrateLegacyEntries,
  moveWithin,
} from "@/lib/preset-roster";

/** 名册索引的文件名（放在 presets/ 下；load 时必须跳过它，否则会被当成一条预设） */
export const ROSTER_INDEX_FILE = "roster-index.json";

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

  // ── 全局条目名册（2026-09-25）──────────────────────────────
  // 开关与顺序都是**全局**的，与角色无关；角色只管自己的提示词与世界书。
  /** 名册索引（包顺序 + 包内顺序），落盘 presets/roster-index.json */
  rosterIndex: PresetRosterIndex | null;
  loadRosterIndex: () => Promise<void>;
  /** 切换某条条目是否参与拼装（全局） */
  togglePresetEnabled: (id: string) => Promise<void>;
  /** 把某条在它所属包内上移/下移一位；到端点时不做任何事 */
  movePresetInGroup: (id: string, dir: -1 | 1) => Promise<void>;
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
  rosterIndex: null,
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
        // ⚠️ 名册索引也住在 presets/ 下，它不是预设，必须跳过
        if (f === ROSTER_INDEX_FILE) continue;
        try {
          const raw = await readFile(`${appDir}/presets/${f}`);
          presets.push(JSON.parse(raw) as PromptPreset);
        } catch {
          /* skip */
        }
      }

      // 名册索引（包顺序 + 包内顺序）。缺失/损坏一律退回空索引，不让它挡住启动。
      let rosterIndex: PresetRosterIndex = emptyRosterIndex();
      try {
        const rawIdx = await readFile(`${appDir}/presets/${ROSTER_INDEX_FILE}`);
        const parsed = JSON.parse(rawIdx) as Partial<PresetRosterIndex>;
        rosterIndex = {
          groupOrder: Array.isArray(parsed.groupOrder) ? parsed.groupOrder : [],
          entryOrder:
            parsed.entryOrder && typeof parsed.entryOrder === "object" ? parsed.entryOrder : {},
          updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
        };
      } catch {
        /* 首次运行没有这个文件，正常 */
      }

      // 索引重建：索引是「包顺序 + 包内顺序」的全局锚，缺了 UI 就没有稳定排序。
      // 迁移过、或索引文件缺失时都重建一次（幂等：只按当前 presets 推导，不凭空造顺序）。
      const buildIndexFrom = (list: PromptPreset[], prev: PresetRosterIndex): PresetRosterIndex => {
        const groupsSeen: string[] = [];
        const entryOrder: Record<string, string[]> = {};
        for (const p of list) {
          if (!p.id.startsWith("imp-")) continue; // 内置/自定义不入索引
          const g = groupOf(p);
          if (!groupsSeen.includes(g)) groupsSeen.push(g);
          (entryOrder[g] ??= []).push(p.id);
        }
        // 包内按 order 排好再入索引
        for (const g of Object.keys(entryOrder)) {
          const ids = entryOrder[g] ?? [];
          ids.sort((a, b) => {
            const pa = list.find((x) => x.id === a);
            const pb = list.find((x) => x.id === b);
            return (pa?.order ?? Number.MAX_SAFE_INTEGER) - (pb?.order ?? Number.MAX_SAFE_INTEGER);
          });
          entryOrder[g] = ids;
        }
        return {
          groupOrder: prev.groupOrder.length > 0 ? prev.groupOrder : groupsSeen,
          entryOrder,
          updated_at: nowISO(),
        };
      };

      // 旧数据迁移：给没有 group/order 的导入条目补上（本机实测有 34 条这样的旧数据）。
      // 补完落盘，否则每次启动都要重算，而且 UI 的排序没有稳定锚点。
      // ⚠️ 迁移**不会**把任何条目变成已启用 —— 旧数据里没有当年的启用标记，
      //    宁可全关也不能误开（「（默认组合）」那条 6.5 万字）。
      try {
        const migrated = migrateLegacyEntries(presets, "导入预设");
        if (migrated.changed > 0) {
          for (const p of migrated.presets) {
            if (p.id.startsWith("imp-")) {
              await writeFile(`${appDir}/presets/${p.id}.json`, JSON.stringify(p, null, 2));
            }
          }
          presets.length = 0;
          presets.push(...migrated.presets);
        }
      } catch {
        /* 迁移失败不该挡住启动：内存里已是迁移后的结构，下次再试落盘 */
      }

      // 索引落盘：迁移过（changed>0）或索引文件本来就缺失时重建一次。
      // 这样「包内排序」这条能力从首次启动起就有一个真实存在的锚，而不是
      // 等用户第一次点上下移才凭空出现一个文件。
      try {
        const needsRebuild =
          rosterIndex.entryOrder === undefined || Object.keys(rosterIndex.entryOrder).length === 0;
        if (needsRebuild) {
          rosterIndex = buildIndexFrom(presets, rosterIndex);
          await writeFile(
            `${appDir}/presets/${ROSTER_INDEX_FILE}`,
            JSON.stringify(rosterIndex, null, 2)
          );
        }
      } catch {
        /* 索引写不进去不影响这一轮使用：内存里已经有可用顺序 */
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
        rosterIndex,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  loadRosterIndex: async () => {
    try {
      const appDir = await getAppDir();
      const raw = await readFile(`${appDir}/presets/${ROSTER_INDEX_FILE}`);
      const parsed = JSON.parse(raw) as Partial<PresetRosterIndex>;
      set({
        rosterIndex: {
          groupOrder: Array.isArray(parsed.groupOrder) ? parsed.groupOrder : [],
          entryOrder:
            parsed.entryOrder && typeof parsed.entryOrder === "object" ? parsed.entryOrder : {},
          updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
        },
      });
    } catch {
      set({ rosterIndex: emptyRosterIndex() });
    }
  },

  togglePresetEnabled: async (id) => {
    const cur = get().presets.find((p) => p.id === id);
    if (!cur) return;
    // 只认 === true 取反：旧数据没有这个键，`!p.enabled` 也得到 true，与 isEntryEnabled 同口径
    const next: PromptPreset = { ...cur, enabled: cur.enabled !== true };
    const appDir = await getAppDir();
    // 内置预设不入盘（它们在代码里写死），开关状态只留在内存 + 索引文件里；
    // 落盘失败不阻断内存更新，否则界面看起来「点了没反应」。
    if (!cur.is_preset) {
      try {
        await writeFile(`${appDir}/presets/${id}.json`, JSON.stringify(next, null, 2));
      } catch {
        /* 落盘失败：内存仍生效，下次改动会再试 */
      }
    }
    set((s) => ({ presets: s.presets.map((p) => (p.id === id ? next : p)) }));
  },

  movePresetInGroup: async (id, dir) => {
    const s = get();
    const cur = s.presets.find((p) => p.id === id);
    if (!cur) return;
    const group = groupOf(cur);
    const inGroup = s.presets.filter((p) => groupOf(p) === group);
    // 包内当前顺序以**索引**为准（它是全局锚），索引没记录时才回退到 order 字段
    const byOrder = [...inGroup].sort(
      (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
    );
    const ids = entryOrderOf(
      s.rosterIndex,
      group,
      byOrder.map((p) => p.id)
    );
    const nextIds = moveWithin(ids, id, dir);
    if (!nextIds) return; // 已在端点，无需改动（也不落盘）

    const appDir = await getAppDir();
    const reordered = applyOrder(s.presets, nextIds);
    const updated = reordered.filter((p) => !p.is_preset);
    for (const p of updated) {
      try {
        await writeFile(`${appDir}/presets/${p.id}.json`, JSON.stringify(p, null, 2));
      } catch {
        /* 同上：不阻断内存更新 */
      }
    }
    // 顺序写进索引：包内顺序是全局属性，需要一个与角色无关的锚
    const nextIndex: PresetRosterIndex = {
      groupOrder: s.rosterIndex?.groupOrder ?? [],
      entryOrder: { ...(s.rosterIndex?.entryOrder ?? {}), [group]: nextIds },
      updated_at: nowISO(),
    };
    try {
      await writeFile(`${appDir}/presets/${ROSTER_INDEX_FILE}`, JSON.stringify(nextIndex, null, 2));
    } catch {
      /* ignore */
    }
    set({ presets: reordered, rosterIndex: nextIndex });
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
