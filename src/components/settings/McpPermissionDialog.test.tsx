// @vitest-environment jsdom
//
// McpPermissionDialog 的组件测试（RS-01 三态权限的前端出口）。
//
// 这个弹窗是「未配置权限 = 询问」这条策略真正兑现的地方：后端把 Ask 变成
// `mcp-permission-request` 事件，这里负责展示并回执。它坏掉的表现是
// **MCP 工具调用静默失败**（配合后端 60 秒超时），所以用结构化断言钉住：
//   1. 收到事件 → 弹窗出现，且展示服务器/工具/参数摘要；
//   2. 点「始终允许」→ 回执 `answer=allow, remember=true`；
//   3. 多个请求排队，不并发叠弹窗。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(() => Promise.resolve()),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { McpPermissionDialog } from "./McpPermissionDialog";
import type { McpPermissionRequestDto } from "@/lib/tauri";

type Handler = (event: { payload: McpPermissionRequestDto }) => void;

let emit: Handler | undefined;

function request(over: Partial<McpPermissionRequestDto> = {}): McpPermissionRequestDto {
  return {
    request_id: "r1",
    server_id: "s1",
    server_name: "文件系统",
    tool: "read_file",
    args_preview: '{"path":"/tmp/a.txt"}',
    ...over,
  };
}

/** 等 useEffect 里的 listen() .then 完成，拿到事件回调 */
async function waitForListener() {
  await waitFor(() => expect(emit).toBeTruthy());
}

async function push(req: McpPermissionRequestDto) {
  await act(async () => {
    emit?.({ payload: req });
  });
}

afterEach(cleanup);

beforeEach(() => {
  emit = undefined;
  invokeMock.mockClear();
  listenMock.mockReset();
  listenMock.mockImplementation((_name: string, handler: Handler) => {
    emit = handler;
    return Promise.resolve(() => {});
  });
});

describe("McpPermissionDialog", () => {
  it("收到 mcp-permission-request → 显示服务器/工具/参数摘要", async () => {
    render(<McpPermissionDialog />);
    await waitForListener();

    await push(request());

    expect(screen.getByRole("dialog", { name: "MCP 工具授权" })).toBeTruthy();
    expect(screen.getByText("文件系统")).toBeTruthy();
    expect(screen.getByText("read_file")).toBeTruthy();
    expect(screen.getByText('{"path":"/tmp/a.txt"}')).toBeTruthy();
    expect(screen.getByText("允许一次", { selector: "button" })).toBeTruthy();
    expect(screen.getByText("始终允许", { selector: "button" })).toBeTruthy();
    expect(screen.getByText("拒绝", { selector: "button" })).toBeTruthy();
  });

  it("点「始终允许」→ 回执 answer=allow、remember=true，并关闭弹窗", async () => {
    render(<McpPermissionDialog />);
    await waitForListener();

    await push(request());
    fireEvent.click(screen.getByText("始终允许", { selector: "button" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("mcp_resolve_permission", {
        requestId: "r1",
        answer: "allow",
        remember: true,
      })
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("「允许一次」remember=false，「拒绝」answer=deny", async () => {
    render(<McpPermissionDialog />);
    await waitForListener();

    await push(request({ request_id: "r2" }));
    fireEvent.click(screen.getByText("拒绝", { selector: "button" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("mcp_resolve_permission", {
        requestId: "r2",
        answer: "deny",
        remember: false,
      })
    );

    await push(request({ request_id: "r3" }));
    fireEvent.click(screen.getByText("允许一次", { selector: "button" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("mcp_resolve_permission", {
        requestId: "r3",
        answer: "allow",
        remember: false,
      })
    );
  });

  it("多个请求排队：一次只显示一个，处理完显示下一个", async () => {
    render(<McpPermissionDialog />);
    await waitForListener();

    await push(request({ request_id: "a", tool: "tool_a" }));
    await push(request({ request_id: "b", tool: "tool_b" }));

    // 只显示第一个，另一个在队列里等待
    expect(screen.getByText("tool_a")).toBeTruthy();
    expect(screen.queryByText("tool_b")).toBeNull();
    expect(screen.getByText(/还有 1 个请求排队/)).toBeTruthy();

    fireEvent.click(screen.getByText("允许一次", { selector: "button" }));
    await waitFor(() => expect(screen.getByText("tool_b")).toBeTruthy());
    expect(screen.queryByText(/个请求排队/)).toBeNull();
  });
});
