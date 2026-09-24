// components/chat/mcp-step.ts — 单步 MCP 工具调用（从 ChatInput 抽出）
//
// 原本是 ChatInput 文件末尾的一个顶层异步函数：解析工具名、替换 `{prev}` 占位、
// 调用工具、返回文本结果。它不碰任何组件状态，与那个 900 行的组件毫无关系，
// 只是因为「顺手写在同一个文件里」才一直待在那儿。

import { mcpCallTool, mcpListServers, mcpListTools } from "@/lib/tauri";
import { t } from "@/lib/i18n";
import type { McpServerDto } from "@/types";

/** One MCP tool-call step: resolve tool, substitute {prev}, call it. */
export async function runMcpStep(
  server: McpServerDto,
  toolName: string,
  argText: string,
  prev: string
): Promise<string> {
  const tools = await mcpListTools(server.id);
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    return t("chat.mcpNoTools", {
      s: server.name,
      t: toolName,
      list: tools.map((t) => t.name).join("、") || t("chat.mcpNone"),
    });
  }
  let argsObj: Record<string, unknown> = {};
  if (argText) {
    let tpl = argText;
    if (tpl.includes("{prev}")) tpl = tpl.split("{prev}").join(prev);
    try {
      argsObj = JSON.parse(tpl);
    } catch {
      argsObj = { query: tpl };
    }
  }
  const r = await mcpCallTool(server.id, tool.name, argsObj);
  return r.content || t("chat.mcpEmptyResult");
}

/**
 * 执行 `/mcp` 工具链：`<server> <tool> [args] :: <tool2> [args] :: ...`
 *
 * 首步带 server 名，后续步骤复用它（与酒馆的 `::` 链一致）；args 里的 `{prev}`
 * 引用上一步输出。返回拼接后的文本，或一段可直接展示给用户的说明（用法/找不到 server）。
 *
 * 错误不在这里吞：抛出去由调用方决定怎么呈现 —— 那条路径要顺带清掉阶段状态。
 */
export async function runMcpChain(
  args: string,
  setStage: (stage: string) => void
): Promise<string> {
  setStage(t("tool.initialize"));
  const servers = await mcpListServers();
  const steps = args
    .split("::")
    .map((s) => s.trim())
    .filter(Boolean);
  if (steps.length === 0) return t("chat.mcpUsage");

  const outputs: string[] = [];
  let prev = "";
  let firstServer = true;
  let chainServer: McpServerDto | null = null;

  for (const step of steps) {
    const [toolName, ...argParts] = step.split(/\s+/);
    const argText = argParts.join(" ").trim();
    const toolNameSafe = toolName ?? "";
    let server: McpServerDto | null = chainServer;

    if (firstServer) {
      // 首步的第一个 token 是 server 名，不是工具名
      const [srv, toolRaw, ...rest] = step.split(/\s+/);
      server = servers.find((s) => s.name.toLowerCase() === srv?.toLowerCase()) || null;
      if (!server) {
        return t("chat.mcpNotFound", {
          s: srv ?? "",
          list: servers.map((x) => x.name).join("、") || t("chat.mcpNone"),
        });
      }
      chainServer = server;
      const toolFirst = toolRaw ?? "";
      setStage(`${t("tool.calling")} ${server.name}/${toolFirst}`);
      outputs.push(await runMcpStep(server, toolFirst, rest.join(" ").trim(), prev));
    } else if (server) {
      setStage(`${t("tool.calling")} ${server.name}/${toolNameSafe}`);
      outputs.push(await runMcpStep(server, toolNameSafe, argText, prev));
    }

    prev = outputs[outputs.length - 1] ?? "";
    firstServer = false;
  }

  setStage(t("tool.reading"));
  return outputs.join("\n\n---\n\n");
}
