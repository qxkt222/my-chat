// @vitest-environment jsdom
//
// T-095/096/097/098 — 设置弹窗模型编辑的四个 P2 回归。
//
//   T-095 清空单模型温度后旧值原样保留，无法回退 scope 默认；
//   T-096 删模型只清当前 scope 的 activeModel，另一 scope 残留已删名字；
//   T-097 s.save() 失败无 catch/toast，弹窗不关且用户无反馈；
//   T-098 per-model 参数实时写全局 store，点「取消」不回滚。
//
// 口径:断言 store / dbSaveModel 载荷,不断言像素。

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

const mock = vi.hoisted(() => ({
  saveModel: vi.fn(async (_model: Record<string, unknown>) => undefined),
  saveSetting: vi.fn(async (_key: string, _value: string) => undefined),
  getSetting: vi.fn(async (_key: string) => ""),
  listModels: vi.fn(async (): Promise<Array<Record<string, string>>> => []),
  deleteModel: vi.fn(async (_name: string) => undefined),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    dbSaveModel: mock.saveModel,
    dbSaveSetting: mock.saveSetting,
    dbGetSetting: mock.getSetting,
    dbListModelsDecrypted: mock.listModels,
    dbDeleteModel: mock.deleteModel,
    logDiag: vi.fn(),
  };
});

import { SettingsDialog } from "./SettingsDialog";
import { ToastContainer } from "@/components/ui/Toast";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { useSettingsStore, type SettingsScope } from "@/stores/useSettingsStore";
import type { ModelConfig, ModelParameters } from "@/types";

/** 捕获真实 save 动作:部分用例会替换成 rejecting 版本 */
const realSave = useSettingsStore.getState().save;

function scoped(activeModel: string, parameters: ModelParameters = {}) {
  return {
    activeModel,
    defaultParameters: parameters,
    budgetConfig: { mode: "auto" as const, usage_pct: 90, default_context_window: 8192 },
    globalInstruction: "",
    thinkingEnabled: true,
    reasoningEffort: "high" as const,
    stoppingStrings: [],
  };
}

function mkModel(name: string, parameters?: ModelParameters): ModelConfig {
  return {
    name,
    provider: "openai",
    api_url: "https://example.invalid/v1",
    api_key: "k",
    model: name,
    ...(parameters ? { parameters } : {}),
  };
}

function resetStore(scope: SettingsScope = "work") {
  const values = {
    work: scoped("m1"),
    chat: scoped("m1"),
  };
  useSettingsStore.setState({
    models: [mkModel("m1", { temperature: 0.3 })],
    activeModel: "m1",
    defaultParameters: { temperature: 0.7, max_tokens: 2048 },
    scope,
    scopes: values,
    loaded: true,
    save: realSave,
  });
}

function lastSavedParams(): unknown {
  const call = mock.saveModel.mock.calls.at(-1)?.[0];
  if (!call) throw new Error("dbSaveModel 未被调用");
  return JSON.parse(String(call.params_json));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAppModeStore.setState({ mode: "work", workSubMode: "work", tavernSubMode: "rp" });
  resetStore();
});

afterEach(cleanup);

function renderDialog() {
  const onClose = vi.fn();
  render(
    <>
      <SettingsDialog open onClose={onClose} />
      <ToastContainer />
    </>
  );
  return onClose;
}

describe("T-095 清空 per-model 参数回退 scope 默认", () => {
  it("清空温度后保存，params_json 不再包含 temperature", async () => {
    const onClose = renderDialog();
    const temp = screen.getByLabelText("温度") as HTMLInputElement;
    expect(temp.value).toBe("0.3");

    fireEvent.change(temp, { target: { value: "" } });
    expect(temp.value).toBe("");

    fireEvent.click(screen.getByText("保存", { selector: "button" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    expect(lastSavedParams()).toEqual({});
    expect(useSettingsStore.getState().models[0]?.parameters?.temperature).toBeUndefined();
  });
});

describe("T-098 取消不回滚 per-model 草稿", () => {
  it("改温度后点取消，store 与后续 save 落库都还是旧值", async () => {
    const onClose = renderDialog();
    const temp = screen.getByLabelText("温度") as HTMLInputElement;

    fireEvent.change(temp, { target: { value: "1.5" } });
    // 草稿只在本组件内，未写全局 store
    expect(useSettingsStore.getState().models[0]?.parameters?.temperature).toBe(0.3);

    fireEvent.click(screen.getByText("取消", { selector: "button" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().models[0]?.parameters?.temperature).toBe(0.3);

    // 之后任何一次 save（例如别处触发）都不能把已取消的值写进库
    await useSettingsStore.getState().save();
    expect(lastSavedParams()).toEqual({ temperature: 0.3 });
  });
});

describe("T-097 保存失败有提示且不关闭弹窗", () => {
  it("s.save() reject → toast 出现、onClose 未调用", async () => {
    useSettingsStore.setState({
      save: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const onClose = renderDialog();

    fireEvent.click(screen.getByText("保存", { selector: "button" }));

    await screen.findByText(/保存失败/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("思考开关的浮动 promise 也被 catch（无 unhandled rejection）", async () => {
    useSettingsStore.setState({
      save: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    renderDialog();

    // 思考开关在「通用」tab（默认落在模型 tab）
    fireEvent.click(screen.getByText("通用", { selector: "button" }));
    fireEvent.click(screen.getByText("开启", { selector: "button" }));
    await screen.findByText(/保存失败/);
  });
});

describe("T-096 删模型清理两个 scope 的 activeModel", () => {
  it("删除后 work/chat 都不再指向已删名字", () => {
    useSettingsStore.setState({
      models: [mkModel("m1"), mkModel("m2")],
      activeModel: "m1",
      scopes: { work: scoped("m1"), chat: scoped("m1") },
    });

    useSettingsStore.getState().removeModel("m1");
    const st = useSettingsStore.getState();

    expect(st.models.map((m) => m.name)).toEqual(["m2"]);
    expect(st.activeModel).toBe("");
    expect(st.scopes.work.activeModel).toBe("");
    expect(st.scopes.chat.activeModel).toBe("");
    expect(mock.deleteModel).toHaveBeenCalledWith("m1");
  });
});
