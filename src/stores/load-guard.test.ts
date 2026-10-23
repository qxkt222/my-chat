// @vitest-environment jsdom
// stores/load-guard.test.ts — SRC-01 回归:store 的 load() 必须是幂等的
//
// 背景(2026-10-23 审计):TavernView / SimulationView 用整店订阅
// (`const tavern = useTavernStore()`) + `useEffect(..., [tavern])`,
// 而 zustand 每次 set 都产生新的 state 对象 → 依赖变化 → effect 重跑 →
// load() 又无条件 set() → 无限读盘(实测 500ms 内 34 次)。
//
// 本文件钉住的行为契约(与实现无关):
//   1. 同一份磁盘数据,加载一次之后再调用 load() 不应再产生任何 IPC 读盘;
//   2. 并发调用(StrictMode 双挂载)也只读一次;
//   3. 读盘失败后重复调用不应反复重试(否则 effect 重跑时仍是无限循环);
//   4. 守卫不能破坏正常加载语义(解析、跳过坏文件、按 updated_at 倒序)。

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipc = vi.hoisted(() => ({
  getAppDir: vi.fn(async () => "/app"),
  listDir: vi.fn(async () => [] as string[]),
  readFile: vi.fn(async (_path: string) => ""),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, ...ipc };
});

import { useTavernStore } from "./useTavernStore";
import { useSimulationStore } from "./useSimulationStore";
import type { TavernConversation } from "@/types";

/** 造一份磁盘上的会话文件内容(字段独立于 store 实现,只给最小必要项) */
function convFile(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "c1",
    character_id: "char1",
    character_name: "Alice",
    title: "t",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    messages: [],
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.getAppDir.mockResolvedValue("/app");
  ipc.listDir.mockResolvedValue(["a.json", "b.json", "not-a-json.txt"]);
  ipc.readFile.mockImplementation(async (p: string) =>
    String(p).includes("a.json")
      ? convFile({ id: "a", updated_at: "2026-01-01T00:00:00.000Z" })
      : convFile({ id: "b", updated_at: "2026-02-01T00:00:00.000Z" })
  );
  useTavernStore.setState({ conversations: [], loaded: false, activeId: null });
  useSimulationStore.setState({ conversations: [], loaded: false, activeId: null });
});

describe("useTavernStore.load 幂等", () => {
  it("连续调用两次,第二次不再触发 listDir/readFile", async () => {
    await useTavernStore.getState().load();
    const dirCalls = ipc.listDir.mock.calls.length;
    const readCalls = ipc.readFile.mock.calls.length;

    expect(dirCalls).toBe(1);
    expect(readCalls).toBe(2); // 两个 .json,文本文件被跳过

    await useTavernStore.getState().load();

    expect(ipc.listDir.mock.calls.length).toBe(dirCalls);
    expect(ipc.readFile.mock.calls.length).toBe(readCalls);
  });

  it("并发调用(如 StrictMode 双挂载)只读一次盘", async () => {
    await Promise.all([useTavernStore.getState().load(), useTavernStore.getState().load()]);

    expect(ipc.listDir.mock.calls.length).toBe(1);
    expect(ipc.readFile.mock.calls.length).toBe(2);
  });

  it("读盘失败后重复调用不会反复重试", async () => {
    ipc.getAppDir.mockRejectedValue(new Error("disk unavailable"));

    await useTavernStore.getState().load();
    expect(useTavernStore.getState().loaded).toBe(true);

    await useTavernStore.getState().load();
    await useTavernStore.getState().load();

    expect(ipc.getAppDir.mock.calls.length).toBe(1);
  });

  it("守卫不破坏加载语义:跳过坏文件、按 updated_at 倒序", async () => {
    ipc.readFile.mockImplementation(async (p: string) => {
      if (String(p).includes("a.json"))
        return convFile({ id: "a", updated_at: "2026-01-01T00:00:00.000Z" });
      return "{ broken json";
    });

    await useTavernStore.getState().load();

    const convs = useTavernStore.getState().conversations as TavernConversation[];
    expect(convs.map((c) => c.id)).toEqual(["a"]);
    expect(useTavernStore.getState().loaded).toBe(true);
  });
});

describe("useSimulationStore.load 幂等", () => {
  it("连续调用两次,第二次不再触发 listDir/readFile", async () => {
    await useSimulationStore.getState().load();
    const dirCalls = ipc.listDir.mock.calls.length;
    const readCalls = ipc.readFile.mock.calls.length;

    expect(dirCalls).toBe(1);
    expect(readCalls).toBe(2);

    await useSimulationStore.getState().load();

    expect(ipc.listDir.mock.calls.length).toBe(dirCalls);
    expect(ipc.readFile.mock.calls.length).toBe(readCalls);
  });

  it("读盘失败后重复调用不会反复重试", async () => {
    ipc.getAppDir.mockRejectedValue(new Error("disk unavailable"));

    await useSimulationStore.getState().load();
    await useSimulationStore.getState().load();

    expect(ipc.getAppDir.mock.calls.length).toBe(1);
  });
});
