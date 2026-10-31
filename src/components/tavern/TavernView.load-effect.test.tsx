// @vitest-environment jsdom
//
// TavernView 挂载 effect 的回归测试(SRC-01)。
//
// 钉住的事实:组件用整店订阅(`useTavernStore()`)时,store 每次 set 都会返回
// 新对象;若 effect 依赖这个整店对象,就会「set → 新对象 → effect 重跑 → load
// → set」自激,挂载即无限读盘。
//
// 这里的 store 替身刻意保留这个性质:每次 set 都换一个新 state 对象并通知订阅者
// (与 zustand 一致);load 替身异步 set 一次(模拟真实 load 结尾的 set)。
// 预期:无论重渲染多少次,load 只应被调用一次。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor, screen, fireEvent } from "@testing-library/react";

// 所有替身状态放在 vi.hoisted 里(vi.mock 会被提升到 import 之前)
const H = vi.hoisted(() => {
  function mk(initial: Record<string, unknown>) {
    const box: {
      state: Record<string, unknown>;
      subs: Set<() => void>;
      set: (patch: Record<string, unknown>) => void;
    } = {
      state: initial,
      subs: new Set(),
      set(patch) {
        box.state = { ...box.state, ...patch };
        for (const f of box.subs) f();
      },
    };
    return box;
  }

  const tavernBox: ReturnType<typeof mk> = mk({});
  // 真实 load() 结尾会无条件 set(...) → 整店对象换新
  const tavernLoad = vi.fn(async () => {
    tavernBox.set({});
  });

  tavernBox.set({
    conversations: [],
    activeId: null,
    isStreaming: false,
    translatingIds: [],
    loaded: false,
    load: tavernLoad,
    getActive: () => undefined,
    saveConv: async () => {},
    setActive: () => {},
    createWithCharacter: async () => ({ id: "x" }),
    setVariable: async () => {},
    removeVariable: async () => {},
    addAttachment: async () => {},
    removeAttachment: async () => {},
    softReset: async () => {},
    translateMessage: async () => {},
    swipe: async () => {},
    swipeGenerate: async () => {},
    continueMessage: async () => {},
    sendMessage: async () => {},
    sendGroupMessage: async () => {},
    cancelGeneration: () => {},
    setPersona: async () => {},
    setModel: async () => {},
    setSamplerPreset: async () => {},
    setLorebooks: async () => {},
    setNote: async () => {},
    setPinned: async () => {},
    setTranslateTargetLang: () => {},
    setAutoTranslate: () => {},
    setAutoSummarize: () => {},
    setAutoSwipe: () => {},
    summarizeIfNeeded: async () => {},
    resolveModel: () => undefined,
    setGroupActiveChar: async () => {},
    setAutoRespond: async () => {},
  });

  const characterBox = mk({
    characters: [],
    personas: [],
    activePersonaId: null,
    // 组件在渲染期派生世界书/Preset 数据(useMemo),替身需要与真实 store 同形
    enabledLorebookIds: [],
    lorebooks: {},
    globalLorebook: { entries: [] },
    presets: [],
    getActivePersona: () => null,
    loaded: true,
  });
  const settingsBox = mk({
    models: [],
    activeModel: "",
    regexRules: [],
    stoppingStrings: [],
    samplerPresets: [],
    loaded: true,
  });
  const appModeBox = mk({ tavernSubMode: "rp", setTavernSubMode: () => {} });
  const simBox = mk({
    conversations: [],
    activeId: null,
    isStreaming: false,
    getActive: () => undefined,
    load: async () => {},
  });

  return { mk, tavernBox, tavernLoad, characterBox, settingsBox, appModeBox, simBox };
});

// tauri 桥替身(子组件/工具模块在模块初始化时可能触达)
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, getAppDir: vi.fn(async () => "/app"), listDir: vi.fn(async () => []) };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: (p: string) => p,
}));

/** 把 hoisted 的 state 盒包成 zustand 风格的 hook(支持选择器与整店订阅) */
async function hookFor(box: typeof H.tavernBox) {
  const { useSyncExternalStore } = await import("react");
  const useStore = (sel?: (s: Record<string, unknown>) => unknown) =>
    useSyncExternalStore(
      (cb: () => void) => {
        box.subs.add(cb);
        return () => box.subs.delete(cb);
      },
      () => (sel ? sel(box.state) : box.state),
      () => (sel ? sel(box.state) : box.state)
    );
  return Object.assign(useStore, { getState: () => box.state });
}

vi.mock("@/stores/useTavernStore", async () => ({ useTavernStore: await hookFor(H.tavernBox) }));
vi.mock("@/stores/useCharacterStore", async () => ({
  useCharacterStore: await hookFor(H.characterBox),
}));
vi.mock("@/stores/useSettingsStore", async () => ({
  useSettingsStore: await hookFor(H.settingsBox),
}));
vi.mock("@/stores/useAppModeStore", async () => ({ useAppModeStore: await hookFor(H.appModeBox) }));
vi.mock("@/stores/useSimulationStore", async () => ({
  useSimulationStore: await hookFor(H.simBox),
}));

import { TavernView } from "./TavernView";
import { t } from "@/lib/i18n";

/** 给 effect 自激留出多轮重渲染的时间窗 */
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(cleanup);

describe("TavernView 挂载加载", () => {
  it("重渲染多次,store.load 仍只被调用一次", async () => {
    render(<TavernView onOpenSettings={() => {}} />);

    // 等首次 load 与其触发的 set/重渲染落定,再多等几轮
    await waitFor(() => expect(H.tavernLoad).toHaveBeenCalled());
    await sleep(150);

    expect(H.tavernLoad.mock.calls.length).toBe(1);
  });
});

describe("TavernView 记忆图谱关闭", () => {
  it("打开图谱后按 Esc 关闭面板", async () => {
    // 一条空会话即可:图谱面板在 active 存在时渲染(0 节点 / 0 关系)
    const conv = {
      id: "c1",
      character_id: "char1",
      character_name: "测试角色",
      title: "测试会话",
      created_at: "",
      updated_at: "",
      messages: [],
    };
    H.tavernBox.set({
      conversations: [conv],
      activeId: "c1",
      getActive: () => conv,
    });

    render(<TavernView onOpenSettings={() => {}} />);

    // 点击标题栏图谱按钮打开面板
    fireEvent.click(screen.getByTitle(t("graph.title")));
    expect(screen.getByText("0 节点 / 0 关系")).toBeTruthy();

    // Esc 关闭(useEscapeClose)
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("0 节点 / 0 关系")).toBeNull();
  });
});
