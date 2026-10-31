// @vitest-environment jsdom
// stores/app-mode.test.ts — 工作模式子模式(对话 / 工作)的持久化契约
//
// 钉住的行为(与实现无关,只读公开字段/动作/localStorage):
//   1. 默认 workSubMode = "work":老用户升级后行为不变(仍是原来的工作区);
//   2. setWorkSubMode 同时更新内存状态与 localStorage(key `work_sub_mode`);
//   3. 初始化时从 localStorage 恢复合法值 "chat" / "work";
//   4. 非法存量值(手改/旧版本残留)回落默认 "work",不能让界面进入未定义态。

import { describe, it, expect, beforeEach, vi } from "vitest";

const SUB_KEY = "work_sub_mode";

/** 重新求值模块:store 在 import 期读 localStorage,必须 resetModules 才能测初始化 */
async function freshStore() {
  vi.resetModules();
  const mod = await import("./useAppModeStore");
  return mod.useAppModeStore;
}

beforeEach(() => {
  localStorage.clear();
});

describe("useAppModeStore.workSubMode", () => {
  it("默认是 work(保持现有用户行为)", async () => {
    const store = await freshStore();
    expect(store.getState().workSubMode).toBe("work");
  });

  it("setWorkSubMode 更新状态并写入 localStorage", async () => {
    const store = await freshStore();

    store.getState().setWorkSubMode("chat");
    expect(store.getState().workSubMode).toBe("chat");
    expect(localStorage.getItem(SUB_KEY)).toBe("chat");

    store.getState().setWorkSubMode("work");
    expect(store.getState().workSubMode).toBe("work");
    expect(localStorage.getItem(SUB_KEY)).toBe("work");
  });

  it("初始化时从 localStorage 恢复 chat", async () => {
    localStorage.setItem(SUB_KEY, "chat");
    const store = await freshStore();
    expect(store.getState().workSubMode).toBe("chat");
  });

  it("初始化时从 localStorage 恢复 work", async () => {
    localStorage.setItem(SUB_KEY, "work");
    const store = await freshStore();
    expect(store.getState().workSubMode).toBe("work");
  });

  it("非法存量值回落默认 work", async () => {
    localStorage.setItem(SUB_KEY, "bogus");
    const store = await freshStore();
    expect(store.getState().workSubMode).toBe("work");
  });

  it("空字符串也回落默认 work", async () => {
    localStorage.setItem(SUB_KEY, "");
    const store = await freshStore();
    expect(store.getState().workSubMode).toBe("work");
  });
});

// ── T-151:其余持久化枚举同样必须校验,不能直接 as 断言 ──────────────

const MODE_KEY = "app_mode";
const TAV_KEY = "tavern_sub_mode";

describe("useAppModeStore.mode 校验(T-151)", () => {
  it("无存量值时默认 work", async () => {
    const store = await freshStore();
    expect(store.getState().mode).toBe("work");
  });

  it("初始化时恢复合法值 tavern", async () => {
    localStorage.setItem(MODE_KEY, "tavern");
    const store = await freshStore();
    expect(store.getState().mode).toBe("tavern");
  });

  it("非法存量值回落 work", async () => {
    localStorage.setItem(MODE_KEY, "bogus");
    const store = await freshStore();
    expect(store.getState().mode).toBe("work");
  });
});

describe("useAppModeStore.tavernSubMode 校验(T-151)", () => {
  it("无存量值时默认 rp", async () => {
    const store = await freshStore();
    expect(store.getState().tavernSubMode).toBe("rp");
  });

  it("初始化时恢复合法值 simulate", async () => {
    localStorage.setItem(TAV_KEY, "simulate");
    const store = await freshStore();
    expect(store.getState().tavernSubMode).toBe("simulate");
  });

  it("非法存量值回落 rp", async () => {
    localStorage.setItem(TAV_KEY, "bogus");
    const store = await freshStore();
    expect(store.getState().tavernSubMode).toBe("rp");
  });
});
