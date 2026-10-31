// @vitest-environment jsdom
//
// TranslateManager 的「本地（OpenAI 兼容）」引擎 UI 契约（阶段 2c1）：
//   1. 引擎下拉切到 local → Base URL / API Key / 模型 / System Prompt /
//      Temperature / 超时 表单全部出现，且空配置时填入 Ollama 默认地址；
//   2. 「拉取模型」→ 调 probe_local_llm(baseUrl, apiKey)，结果填进 datalist；
//   3. 「翻译测试」→ translate_text 的 opts.local 必须带上当前配置；
//   4. 修改表单项 → 立即 save_setting(translate_local_*)。
//
// 为什么钉 IPC 载荷：表单看起来能填、但配置没进 opts.local 的话，测试按钮
// 只会报「未配置本地翻译模型」，界面上却看不出哪一层丢了配置。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { TranslateManager } from "./TranslateManager";
import { useTranslateStore } from "@/stores/useTranslateStore";
import { useLlamaStore } from "@/stores/useLlamaStore";
import { useAppConfigStore } from "@/stores/useAppConfigStore";

const DEFAULT_LOCAL_URL = "http://127.0.0.1:11434/v1";

const INITIAL = {
  engine: "google" as const,
  deeplKey: "",
  libreUrl: "",
  proxyUrl: "",
  localBaseUrl: "",
  localApiKey: "",
  localModel: "",
  localSystemPrompt: "",
  localTemperature: 0.3,
  localTimeoutSecs: 120,
  loaded: true,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "probe_local_llm":
        return Promise.resolve(["qwen2.5:7b", "llama3.1:8b"]);
      case "translate_text":
        return Promise.resolve("你好，我是麻由。");
      default:
        return Promise.resolve(undefined);
    }
  });
  useAppConfigStore.setState({ locale: "zh" });
  useTranslateStore.setState({ ...INITIAL });
  useLlamaStore.setState({
    serverPath: "",
    modelPath: "",
    ctxSize: null,
    nGpuLayers: null,
    port: null,
    status: { running: false },
    starting: false,
    autoFilledUrl: null,
    loaded: true,
  });
});

afterEach(cleanup);

describe("TranslateManager — 本地(OpenAI 兼容)引擎", () => {
  it("切到 local 引擎后显示完整表单，并填入 Ollama 默认地址", async () => {
    render(<TranslateManager />);

    fireEvent.change(screen.getByRole("combobox", { name: "引擎" }), {
      target: { value: "local" },
    });

    const url = (await screen.findByLabelText(/服务地址/)) as HTMLInputElement;
    expect(url.value).toBe(DEFAULT_LOCAL_URL);
    expect(screen.getByLabelText(/API Key/)).toBeTruthy();
    expect(screen.getByLabelText(/^模型/)).toBeTruthy();
    expect(screen.getByLabelText(/System Prompt/)).toBeTruthy();
    expect(screen.getByLabelText(/Temperature/)).toBeTruthy();
    expect(screen.getByLabelText(/超时/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "拉取模型" })).toBeTruthy();

    // 默认地址是真实落库的，而不只是 placeholder
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_setting", {
        key: "translate_local_url",
        value: DEFAULT_LOCAL_URL,
      })
    );
  });

  it("点「拉取模型」→ 调 probe_local_llm 并把模型填进下拉", async () => {
    useTranslateStore.setState({
      engine: "local",
      localBaseUrl: "http://127.0.0.1:1234/v1",
      localApiKey: "lm-studio",
    });
    render(<TranslateManager />);

    fireEvent.click(screen.getByRole("button", { name: "拉取模型" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("probe_local_llm", {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lm-studio",
      })
    );
    await screen.findByText(/已拉取 2 个模型/);
    const options = Array.from(
      document.querySelectorAll<HTMLOptionElement>("#translate-local-models option")
    ).map((o) => o.value);
    expect(options).toEqual(["qwen2.5:7b", "llama3.1:8b"]);
  });

  it("「翻译测试」调用 translate_text，opts.local 带当前配置并显示译文", async () => {
    useTranslateStore.setState({
      engine: "local",
      localBaseUrl: "http://127.0.0.1:11434/v1",
      localApiKey: "",
      localModel: "qwen2.5:7b",
      localSystemPrompt: "只输出译文",
      localTemperature: 0.1,
      localTimeoutSecs: 90,
    });
    render(<TranslateManager />);

    fireEvent.change(screen.getByPlaceholderText(/Hello, I am Masuyo/), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "翻译测试" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("translate_text", {
        text: "hello",
        opts: {
          engine: "local",
          targetLang: "zh-CN",
          deeplKey: "",
          libreUrl: "",
          proxyUrl: "",
          local: {
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "",
            model: "qwen2.5:7b",
            temperature: 0.1,
            systemPrompt: "只输出译文",
            timeoutSecs: 90,
          },
        },
      })
    );
    await screen.findByText("你好，我是麻由。");
  });

  it("T-075：DeepL 测试按钮传引擎语言码 ZH，而不是界面语言名「中文」", async () => {
    useTranslateStore.setState({ engine: "deepl", deeplKey: "abc:fx" });
    render(<TranslateManager />);

    fireEvent.change(screen.getByPlaceholderText(/Hello, I am Masuyo/), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "翻译测试" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "translate_text",
        expect.objectContaining({
          text: "hello",
          opts: expect.objectContaining({
            engine: "deepl",
            targetLang: "ZH",
            deeplKey: "abc:fx",
          }),
        })
      )
    );
  });

  it("修改模型/Temperature/超时 → 立即保存到对应设置键", async () => {
    useTranslateStore.setState({ engine: "local", localBaseUrl: DEFAULT_LOCAL_URL });
    render(<TranslateManager />);

    fireEvent.change(screen.getByLabelText(/^模型/), { target: { value: "qwen2.5:7b" } });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_setting", {
        key: "translate_local_model",
        value: "qwen2.5:7b",
      })
    );

    fireEvent.change(screen.getByLabelText(/Temperature/), { target: { value: "0.2" } });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_setting", {
        key: "translate_local_temperature",
        value: "0.2",
      })
    );

    fireEvent.change(screen.getByLabelText(/超时/), { target: { value: "60" } });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_setting", {
        key: "translate_local_timeout",
        value: "60",
      })
    );
  });
});

