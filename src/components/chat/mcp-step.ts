// components/chat/mcp-step.ts — 单步 MCP 工具调用（从 ChatInput 抽出）
//
// 原本是 ChatInput 文件末尾的一个顶层异步函数：解析工具名、替换 `{prev}` 占位、
// 调用工具、返回文本结果。它不碰任何组件状态，与那个 900 行的组件毫无关系，
// 只是因为「顺手写在同一个文件里」才一直待在那儿。

import { mcpCallTool, mcpListTools } from "@/lib/tauri";
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
