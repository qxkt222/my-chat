// @vitest-environment jsdom
//
// components/chat/mcp-step.test.ts — 「对话可用」白名单在工具链里的行为契约
//
// 钉住的行为（不看内部实现，只看对外效果）：
//   1. createLiteAllowStep 对白名单条目做精确命中；`tool="*"` 覆盖整服务器；
//   2. 未命中时 runMcpStep 返回明确错误，且**不发起任何 MCP IPC**
//      （连 mcpListTools 都不该调，否则「不允许」只是调用后的装饰）；
//   3. 未传 allowStep 时行为与改动前完全一致（老调用点不受影响）；
//   4. runMcpChain 遇到不允许的步骤时不调用 mcpCallTool。

import { describe, it, expect, vi, beforeEach } from "vitest";

const ipc = vi.hoisted(() => ({
  mcpListServers: vi.fn(),
  mcpListTools: vi.fn(),
  mcpCallTool: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ipc);

import { runMcpStep, runMcpChain, createLiteAllowStep } from "./mcp-step";
import { t } from "@/lib/i18n";
import type { McpServerDto, McpToolDto } from "@/types";

function server(over: Partial<McpServerDto> = {}): McpServerDto {
  return {
    id: "s1",
    name: "S1",
    command: "cmd",
    args: [],
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function tool(name = "t1"): McpToolDto {
  return { name, description: "", input_schema: { type: "object", properties: {} } };
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.mcpListServers.mockResolvedValue([server()]);
  ipc.mcpListTools.mockResolvedValue([tool()]);
  ipc.mcpCallTool.mockResolvedValue({ ok: true, content: "called" });
});

describe("createLiteAllowStep", () => {
  it("精确命中 (server, tool)，其它组合不放行", () => {
    const allow = createLiteAllowStep([["s1", "t1"]]);
    expect(allow("s1", "t1")).toBe(true);
    expect(allow("s1", "t2")).toBe(false);
    expect(allow("s2", "t1")).toBe(false);
  });

  it("tool='*' 覆盖整台服务器，但不外溢到别的服务器", () => {
    const allow = createLiteAllowStep([["s1", "*"]]);
    expect(allow("s1", "anything")).toBe(true);
    expect(allow("s2", "anything")).toBe(false);
  });

  it("空白名单一律不放行", () => {
    const allow = createLiteAllowStep([]);
    expect(allow("s1", "t1")).toBe(false);
  });
});

describe("runMcpStep — allowStep 门禁", () => {
  it("允许时照常列工具并调用，并向 Rust 声明 scope=chat", async () => {
    const res = await runMcpStep(server(), "t1", "", "", () => true);
    expect(res).toBe("called");
    expect(ipc.mcpListTools).toHaveBeenCalledWith("s1");
    // Rust 侧还会按 scope 再校验一次白名单（双重校验，T-130）。
    expect(ipc.mcpCallTool).toHaveBeenCalledWith("s1", "t1", {}, "chat");
  });

  it("不允许时返回明确错误，且不发起 MCP IPC", async () => {
    const res = await runMcpStep(server(), "t1", "", "", () => false);
    expect(res).toBe(t("chat.mcpLiteDenied", { s: "S1", t: "t1" }));
    expect(res).toContain("S1");
    expect(res).toContain("t1");
    expect(ipc.mcpListTools).not.toHaveBeenCalled();
    expect(ipc.mcpCallTool).not.toHaveBeenCalled();
  });

  it("支持异步 allowStep（便于直接查白名单）", async () => {
    const res = await runMcpStep(server(), "t1", "", "", async () => true);
    expect(res).toBe("called");
  });

  it("不传 allowStep 时按工作模式放行（scope=work）", async () => {
    const res = await runMcpStep(server(), "t1", "", "");
    expect(res).toBe("called");
    expect(ipc.mcpCallTool).toHaveBeenCalledTimes(1);
    expect(ipc.mcpCallTool).toHaveBeenCalledWith("s1", "t1", {}, "work");
  });
});

describe("runMcpChain — allowStep 门禁", () => {
  it("首步被拒绝时不调用 mcpCallTool，并返回拒绝原因", async () => {
    const res = await runMcpChain(
      "S1 t1",
      () => {},
      () => false
    );
    expect(res).toContain("S1");
    expect(res).toContain("t1");
    expect(ipc.mcpCallTool).not.toHaveBeenCalled();
    expect(ipc.mcpListTools).not.toHaveBeenCalled();
  });

  it("允许时正常执行", async () => {
    const res = await runMcpChain(
      "S1 t1",
      () => {},
      () => true
    );
    expect(res).toBe("called");
    expect(ipc.mcpCallTool).toHaveBeenCalledTimes(1);
  });

  it("链中后续步骤被拒绝时，只有前面允许的步骤真正调用", async () => {
    ipc.mcpListTools.mockResolvedValue([tool("t1"), tool("t2")]);
    const allow = createLiteAllowStep([["s1", "t1"]]);
    const res = await runMcpChain("S1 t1 :: t2", () => {}, allow);
    expect(ipc.mcpCallTool).toHaveBeenCalledTimes(1);
    expect(ipc.mcpCallTool).toHaveBeenCalledWith("s1", "t1", {}, "chat");
    expect(res).toContain(t("chat.mcpLiteDenied", { s: "S1", t: "t2" }));
  });
});
