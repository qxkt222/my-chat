// @vitest-environment jsdom
//
// McpManager 的「对话可用」白名单 UI 契约：
//   1. 打开设置时读 mcp_list_lite_tools，已勾选的工具回显为选中；
//   2. 勾选/取消单个工具 → 立即调用 mcp_set_lite_tool(serverId, tool, allowed)；
//   3. 服务器标题行的「整服务器对话可用」→ 写入 tool="*"。
//
// 为什么钉 IPC 载荷：勾选框只改本地 state 不落库的话，界面上看起来生效，
// 一进对话模式就全部被拦——这类「假生效」只有断言载荷能抓住。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { McpManager } from "./McpManager";

const SERVER = {
  id: "s1",
  name: "S1",
  command: "cmd",
  args: [],
  env: {},
  enabled: true,
  created_at: "2026-01-01T00:00:00Z",
};
const TOOL = { name: "t1", description: "d", input_schema: { type: "object" } };

function routeInvoke(cmd: string) {
  switch (cmd) {
    case "mcp_list_servers":
      return Promise.resolve([SERVER]);
    case "mcp_list_permissions":
    case "mcp_list_grants":
    case "mcp_audit":
      return Promise.resolve([]);
    case "mcp_list_lite_tools":
      return Promise.resolve([["s1", "t1"]]);
    case "mcp_list_tools":
      return Promise.resolve([TOOL]);
    default:
      return Promise.resolve(undefined);
  }
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => routeInvoke(cmd));
});

afterEach(cleanup);

async function openToolList() {
  render(<McpManager />);
  fireEvent.click(await screen.findByTitle("加载工具"));
  await screen.findByText("t1");
}

describe("McpManager — 对话可用白名单", () => {
  it("加载白名单后，已授权工具回显为选中", async () => {
    await openToolList();
    const toolBox = screen.getByLabelText("对话可用") as HTMLInputElement;
    expect(toolBox.checked).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("mcp_list_lite_tools");
  });

  it("取消勾选工具 → 立即保存 allowed=false", async () => {
    await openToolList();
    fireEvent.click(screen.getByLabelText("对话可用"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("mcp_set_lite_tool", {
        serverId: "s1",
        tool: "t1",
        allowed: false,
      })
    );
  });

  it("勾选「整服务器对话可用」→ 保存 tool='*'", async () => {
    await openToolList();
    fireEvent.click(screen.getByLabelText("整服务器对话可用"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("mcp_set_lite_tool", {
        serverId: "s1",
        tool: "*",
        allowed: true,
      })
    );
  });
});
