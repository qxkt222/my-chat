// components/chat/mcp-step.ts — 单步 MCP 工具调用（从 ChatInput 抽出）
//
// 原本是 ChatInput 文件末尾的一个顶层异步函数：解析工具名、替换 `{prev}` 占位、
// 调用工具、返回文本结果。它不碰任何组件状态，与那个 900 行的组件毫无关系，
// 只是因为「顺手写在同一个文件里」才一直待在那儿。

import { mcpCallTool, mcpListServers, mcpListTools } from "@/lib/tauri";
import { t } from "@/lib/i18n";
import type { McpServerDto } from "@/types";

/**
 * 「对话可用」白名单门禁：返回 true 才允许执行该步骤。
 * 第一个参数是 `server.id`（与 `mcpListLiteTools()` 返回的键一致）。
 * 允许返回 Promise，调用方可直接查一次白名单后闭包复用。
 */
export type AllowStep = (serverId: string, tool: string) => boolean | Promise<boolean>;

const LITE_KEY_SEP = "\u001f";

/**
 * 用 `mcpListLiteTools()` 的结果构造门禁：精确 `(server_id, tool)` 命中，
 * 或该服务器存在 `tool="*"` 通配。与 Rust 侧 `is_lite_allowed` 语义一致。
 */
export function createLiteAllowStep(
  entries: ReadonlyArray<readonly [string, string]>
): (serverId: string, tool: string) => boolean {
  const exact = new Set<string>();
  const wildcard = new Set<string>();
  for (const [serverId, tool] of entries) {
    if (tool === "*") wildcard.add(serverId);
    else exact.add(`${serverId}${LITE_KEY_SEP}${tool}`);
  }
  return (serverId, tool) =>
    wildcard.has(serverId) || exact.has(`${serverId}${LITE_KEY_SEP}${tool}`);
}

/**
 * One MCP tool-call step: 白名单门禁 → resolve tool → substitute {prev} → call it.
 *
 * `allowStep` 省略时行为与改动前完全一致。门禁在**任何 IPC 之前**判定：
 * 被拒绝的步骤连 `mcpListTools` 都不会调用。
 */
export async function runMcpStep(
  server: McpServerDto,
  toolName: string,
  argText: string,
  prev: string,
  allowStep?: AllowStep
): Promise<string> {
  if (allowStep && !(await allowStep(server.id, toolName))) {
    return t("chat.mcpLiteDenied", { s: server.name, t: toolName });
  }
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
 *
 * `allowStep` 省略时行为与改动前完全一致；传入后被拒绝的步骤返回明确说明，
 * 且不发起该步骤的任何 MCP IPC。
 */
export async function runMcpChain(
  args: string,
  setStage: (stage: string) => void,
  allowStep?: AllowStep
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
      outputs.push(await runMcpStep(server, toolFirst, rest.join(" ").trim(), prev, allowStep));
    } else if (server) {
      setStage(`${t("tool.calling")} ${server.name}/${toolNameSafe}`);
      outputs.push(await runMcpStep(server, toolNameSafe, argText, prev, allowStep));
    }

    prev = outputs[outputs.length - 1] ?? "";
    firstServer = false;
  }

  setStage(t("tool.reading"));
  return outputs.join("\n\n---\n\n");
}
