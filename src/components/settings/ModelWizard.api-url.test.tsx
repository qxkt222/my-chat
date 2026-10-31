// @vitest-environment jsdom
//
// T-033 — ModelWizard 自定义 api_url 的入口校验。
//
// 契约：
//   1. 输入 `localhost:11434/v1`，失焦/保存时自动补成 `http://localhost:11434/v1`；
//   2. 输入 `ftp://x` 明确报错，且不会调用 dbSaveModel（不允许保存）；
//   3. 保存前去掉尾斜杠。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const mock = vi.hoisted(() => ({
  saveModel: vi.fn(async (_model: Record<string, unknown>) => undefined),
  saveSetting: vi.fn(async (_key: string, _value: string) => undefined),
  getSetting: vi.fn(async (_key: string) => ""),
  listModels: vi.fn(async () => [] as Array<Record<string, string>>),
  deleteModel: vi.fn(async (_name: string) => undefined),
  logDiag: vi.fn((_message: string) => undefined),
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
    logDiag: mock.logDiag,
  };
});

import { ModelWizard } from "./ModelWizard";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { t } from "@/lib/i18n";

const URL_PLACEHOLDER = /https:\/\/api\.example\.com\/v1/;
const NAME_PLACEHOLDER = "My Relay / 我的中转站";

function resetStore() {
  useSettingsStore.setState({
    models: [],
    activeModel: "",
    loaded: true,
    scope: "work",
    scopes: {
      work: {
        activeModel: "",
        defaultParameters: { temperature: 0.7, max_tokens: 2048 },
        budgetConfig: { mode: "auto", usage_pct: 90, default_context_window: 8192 },
        globalInstruction: "",
        thinkingEnabled: true,
        reasoningEffort: "high",
        stoppingStrings: [],
      },
      chat: {
        activeModel: "",
        defaultParameters: { temperature: 0.7, max_tokens: 2048 },
        budgetConfig: { mode: "auto", usage_pct: 90, default_context_window: 8192 },
        globalInstruction: "",
        thinkingEnabled: true,
        reasoningEffort: "high",
        stoppingStrings: [],
      },
    },
  });
}

function openCustomStep() {
  render(<ModelWizard onDone={vi.fn()} />);
  fireEvent.click(screen.getByText(t("wizard.custom")));
  const urlInput = screen.getByPlaceholderText(URL_PLACEHOLDER) as HTMLInputElement;
  const nameInput = screen.getByPlaceholderText(NAME_PLACEHOLDER) as HTMLInputElement;
  const saveButton = screen
    .getByText(t("wizard.saveUseCustom"))
    .closest("button") as HTMLButtonElement;
  return { urlInput, nameInput, saveButton };
}

beforeEach(() => {
  mock.saveModel.mockClear();
  mock.saveSetting.mockClear();
  resetStore();
});

afterEach(cleanup);

describe("ModelWizard api_url 入口校验", () => {
  it("失焦时把 localhost:11434/v1 补成 http://localhost:11434/v1", () => {
    const { urlInput } = openCustomStep();

    fireEvent.change(urlInput, { target: { value: "localhost:11434/v1" } });
    fireEvent.blur(urlInput);

    expect(urlInput.value).toBe("http://localhost:11434/v1");
  });

  it("保存时补 scheme 并去掉尾斜杠，落库的是归一化后的地址", async () => {
    const { urlInput, nameInput, saveButton } = openCustomStep();

    fireEvent.change(nameInput, { target: { value: "Local Ollama" } });
    fireEvent.change(urlInput, { target: { value: "localhost:11434/v1/" } });
    fireEvent.click(saveButton);

    await waitFor(() => expect(mock.saveModel).toHaveBeenCalledTimes(1));
    expect(mock.saveModel.mock.calls[0]?.[0]).toMatchObject({
      name: "Local Ollama",
      api_url: "http://localhost:11434/v1",
    });
  });

  it("非 http(s) scheme 报错且不保存（失焦路径）", async () => {
    const { urlInput, nameInput, saveButton } = openCustomStep();

    fireEvent.change(nameInput, { target: { value: "Bad Relay" } });
    fireEvent.change(urlInput, { target: { value: "ftp://x" } });
    fireEvent.blur(urlInput);

    expect(screen.getByText(t("wizard.apiUrlScheme"))).toBeTruthy();
    expect(saveButton.disabled).toBe(true);
    fireEvent.click(saveButton);
    await Promise.resolve();
    expect(mock.saveModel).not.toHaveBeenCalled();
  });

  it("非 http(s) scheme 直接点保存也会被拦下（未失焦路径）", async () => {
    const { urlInput, nameInput, saveButton } = openCustomStep();

    fireEvent.change(nameInput, { target: { value: "Bad Relay" } });
    fireEvent.change(urlInput, { target: { value: "ftp://x" } });
    fireEvent.click(saveButton);

    await waitFor(() => expect(screen.getByText(t("wizard.apiUrlScheme"))).toBeTruthy());
    expect(mock.saveModel).not.toHaveBeenCalled();
  });
});
