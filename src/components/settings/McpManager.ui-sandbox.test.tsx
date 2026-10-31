// @vitest-environment jsdom
//
// T-008：MCP Apps 富 UI 的 sandbox 契约。
//
// ui_html 是服务器提供的不可信 HTML。`allow-scripts` + `allow-same-origin`
// 同时开启时，srcdoc 文档继承宿主源，sandbox 形同虚设；dev CSP 的
// unsafe-inline 又允许内联脚本执行 → 服务器 HTML 能直接调用 Tauri IPC。
// 这里钉住：脚本能力保留（富 UI 可运行），同源能力必须被拿掉。

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
const UI_HTML = "<html><body><script>window.__pwned = 1</script>rich</body></html>";

function routeInvoke(cmd: string) {
  switch (cmd) {
    case "mcp_list_servers":
      return Promise.resolve([SERVER]);
    case "mcp_list_permissions":
    case "mcp_list_grants":
    case "mcp_audit":
    case "mcp_list_lite_tools":
      return Promise.resolve([]);
    case "mcp_list_tools":
      return Promise.resolve([TOOL]);
    case "mcp_call_tool":
      return Promise.resolve({ ok: true, content: "rich", ui_html: UI_HTML });
    default:
      return Promise.resolve(undefined);
  }
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => routeInvoke(cmd));
});

afterEach(cleanup);

describe("McpManager — MCP Apps ui_html sandbox", () => {
  it("富 UI 只开 allow-scripts，不得开 allow-same-origin", async () => {
    render(<McpManager />);
    fireEvent.click(await screen.findByTitle("加载工具"));
    await screen.findByText("t1");

    fireEvent.click(screen.getByText("调用"));

    const frame = await waitFor(() => {
      const el = document.querySelector("iframe");
      if (!el) throw new Error("ui_html 存在时应渲染 iframe");
      return el as HTMLIFrameElement;
    });

    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toBe("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain("<html>");
    // 设置页的手动「调用」属于工作区，显式带 scope=work（Rust 侧缺省按对话校验）。
    expect(invokeMock).toHaveBeenCalledWith("mcp_call_tool", {
      serverId: "s1",
      toolName: "t1",
      arguments: {},
      scope: "work",
    });
  });
});
