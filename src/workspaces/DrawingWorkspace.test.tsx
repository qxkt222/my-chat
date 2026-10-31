// @vitest-environment jsdom
//
// DrawingWorkspace（阶段 2c2）的 IPC 载荷契约：
//   1. 独立引擎（comfyui）→ generate_image 的 req 必须带 engine/baseUrl/negative/
//      steps/cfg/seed/sampler/workflowJson，前端不再拼图片端点 URL；
//   2. chat-model 旧行为 → 从当前聊天模型推导 openai 引擎与连接信息，baseUrl 原样
//      交给 Rust 归一化；
//   3. 多图结果全部展示；
//   4. 失败时错误可见（role=alert）；
//   5. 切走工作区（卸载）再回来，输入不丢。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  convertFileSrc: (p: string) => `asset://${p}`,
}));

import { DrawingWorkspace } from "./DrawingWorkspace";
import { useAppConfigStore } from "@/stores/useAppConfigStore";
import {
  DEFAULT_DRAW_CONFIG,
  DEFAULT_DRAW_DEFAULTS,
  useSettingsStore,
} from "@/stores/useSettingsStore";

const MODELS = [
  {
    name: "chat-model",
    provider: "",
    api_url: "https://api.example.com/v1/chat/completions",
    api_key: "sk-chat",
    model: "dall-e-3",
    parameters: {},
  },
];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "generate_image") {
      return Promise.resolve([
        { path: "C:/gen/a.png", mime: "image/png" },
        { path: "C:/gen/b.png", mime: "image/png" },
      ]);
    }
    return Promise.resolve(undefined);
  });
  useAppConfigStore.setState({ locale: "zh" });
  useSettingsStore.setState({
    models: [...MODELS],
    activeModel: "chat-model",
    drawConfig: {
      ...DEFAULT_DRAW_CONFIG,
      engine: "comfyui",
      baseUrl: "http://127.0.0.1:8188",
      model: "sd_xl.safetensors",
      defaults: { ...DEFAULT_DRAW_DEFAULTS },
      comfyWorkflow: '{"1":{"class_type":"KSampler"}}',
    },
  });
});

afterEach(cleanup);

function reqSent(): Record<string, unknown> {
  const call = invokeMock.mock.calls.find((c) => c[0] === "generate_image");
  if (!call) throw new Error("未调用 generate_image");
  return (call[1] as { req: Record<string, unknown> }).req;
}

describe("DrawingWorkspace — 独立绘图服务", () => {
  it("生成时提交 engine/baseUrl/negative/steps/cfg/seed/sampler/workflowJson", async () => {
    render(<DrawingWorkspace />);

    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "a cat" } });
    fireEvent.change(screen.getByLabelText(/负面提示词/), { target: { value: "dog" } });
    fireEvent.change(screen.getByLabelText(/尺寸/), { target: { value: "768x768" } });
    fireEvent.change(screen.getByLabelText(/步数/), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText(/CFG/), { target: { value: "6.5" } });
    fireEvent.change(screen.getByLabelText(/种子/), { target: { value: "42" } });
    fireEvent.change(screen.getByLabelText(/采样器/), { target: { value: "euler" } });

    fireEvent.click(screen.getByText("生成图片", { selector: "button" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(reqSent()).toMatchObject({
      engine: "comfyui",
      baseUrl: "http://127.0.0.1:8188",
      model: "sd_xl.safetensors",
      prompt: "a cat",
      negativePrompt: "dog",
      size: "768x768",
      steps: 25,
      cfgScale: 6.5,
      seed: 42,
      sampler: "euler",
      workflowJson: '{"1":{"class_type":"KSampler"}}',
    });
    // 前端不再拼接 /v1/images/generations
    expect(String(reqSent().baseUrl)).not.toContain("/images/generations");

    // 多图全部展示
    expect(await screen.findAllByRole("img")).toHaveLength(2);
    expect(screen.getByText(/已生成 2 张/)).toBeTruthy();
  });

  it("chat-model 旧行为：从当前聊天模型推导 openai 请求，baseUrl 原样交给 Rust", async () => {
    useSettingsStore.setState({
      drawConfig: { ...DEFAULT_DRAW_CONFIG, defaults: { ...DEFAULT_DRAW_DEFAULTS } },
    });
    render(<DrawingWorkspace />);

    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "a dog" } });
    fireEvent.click(screen.getByText("生成图片", { selector: "button" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(reqSent()).toMatchObject({
      engine: "openai",
      baseUrl: "https://api.example.com/v1/chat/completions",
      apiKey: "sk-chat",
      model: "dall-e-3",
      prompt: "a dog",
    });
  });

  it("生成失败时错误可见（role=alert 含原始错误）", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "generate_image") return Promise.reject("HTTP 401: unauthorized");
      return Promise.resolve(undefined);
    });
    render(<DrawingWorkspace />);

    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "a cat" } });
    fireEvent.click(screen.getByText("生成图片", { selector: "button" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("HTTP 401");
  });

  it("切走工作区（卸载）再回来，提示词与结果仍在", async () => {
    const first = render(<DrawingWorkspace />);
    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "keep me" } });
    fireEvent.click(screen.getByText("生成图片", { selector: "button" }));
    await screen.findAllByRole("img");
    first.unmount();

    render(<DrawingWorkspace />);
    expect((screen.getByLabelText("提示词") as HTMLTextAreaElement).value).toBe("keep me");
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });
});