// ── 内置 llama.cpp 运行时（用户自备 llama-server.exe + GGUF）──
// 钉住三件事：启动载荷把表单值原样送到后端；成功后自动把本地翻译的
// Base URL 换成实际端口（漏掉它用户就得手动抄端口）；失败原因可见。
describe("TranslateManager — 内置运行时（llama.cpp）", () => {
  const SERVER = "C:\\llama\\llama-server.exe";
  const MODEL = "C:\\models\\qwen2.5-7b.gguf";

  function mockLlama(handlers: Record<string, () => Promise<unknown>>) {
    invokeMock.mockImplementation((cmd: string) => {
      const h = handlers[cmd];
      return h ? h() : Promise.resolve(undefined);
    });
  }

  it("配置路径后点「启动」→ llama_start 载荷与表单一致（端口留空不提交）", async () => {
    mockLlama({
      llama_start: () => Promise.resolve({ running: true, port: 39321, pid: 4242 }),
    });
    useTranslateStore.setState({ engine: "local", localBaseUrl: "" });
    useLlamaStore.setState({ serverPath: SERVER, modelPath: MODEL, ctxSize: 4096, nGpuLayers: 8 });

    render(<TranslateManager />);
    fireEvent.click(screen.getByRole("button", { name: "启动" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("llama_start", {
        cfg: {
          serverPath: SERVER,
          modelPath: MODEL,
          ctxSize: 4096,
          nGpuLayers: 8,
        },
      })
    );
  });

  it("启动成功 → 显示端口/pid，并把 translate_local_url 设为对应 /v1", async () => {
    mockLlama({
      llama_start: () => Promise.resolve({ running: true, port: 39321, pid: 4242 }),
    });
    useTranslateStore.setState({ engine: "local", localBaseUrl: "" });
    useLlamaStore.setState({ serverPath: SERVER, modelPath: MODEL });

    render(<TranslateManager />);
    fireEvent.click(screen.getByRole("button", { name: "启动" }));

    await screen.findByText(/端口 39321 · pid 4242/);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_setting", {
        key: "translate_local_url",
        value: "http://127.0.0.1:39321/v1",
      })
    );
    expect(useTranslateStore.getState().localBaseUrl).toBe("http://127.0.0.1:39321/v1");
    await screen.findByText(/已自动填入 Base URL：http:\/\/127\.0\.0\.1:39321\/v1/);
  });

  it("启动失败 → 显示后端 error 文本，状态不再是运行中", async () => {
    const reason = "llama-server 不存在或不可访问: C:\\bad\\llama-server.exe";
    mockLlama({ llama_start: () => Promise.reject(reason) });
    useTranslateStore.setState({ engine: "local" });
    useLlamaStore.setState({ serverPath: SERVER, modelPath: MODEL });

    render(<TranslateManager />);
    fireEvent.click(screen.getByRole("button", { name: "启动" }));

    await screen.findByText(reason);
    await screen.findByText("启动失败");
    expect(useLlamaStore.getState().status.running).toBe(false);
  });

  it("点「停止」→ 调 llama_stop 并清掉运行中状态", async () => {
    mockLlama({});
    useTranslateStore.setState({ engine: "local" });
    useLlamaStore.setState({
      serverPath: SERVER,
      modelPath: MODEL,
      status: { running: true, port: 39321, pid: 4242 },
    });

    render(<TranslateManager />);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("llama_stop"));
    await waitFor(() => expect(useLlamaStore.getState().status.running).toBe(false));
  });

  it("未配置二进制/模型路径时「启动」禁用", () => {
    useTranslateStore.setState({ engine: "local" });
    render(<TranslateManager />);

    const start = screen.getByRole("button", { name: "启动" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    screen.getByText("先选择 llama-server 与 .gguf 模型");
  });
});
