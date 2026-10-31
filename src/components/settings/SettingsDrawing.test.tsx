// @vitest-environment jsdom
//
// 设置 → 绘图 tab（阶段 2c2）的 UI 契约：
//   1. 引擎切到 comfyui → 出现「工作流 JSON」文本框，且 draw_engine 立即落库；
//   2. 「测试连接」→ 调 probe_draw_service(engine, baseUrl, apiKey)，显示在线状态/模型；
//   3. probe 失败 → 状态区显示可读错误（命令 + 错误文本），而不是静默失败。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { SettingsDialog } from "./SettingsDialog";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { useAppConfigStore } from "@/stores/useAppConfigStore";
import {
  DEFAULT_DRAW_CONFIG,
  DEFAULT_DRAW_DEFAULTS,
  useSettingsStore,
} from "@/stores/useSettingsStore";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "probe_draw_service") {
      return Promise.resolve({ online: true, models: ["sd_xl.safetensors"], samplers: ["euler"] });
    }
    return Promise.resolve(undefined);
  });
  useAppConfigStore.setState({ locale: "zh" });
  useAppModeStore.setState({ mode: "work", workSubMode: "work" });
  useSettingsStore.setState({
    drawConfig: { ...DEFAULT_DRAW_CONFIG, defaults: { ...DEFAULT_DRAW_DEFAULTS } },
  });
});

afterEach(cleanup);

function openDrawingTab() {
  render(<SettingsDialog open onClose={vi.fn()} />);
  fireEvent.click(screen.getByText("绘图", { selector: "button" }));
}

describe("SettingsDialog — 绘图 tab", () => {
  it("切到 ComfyUI 后出现工作流 JSON，并立即保存 draw_engine / 默认地址", async () => {
    openDrawingTab();

    fireEvent.change(screen.getByLabelText(/引擎/), { target: { value: "comfyui" } });

    expect(await screen.findByLabelText(/工作流 JSON/)).toBeTruthy();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_setting", {
        key: "draw_engine",
        value: "comfyui",
      })
    );
    // 首次切到本地服务时填默认端口
    expect((screen.getByLabelText(/服务地址/) as HTMLInputElement).value).toBe(
      "http://127.0.0.1:8188"
    );
  });

  it("「测试连接」成功 → probe_draw_service 载荷正确，显示在线状态与模型列表", async () => {
    useSettingsStore.setState({
      drawConfig: {
        ...DEFAULT_DRAW_CONFIG,
        engine: "comfyui",
        baseUrl: "http://127.0.0.1:8188",
        apiKey: "k",
      },
    });
    openDrawingTab();

    fireEvent.click(screen.getByText("测试连接", { selector: "button" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("probe_draw_service", {
        engine: "comfyui",
        baseUrl: "http://127.0.0.1:8188",
        apiKey: "k",
      })
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("在线");
    expect(status.textContent).toContain("sd_xl.safetensors");
  });

  it("probe 失败 → 状态区显示可读错误（含原始错误文本）", async () => {
    useSettingsStore.setState({
      drawConfig: {
        ...DEFAULT_DRAW_CONFIG,
        engine: "comfyui",
        baseUrl: "http://127.0.0.1:8188",
      },
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "probe_draw_service") {
        return Promise.reject("HTTP 500: internal server error");
      }
      return Promise.resolve(undefined);
    });
    openDrawingTab();

    fireEvent.click(screen.getByText("测试连接", { selector: "button" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("连接失败");
    expect(status.textContent).toContain("HTTP 500");
  });

  it("未填服务地址时直接给出提示，不调用 probe", async () => {
    useSettingsStore.setState({
      drawConfig: { ...DEFAULT_DRAW_CONFIG, engine: "comfyui", baseUrl: "" },
    });
    openDrawingTab();

    fireEvent.click(screen.getByText("测试连接", { selector: "button" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("请先填写服务地址");
    expect(invokeMock).not.toHaveBeenCalledWith("probe_draw_service", expect.anything());
  });

  it("服务连不上（online=false）→ 显示「服务未连接」，且不出现「在线」字样", async () => {
    useSettingsStore.setState({
      drawConfig: {
        ...DEFAULT_DRAW_CONFIG,
        engine: "comfyui",
        baseUrl: "http://127.0.0.1:8188",
      },
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "probe_draw_service") {
        return Promise.resolve({ online: false, models: [], samplers: [] });
      }
      return Promise.resolve(undefined);
    });
    openDrawingTab();

    fireEvent.click(screen.getByText("测试连接", { selector: "button" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("服务未连接");
    expect(status.textContent).not.toContain("在线");
    expect(status.textContent).not.toContain("未返回模型列表");
  });

  it("服务在线但无模型 → 显示「在线」且提示未返回模型列表", async () => {
    useSettingsStore.setState({
      drawConfig: {
        ...DEFAULT_DRAW_CONFIG,
        engine: "comfyui",
        baseUrl: "http://127.0.0.1:8188",
      },
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "probe_draw_service") {
        return Promise.resolve({ online: true, models: [], samplers: [] });
      }
      return Promise.resolve(undefined);
    });
    openDrawingTab();

    fireEvent.click(screen.getByText("测试连接", { selector: "button" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("在线");
    expect(status.textContent).toContain("未返回模型列表");
  });

  it("服务在线且有模型 → 显示模型名", async () => {
    useSettingsStore.setState({
      drawConfig: {
        ...DEFAULT_DRAW_CONFIG,
        engine: "comfyui",
        baseUrl: "http://127.0.0.1:8188",
      },
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "probe_draw_service") {
        return Promise.resolve({ online: true, models: ["a.safetensors"], samplers: [] });
      }
      return Promise.resolve(undefined);
    });
    openDrawingTab();

    fireEvent.click(screen.getByText("测试连接", { selector: "button" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("a.safetensors");
  });
});
