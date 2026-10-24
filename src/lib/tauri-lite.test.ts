// lib/tauri-lite.test.ts — 「对话可用」白名单 IPC 封装的载荷契约
//
// Tauri v2 会把 Rust 的 snake_case 参数名映射成 JS 侧 camelCase，
// 这里的断言钉住实际发送的命令名与字段名，防止「勾了但不生效」：
//   mcp_list_lite_tools  → 无参数
//   mcp_set_lite_tool    → { serverId, tool, allowed }

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { mcpListLiteTools, mcpSetLiteTool } from "@/lib/tauri";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("mcpListLiteTools", () => {
  it("调用 mcp_list_lite_tools，返回 (server_id, tool) 二元组数组", async () => {
    invokeMock.mockResolvedValue([
      ["s1", "t1"],
      ["s1", "*"],
    ]);
    await expect(mcpListLiteTools()).resolves.toEqual([
      ["s1", "t1"],
      ["s1", "*"],
    ]);
    expect(invokeMock).toHaveBeenCalledWith("mcp_list_lite_tools");
  });
});

describe("mcpSetLiteTool", () => {
  it("以 camelCase 参数提交勾选状态", async () => {
    invokeMock.mockResolvedValue(undefined);
    await mcpSetLiteTool("s1", "t1", true);
    expect(invokeMock).toHaveBeenCalledWith("mcp_set_lite_tool", {
      serverId: "s1",
      tool: "t1",
      allowed: true,
    });
  });

  it("取消勾选同样提交 allowed=false", async () => {
    invokeMock.mockResolvedValue(undefined);
    await mcpSetLiteTool("s1", "*", false);
    expect(invokeMock).toHaveBeenCalledWith("mcp_set_lite_tool", {
      serverId: "s1",
      tool: "*",
      allowed: false,
    });
  });
});
