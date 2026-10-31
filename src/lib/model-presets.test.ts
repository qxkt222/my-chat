// lib/model-presets.test.ts — T-113:模型列表 URL 三形态 + 失败信息
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildModelsUrl, fetchModelsFromAPI } from "./model-presets";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildModelsUrl（与 Rust build_api_url 三形态一致）", () => {
  it("裸 base → 补 /v1/models", () => {
    expect(buildModelsUrl("https://api.example.com")).toBe("https://api.example.com/v1/models");
  });

  it("已带 /v1 → 不再重复拼 v1", () => {
    expect(buildModelsUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/models");
  });

  it("已带 /v2 → 同级 /models", () => {
    expect(buildModelsUrl("https://api.example.com/v2/")).toBe("https://api.example.com/v2/models");
  });

  it("完整 chat 端点 → 同级 /models（不产生 /v1/v1/models 或 /chat/completions/models）", () => {
    expect(buildModelsUrl("https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com/v1/models"
    );
    expect(buildModelsUrl("https://api.example.com/chat/completions")).toBe(
      "https://api.example.com/models"
    );
  });

  it("已经是 /models → 原样（幂等）", () => {
    expect(buildModelsUrl("https://api.example.com/v1/models")).toBe(
      "https://api.example.com/v1/models"
    );
  });

  it("空 URL → 明确报错，而不是请求 /v1/models", () => {
    expect(() => buildModelsUrl("   ")).toThrow(/api_url/);
  });
});

describe("fetchModelsFromAPI", () => {
  it("按推导出的 URL 请求并排序返回 id", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "b-model" }, { id: "a-model" }, {}] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const list = await fetchModelsFromAPI("https://api.example.com/v1", "sk-test");
    expect(list).toEqual(["a-model", "b-model"]);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.anything());
  });

  it("非 2xx → 错误里带状态码、实际 URL 与响应体片段（不再静默裸抛）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        text: async () => '{"error":"not found"}',
      }))
    );

    await expect(fetchModelsFromAPI("https://api.example.com/v1", "k")).rejects.toThrow(
      /HTTP 404 .*\/v1\/models.*not found/
    );
  });
});
