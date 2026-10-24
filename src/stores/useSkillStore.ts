import { create } from "zustand";
import type { Skill } from "@/types";
import { dbCreateSkill, dbListSkills, dbUpdateSkill, dbDeleteSkill } from "@/lib/tauri";

interface SkillState {
  skills: Skill[];
  activeSkillId: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  save: (skill: Skill) => Promise<void>;
  create: (input: Omit<Skill, "id" | "created_at" | "updated_at">) => Promise<Skill>;
  remove: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
}

export const useSkillStore = create<SkillState>((set, _get) => ({
  skills: [],
  activeSkillId: null,
  loaded: false,

  load: async () => {
    try {
      const skills = await dbListSkills();
      set({
        skills: skills.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          systemPrompt: s.system_prompt,
          model: s.model,
          temperature: s.temperature,
          category: s.category,
          tags: JSON.parse(s.tags_json || "[]"),
          // Agent 绑定的工具/记忆标签：不回填等于每次启动都丢绑定
          tools_json: s.tools_json ?? "",
          memory_tags: s.memory_tags ?? "",
          created_at: s.created_at,
          updated_at: s.updated_at,
          // 旧技能没有该字段 → false（对话模式默认不出现）
          lite_enabled: s.lite_enabled ?? false,
        })),
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  save: async (skill) => {
    await dbUpdateSkill({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      system_prompt: skill.systemPrompt,
      model: skill.model,
      temperature: skill.temperature,
      category: skill.category,
      tags_json: JSON.stringify(skill.tags),
      created_at: skill.created_at,
      updated_at: new Date().toISOString(),
      // 必须显式回传：Rust 侧 serde(default) 会把缺失的字段重置为 false / 空串，
      // 漏传等于每次保存都把「对话模式可用」与 Agent 绑定清掉。
      tools_json: skill.tools_json ?? "",
      memory_tags: skill.memory_tags ?? "",
      lite_enabled: skill.lite_enabled ?? false,
    });
    set((s) => ({ skills: s.skills.map((sk) => (sk.id === skill.id ? skill : sk)) }));
  },

  create: async (input) => {
    const skill: Skill = {
      ...input,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await dbCreateSkill({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      system_prompt: skill.systemPrompt,
      model: skill.model,
      temperature: skill.temperature,
      category: skill.category,
      tags_json: JSON.stringify(skill.tags),
      created_at: skill.created_at,
      updated_at: skill.updated_at,
      tools_json: skill.tools_json ?? "",
      memory_tags: skill.memory_tags ?? "",
      lite_enabled: skill.lite_enabled ?? false,
    });
    set((s) => ({ skills: [skill, ...s.skills] }));
    return skill;
  },

  remove: async (id) => {
    await dbDeleteSkill(id);
    set((s) => ({
      skills: s.skills.filter((sk) => sk.id !== id),
      activeSkillId: s.activeSkillId === id ? null : s.activeSkillId,
    }));
  },

  setActive: (id) => set({ activeSkillId: id }),
}));
