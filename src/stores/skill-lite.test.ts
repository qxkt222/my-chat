// stores/skill-lite.test.ts — 技能「对话模式可用」的持久化契约
//
// 钉住的行为（与实现无关，只看 store 公开字段与 IPC 载荷）：
//   1. 旧技能没有 lite_enabled 时，加载后为 false（升级后默认不在对话模式出现）；
//   2. lite_enabled=true 能原样读出；
//   3. update / create 的 IPC 载荷必须携带 lite_enabled，否则 Rust 侧
//      `#[serde(default)]` 会把它重置成 false —— 开关等于没保存。

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipc = vi.hoisted(() => ({
  dbListSkills: vi.fn(async () => [] as unknown[]),
  dbCreateSkill: vi.fn(async () => {}),
  dbUpdateSkill: vi.fn(async () => {}),
  dbDeleteSkill: vi.fn(async () => {}),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, ...ipc };
});

import { useSkillStore } from "./useSkillStore";
import type { DbSkillDto, Skill } from "@/types";

function dto(over: Partial<DbSkillDto> = {}): DbSkillDto {
  return {
    id: "s1",
    name: "S1",
    description: "",
    system_prompt: "p",
    model: "",
    temperature: null,
    category: "",
    tags_json: "[]",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function skill(over: Partial<Skill> = {}): Skill {
  return {
    id: "s1",
    name: "S1",
    description: "",
    systemPrompt: "p",
    model: "",
    temperature: null,
    category: "",
    tags: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSkillStore.setState({ skills: [], activeSkillId: null, loaded: false });
});

describe("useSkillStore lite_enabled", () => {
  it("旧 DTO 缺字段时加载为 false", async () => {
    ipc.dbListSkills.mockResolvedValue([dto()]);
    await useSkillStore.getState().load();
    expect(useSkillStore.getState().skills[0]?.lite_enabled).toBe(false);
  });

  it("DTO 里 true 时加载保持 true", async () => {
    ipc.dbListSkills.mockResolvedValue([dto({ lite_enabled: true })]);
    await useSkillStore.getState().load();
    expect(useSkillStore.getState().skills[0]?.lite_enabled).toBe(true);
  });

  it("save 的 IPC 载荷携带 lite_enabled，且内存状态保留", async () => {
    const s = skill({ lite_enabled: true });
    useSkillStore.setState({ skills: [s], activeSkillId: null, loaded: true });

    await useSkillStore.getState().save(s);

    expect(ipc.dbUpdateSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1", lite_enabled: true })
    );
    expect(useSkillStore.getState().skills[0]?.lite_enabled).toBe(true);
  });

  it("save 的 IPC 载荷带上 tools_json / memory_tags（否则每次保存都会清空绑定）", async () => {
    const s = skill({
      tools_json: '["srv/tool"]',
      memory_tags: '["tagA"]',
      lite_enabled: true,
    });
    useSkillStore.setState({ skills: [s], activeSkillId: null, loaded: true });

    await useSkillStore.getState().save(s);

    expect(ipc.dbUpdateSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "s1",
        tools_json: '["srv/tool"]',
        memory_tags: '["tagA"]',
      })
    );
    expect(useSkillStore.getState().skills[0]?.tools_json).toBe('["srv/tool"]');
    expect(useSkillStore.getState().skills[0]?.memory_tags).toBe('["tagA"]');
  });

  it("load 把 tools_json / memory_tags 读回内存（缺省为空串）", async () => {
    ipc.dbListSkills.mockResolvedValue([
      dto({ tools_json: '["srv/tool"]', memory_tags: '["tagA"]', lite_enabled: true }),
      dto({ id: "s2" }),
    ]);
    await useSkillStore.getState().load();

    const [a, b] = useSkillStore.getState().skills;
    expect(a?.tools_json).toBe('["srv/tool"]');
    expect(a?.memory_tags).toBe('["tagA"]');
    expect(b?.tools_json).toBe("");
    expect(b?.memory_tags).toBe("");
  });

  it("create 的 IPC 载荷携带 lite_enabled=true 与 Agent 绑定字段", async () => {
    const created = await useSkillStore.getState().create({
      name: "New",
      description: "",
      systemPrompt: "",
      model: "",
      temperature: null,
      category: "",
      tags: [],
      tools_json: '["srv/tool"]',
      memory_tags: '["tagA"]',
      lite_enabled: true,
    });

    expect(ipc.dbCreateSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        id: created.id,
        tools_json: '["srv/tool"]',
        memory_tags: '["tagA"]',
        lite_enabled: true,
      })
    );
    expect(created.lite_enabled).toBe(true);
  });
});
