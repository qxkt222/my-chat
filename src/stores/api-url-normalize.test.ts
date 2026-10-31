// @vitest-environment jsdom
//
// T-033 — 自定义 api_url 的 scheme 归一化。
//
// 背景：ModelWizard 此前只判非空，`localhost:11434/v1` 能保存并当场可用，
// 但下次启动会被前端过滤器与 Rust 自愈同时丢弃。现在入口统一走
// normalizeApiUrl：缺 scheme 自动补 http://，非 http(s) 明确拒绝，
// 已有地址统一去尾斜杠。
//
// 这里钉的是纯函数契约；向导的「失焦补全 / 拒绝保存」在
// ModelWizard.api-url.test.tsx 里用组件行为断言。

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  dbGetSetting: vi.fn(async () => ""),
  dbSaveSetting: vi.fn(async () => undefined),
  dbListModelsDecrypted: vi.fn(async () => []),
  dbSaveModel: vi.fn(async () => undefined),
  dbDeleteModel: vi.fn(async () => undefined),
  logDiag: vi.fn(),
}));

import { normalizeApiUrl } from "./useSettingsStore";

describe("normalizeApiUrl", () => {
  it("补全缺 scheme 的 host:port/path", () => {
    expect(normalizeApiUrl("localhost:11434/v1")).toEqual({
      ok: true,
      url: "http://localhost:11434/v1",
      changed: true,
    });
    expect(normalizeApiUrl("api.example.com/v1")).toEqual({
      ok: true,
      url: "http://api.example.com/v1",
      changed: true,
    });
    expect(normalizeApiUrl("127.0.0.1:8080")).toEqual({
      ok: true,
      url: "http://127.0.0.1:8080",
      changed: true,
    });
  });

  it("保留 http(s) 并去掉首尾空白与尾斜杠", () => {
    expect(normalizeApiUrl("  https://api.example.com/v1/  ")).toEqual({
      ok: true,
      url: "https://api.example.com/v1",
      changed: true,
    });
    expect(normalizeApiUrl("http://localhost:11434/v1")).toEqual({
      ok: true,
      url: "http://localhost:11434/v1",
      changed: false,
    });
  });

  it("拒绝非 http(s) scheme", () => {
    expect(normalizeApiUrl("ftp://x")).toEqual({ ok: false, reason: "scheme" });
    expect(normalizeApiUrl("file:///etc/passwd")).toEqual({ ok: false, reason: "scheme" });
  });

  it("拒绝不像主机名的裸字符串（如误贴 API key）", () => {
    expect(normalizeApiUrl("sk-abcdef123456")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeApiUrl("/v1")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeApiUrl("http://")).toEqual({ ok: false, reason: "invalid" });
  });

  it("空输入返回 empty（由调用方决定是否提示）", () => {
    expect(normalizeApiUrl("   ")).toEqual({ ok: false, reason: "empty" });
  });
});
