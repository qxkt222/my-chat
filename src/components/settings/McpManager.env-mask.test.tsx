// @vitest-environment jsdom
//
// T-100 — MCP 服务器 env 的敏感值不得进入 DOM。
//
// 旧实现把 `KEY=VALUE` 全量拼进 hover title,悬停/检查元素即可读到
// token/密码。修复后 title 只显示 key 名,值不渲染。

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { McpManager } from "./McpManager";

const SECRET = "super-secret-token";
const SERVER = {
  id: "s1",
  name: "S1",
  command: "cmd",
  args: [],
  env: { API_KEY: SECRET, PASSWORD: "hunter2" },
  enabled: true,
  created_at: "2026-01-01T00:00:00Z",
};

function routeInvoke(cmd: string) {
  switch (cmd) {
    case "mcp_list_servers":
      return Promise.resolve([SERVER]);
    case "mcp_list_permissions":
    case "mcp_list_grants":
    case "mcp_audit":
    case "mcp_list_lite_tools":
      return Promise.resolve([]);
    default:
      return Promise.resolve(undefined);
  }
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => routeInvoke(cmd));
});

afterEach(cleanup);

describe("T-100 MCP env 值不进 DOM", () => {
  it("hover title 只含 key 名，页面文本/属性均不含值", async () => {
    render(<McpManager />);
    const badge = await screen.findByText("⚙ 2 env");

    expect(badge.getAttribute("title")).toBe("API_KEY, PASSWORD");
    expect(badge.getAttribute("title")).not.toContain(SECRET);

    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain("hunter2");
    for (const el of Array.from(document.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.value).not.toContain(SECRET);
        expect(attr.value).not.toContain("hunter2");
      }
    }
  });
});
