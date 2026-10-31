// stores/useAdapterStore.test.ts — T-136:adapters/*.json 必须过 persist-sanitize
import { describe, it, expect, vi, beforeEach } from "vitest";

const ipc = vi.hoisted(() => ({
  getAppDir: vi.fn(async () => "/app"),
  listDir: vi.fn(async () => [] as string[]),
  readFile: vi.fn(async (_path: string) => ""),
  writeFile: vi.fn(async () => undefined),
  deleteItem: vi.fn(async () => undefined),
  logDiag: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ipc);

import { useAdapterStore } from "./useAdapterStore";

function templateFile(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "t1",
    name: "测试适配器",
    mode: "simple",
    api_url: "https://api.example/v1",
    request_method: "POST",
    request_headers: { "Content-Type": "application/json" },
    request_body_template: "{}",
    sse_enabled: true,
    sse_data_prefix: "data: ",
    sse_done_marker: "[DONE]",
    sse_content_path: "$.choices[0].delta.content",
    response_content_path: "",
    category: "",
    is_preset: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAdapterStore.setState({ templates: [], activeTemplateId: null, loaded: false });
  ipc.getAppDir.mockResolvedValue("/app");
  ipc.listDir.mockResolvedValue([]);
});

describe("useAdapterStore.load（T-136）", () => {
  it("手改 request_headers=null 的模板被清洗为空对象，不崩", async () => {
    ipc.listDir.mockResolvedValue(["t1.json"]);
    ipc.readFile.mockResolvedValue(templateFile({ request_headers: null }));

    await useAdapterStore.getState().load();

    const templates = useAdapterStore.getState().templates;
    expect(templates).toHaveLength(1);
    expect(templates[0]?.request_headers).toEqual({});
    expect(() => Object.keys(templates[0]?.request_headers ?? {})).not.toThrow();
  });

  it("坏 JSON / 缺 id 的文件被隔离，其余模板照常加载", async () => {
    ipc.listDir.mockResolvedValue(["bad.json", "noid.json", "good.json", "note.txt"]);
    ipc.readFile.mockImplementation(async (p: string) => {
      if (String(p).includes("bad.json")) return "{ 不是 json";
      if (String(p).includes("noid.json")) return JSON.stringify({ name: "没有 id" });
      return templateFile({ id: "good" });
    });

    await useAdapterStore.getState().load();

    const templates = useAdapterStore.getState().templates;
    expect(templates.map((t) => t.id)).toEqual(["good"]);
    expect(ipc.logDiag).toHaveBeenCalledTimes(2);
    expect(useAdapterStore.getState().loaded).toBe(true);
  });
});

describe("useAdapterStore.importTemplate（T-136）", () => {
  it("导入的 JSON 同样过 sanitize（null headers → {}）", async () => {
    await useAdapterStore
      .getState()
      .importTemplate(templateFile({ request_headers: null, name: "外部" }));

    const t = useAdapterStore.getState().templates[0];
    expect(t?.name).toBe("外部 (imported)");
    expect(t?.request_headers).toEqual({});
  });

  it("无意义对象（无 name 无 api_url）被拒绝，不生成垃圾模板", async () => {
    await useAdapterStore.getState().importTemplate("{}");
    expect(useAdapterStore.getState().templates).toHaveLength(0);
    expect(ipc.writeFile).not.toHaveBeenCalled();
  });
});
