// stores/useMemoryStore.test.ts — T-077 记忆 IPC 契约
//
// 契约：
//   1. mem_list 的 DTO 不再携带 embedding，前端 load 后默认 weight=1；
//   2. save/create 必须把 weight 传给后端（否则收藏加权永不生效）；
//   3. toggleFavorite 在 1 与 2 之间切换，并立即落库。

import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  memList: vi.fn(async () => [] as unknown[]),
  memSave: vi.fn(async (_memory: object) => {}),
  memDelete: vi.fn(async (_id: string) => {}),
}));

vi.mock("@/lib/tauri", () => ipc);

import { useMemoryStore, type Memory } from "./useMemoryStore";

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    content: "用户偏好中文",
    tags: ["偏好"],
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    weight: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.memList.mockResolvedValue([]);
  ipc.memSave.mockResolvedValue(undefined);
  ipc.memDelete.mockResolvedValue(undefined);
  useMemoryStore.setState({ memories: [], loaded: false });
});

describe("T-077 记忆 weight 生产方", () => {
  it("load 接受无 weight 的旧 DTO 并默认 weight=1", async () => {
    ipc.memList.mockResolvedValue([
      {
        id: "old",
        content: "旧记忆",
        tags_json: '["旧"]',
        enabled: true,
        created_at: "a",
        updated_at: "b",
      },
    ]);

    await useMemoryStore.getState().load();

    const loaded = useMemoryStore.getState().memories[0];
    expect(loaded?.weight).toBe(1);
    expect(loaded?.tags).toEqual(["旧"]);
  });

  it("save 把 weight 透传给 mem_save，且不携带 embedding", async () => {
    await useMemoryStore.getState().save(memory({ weight: 2 }));

    expect(ipc.memSave).toHaveBeenCalledTimes(1);
    const payload = ipc.memSave.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.weight).toBe(2);
    expect(payload.id).toBe("m1");
    expect(payload).not.toHaveProperty("embedding");
  });

  it("create 默认 weight=1 并落库", async () => {
    await useMemoryStore.getState().create("新记忆", ["新"]);

    const payload = ipc.memSave.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.weight).toBe(1);
    expect(useMemoryStore.getState().memories[0]?.weight).toBe(1);
  });

  it("toggleFavorite 在 1 ↔ 2 之间切换，收藏后检索权重生效", async () => {
    useMemoryStore.setState({ memories: [memory({ weight: 1 })], loaded: true });

    await useMemoryStore.getState().toggleFavorite("m1");
    expect((ipc.memSave.mock.calls[0]?.[0] as Record<string, unknown>).weight).toBe(2);
    expect(useMemoryStore.getState().memories[0]?.weight).toBe(2);

    await useMemoryStore.getState().toggleFavorite("m1");
    expect((ipc.memSave.mock.calls[1]?.[0] as Record<string, unknown>).weight).toBe(1);
    expect(useMemoryStore.getState().memories[0]?.weight).toBe(1);
  });

  it("toggleFavorite 对不存在的 id 不发请求", async () => {
    await useMemoryStore.getState().toggleFavorite("missing");
    expect(ipc.memSave).not.toHaveBeenCalled();
  });
});
