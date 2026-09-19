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
          created_at: s.created_at,
          updated_at: s.updated_at,
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
