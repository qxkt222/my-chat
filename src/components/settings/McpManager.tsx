import { useState, useEffect } from "react";
import { Plus, Trash2, Wrench, Play, Puzzle, FileDown, ShieldCheck, KeyRound } from "lucide-react";
import { useT } from "@/lib/i18n";
import { askPrompt } from "@/components/ui/ConfirmDialog";
import {
  mcpListServers,
  mcpSaveServer,
  mcpDeleteServer,
  mcpListTools,
  mcpCallTool,
  mcpListPermissions,
  mcpSetPermission,
  mcpListGrants,
  mcpGrantTool,
  mcpRevokeTool,
  mcpAudit,
  type McpPermissionDto,
  type McpGrantDto,
  type McpAuditDto,
} from "@/lib/tauri";
import { showToast } from "@/components/ui/Toast";
import type { McpServerDto as McpServer, McpToolDto as McpTool } from "@/types";

export function McpManager() {
  const t = useT();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [tools, setTools] = useState<Record<string, McpTool[]>>({});
  const [testing, setTesting] = useState<Record<string, string>>({});
  const [toolOutput, setToolOutput] = useState<Record<string, string>>({});
  const [toolArgs, setToolArgs] = useState<Record<string, string>>({});
  // MCP Apps 富 UI:ui:// 资源 HTML(沙箱 iframe 渲染)
  const [toolUi, setToolUi] = useState<Record<string, string | null>>({});
  // 权限 + 临时授权 + 审计(18/19)
  const [permissions, setPermissions] = useState<McpPermissionDto[]>([]);
  const [grants, setGrants] = useState<McpGrantDto[]>([]);
  const [audit, setAudit] = useState<McpAuditDto[]>([]);
  // 临时授权表单(服务器/工具/分钟)
  const [grantServer, setGrantServer] = useState("");
  const [grantTool, setGrantTool] = useState("");
  const [grantMinutes, setGrantMinutes] = useState(30);

  const refreshSecurity = async () => {
    try {
      setPermissions(await mcpListPermissions());
      setGrants(await mcpListGrants());
      setAudit(await mcpAudit(30));
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    refreshSecurity();
  }, []);

  const refresh = async () => {
    try {
      setServers(await mcpListServers());
    } catch (e) {
      showToast("error", String(e));
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const addServer = async () => {
    if (!name.trim() || !command.trim()) {
      showToast("error", t("mcp.nameRequired"));
      return;
    }
    // Parse env lines "KEY=VALUE"
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    const s: McpServer = {
      id: crypto.randomUUID(),
      name: name.trim(),
      command: command.trim(),
      args: args.split(/\s+/).filter(Boolean),
      env,
      enabled: true,
      created_at: new Date().toISOString(),
    };
    try {
      await mcpSaveServer(s);
      setName("");
      setCommand("");
      setArgs("");
      setEnvText("");
      refresh();
      showToast("success", t("mcp.added"));
    } catch (e) {
      showToast("error", String(e));
    }
  };

  const removeServer = async (id: string) => {
    try {
      await mcpDeleteServer(id);
      refresh();
    } catch (e) {
      showToast("error", String(e));
    }
  };

  // 导入标准 MCP 配置：{"mcpServers":{"name":{"command","args","env"}}}
  const importConfig = async () => {
    const raw = await askPrompt(t("mcp.importPrompt"), '{"mcpServers":{}}');
    if (raw === null) return;
    let parsed: {
      mcpServers?: Record<
        string,
        { command?: string; args?: unknown[]; env?: Record<string, string>; enabled?: boolean }
      >;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      showToast("error", t("mcp.jsonFail"));
      return;
    }
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== "object") {
      showToast("error", t("mcp.missingMcpServers"));
      return;
    }
    const entries = Object.entries(servers);
    if (entries.length === 0) {
      showToast("info", t("mcp.noneToImport"));
      return;
    }
    let ok = 0;
    for (const [name, conf] of entries) {
      if (!conf || !conf.command) {
        showToast("error", t("mcp.skipped", { name }));
        continue;
      }
      const s: McpServer = {
        id: crypto.randomUUID(),
        name,
        command: conf.command,
        args: Array.isArray(conf.args) ? conf.args.map(String) : [],
        env: conf.env && typeof conf.env === "object" ? conf.env : {},
        enabled: conf.enabled !== false,
        created_at: new Date().toISOString(),
      };
      try {
        await mcpSaveServer(s);
        ok++;
      } catch (e) {
        showToast("error", t("mcp.importFail", { name, e: String(e) }));
      }
    }
    refresh();
    if (ok > 0) showToast("success", t("mcp.imported", { n: ok }));
  };

  const loadTools = async (s: McpServer) => {
    if (!s.enabled) {
      showToast("info", t("mcp.notEnabled", { name: s.name }));
      return;
    }
    setTesting((p) => ({ ...p, [s.id]: "loading" }));
    try {
      const list = await mcpListTools(s.id);
      setTools((p) => ({ ...p, [s.id]: list }));
      setTesting((p) => ({ ...p, [s.id]: "" }));
    } catch (e) {
      setTesting((p) => ({ ...p, [s.id]: "" }));
      showToast("error", `${s.name}: ${e}`);
    }
  };

  const runTool = async (s: McpServer, tool: McpTool) => {
    let argsObj: Record<string, unknown> = {};
    try {
      const raw = toolArgs[tool.name];
      argsObj = raw ? JSON.parse(raw) : {};
    } catch {
      showToast("error", t("mcp.invalidJson"));
      return;
    }
    setTesting((p) => ({ ...p, [`${s.id}:${tool.name}`]: "running" }));
    try {
      const r = await mcpCallTool(s.id, tool.name, argsObj);
      setToolOutput((p) => ({ ...p, [`${s.id}:${tool.name}`]: r.content || t("mcp.emptyResult") }));
      // MCP Apps 富 UI:工具返回 ui:// 资源时,沙箱 iframe 渲染(而非纯文本)
      setToolUi((p) => ({ ...p, [`${s.id}:${tool.name}`]: r.ui_html || null }));
    } catch (e) {
      setToolOutput((p) => ({ ...p, [`${s.id}:${tool.name}`]: t("mcp.error", { e: String(e) }) }));
      setToolUi((p) => ({ ...p, [`${s.id}:${tool.name}`]: null }));
    }
    setTesting((p) => ({ ...p, [`${s.id}:${tool.name}`]: "" }));
  };

  return (
    <div className="space-y-5">
      {/* Add server */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <Puzzle className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">{t("mcp.title")}</span>
          <span className="text-[10px] text-muted-foreground">{t("mcp.titleHint")}</span>
        </div>
        <div className="space-y-1.5 mb-3">
          <div className="flex gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("mcp.namePlaceholder")}
              className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
            />
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("mcp.commandPlaceholder")}
              className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
            />
          </div>
          <input
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder={t("mcp.argsPlaceholder")}
            className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
          />
          <textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            rows={2}
            placeholder={t("mcp.envPlaceholder")}
            className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
          />
          <div className="flex gap-1.5">
            <button
              onClick={addServer}
              className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> {t("mcp.add")}
            </button>
            <button
              onClick={importConfig}
              className="px-3 py-1.5 text-xs border border-input rounded hover:bg-muted text-muted-foreground flex items-center gap-1"
              title={t("mcp.importTitle")}
            >
              <FileDown className="w-3.5 h-3.5" /> {t("mcp.import")}
            </button>
          </div>
        </div>

        {servers.length === 0 && (
          <p className="text-[11px] text-muted-foreground">{t("mcp.empty")}</p>
        )}
      </div>

      {/* Server list */}
      {servers.map((s) => (
        <div key={s.id} className="border border-border rounded-md overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full ${s.enabled ? "bg-green-500/20 text-green-500" : "bg-muted text-muted-foreground"}`}
            >
              {s.enabled ? t("mcp.enabled") : t("mcp.disabled")}
            </span>
            <span className="text-xs font-medium flex-1">{s.name}</span>
            <span className="text-[10px] text-muted-foreground truncate max-w-[200px]">
              {s.command}
            </span>
            {Object.keys(s.env || {}).length > 0 && (
              <span
                className="text-[10px] text-muted-foreground shrink-0"
                title={Object.entries(s.env || {})
                  .map(([k, v]) => `${k}=${v}`)
                  .join("\n")}
              >
                ⚙ {Object.keys(s.env || {}).length} env
              </span>
            )}
            <button
              onClick={() => loadTools(s)}
              disabled={testing[s.id] === "loading"}
              className="p-1 rounded hover:bg-muted text-muted-foreground"
              title={t("mcp.loadTools")}
            >
              <Wrench className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => removeServer(s.id)}
              className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
              title={t("mcp.delete")}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Tools */}
          {(tools[s.id] || []).map((tool) => (
            <div key={tool.name} className="px-3 py-2 border-t border-border">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{tool.name}</span>
                {tool.description && (
                  <span className="text-[10px] text-muted-foreground truncate flex-1">
                    {tool.description}
                  </span>
                )}
                <button
                  onClick={() => runTool(s, tool)}
                  disabled={testing[`${s.id}:${tool.name}`] === "running"}
                  className="px-2 py-0.5 text-[10px] rounded bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-0.5 shrink-0"
                >
                  <Play className="w-3 h-3" />{" "}
                  {testing[`${s.id}:${tool.name}`] === "running" ? t("mcp.calling") : t("mcp.call")}
                </button>
              </div>
              <div className="mt-1 flex gap-1.5">
                <input
                  value={toolArgs[tool.name] || ""}
                  onChange={(e) => setToolArgs((p) => ({ ...p, [tool.name]: e.target.value }))}
                  placeholder={t("mcp.argsJsonPlaceholder", {
                    example: JSON.stringify(exampleArgs(tool.input_schema)),
                  })}
                  className="flex-1 px-2 py-1 text-[11px] bg-background border border-input rounded font-mono"
                />
              </div>
              {toolUi[`${s.id}:${tool.name}`] ? (
                <div className="mt-1 border border-border rounded overflow-hidden">
                  <iframe
                    sandbox="allow-scripts allow-same-origin"
                    srcDoc={toolUi[`${s.id}:${tool.name}`] || undefined}
                    className="w-full h-64 bg-background"
                    title={`${tool.name} ui`}
                  />
                </div>
              ) : (
                toolOutput[`${s.id}:${tool.name}`] && (
                  <pre className="mt-1 p-2 text-[11px] bg-muted rounded whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {toolOutput[`${s.id}:${tool.name}`]}
                  </pre>
                )
              )}
            </div>
          ))}
          {(tools[s.id] || []).length === 0 && (
            <p className="px-3 py-1.5 text-[10px] text-muted-foreground border-t border-border">
              {t("mcp.noTools")}
            </p>
          )}
        </div>
      ))}

      {/* 权限 + 临时授权 + 审计日志(18/19):allow/ask/deny 策略 + 带过期授权 + 调用回放 */}
      <div className="border border-border rounded-md overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
          <ShieldCheck className="w-4 h-4 text-primary" />
          <span className="text-xs font-medium">{t("mcp.securityTitle")}</span>
          <span className="text-[10px] text-muted-foreground">{t("mcp.securityHint")}</span>
          <div className="flex-1" />
          <button
            onClick={refreshSecurity}
            className="p-1 rounded hover:bg-muted text-muted-foreground"
            title={t("mcp.refreshSecurity")}
          >
            <Wrench className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="p-3 space-y-3">
          {/* 权限策略列表 */}
          {permissions.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                {t("mcp.permissions")}
              </div>
              {permissions.map((p) => (
                <div
                  key={`${p.server_id}:${p.tool}`}
                  className="flex items-center gap-2 text-[11px]"
                >
                  <span className="text-muted-foreground truncate flex-1">
                    {p.server_id}/{p.tool === "*" ? "*" : p.tool}
                  </span>
                  <select
                    value={p.action}
                    onChange={(e) => {
                      void mcpSetPermission(p.server_id, p.tool, e.target.value).then(
                        refreshSecurity
                      );
                    }}
                    className="px-1.5 py-0.5 text-[11px] bg-background border border-input rounded"
                  >
                    <option value="allow">allow</option>
                    <option value="ask">ask</option>
                    <option value="deny">deny</option>
                  </select>
                  <button
                    onClick={() =>
                      void mcpSetPermission(p.server_id, p.tool, "clear").then(refreshSecurity)
                    }
                    className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                    title={t("mcp.clearPermission")}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* 临时授权列表 */}
          <div className="space-y-1">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1">
              <KeyRound className="w-3 h-3" /> {t("mcp.grants")}
            </div>
            {/* 添加授权:服务器 + 工具 + 分钟(带过期,OpenClaw attach 式) */}
            <div className="flex gap-1">
              <select
                value={grantServer}
                onChange={(e) => setGrantServer(e.target.value)}
                className="flex-1 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
              >
                <option value="">{t("mcp.grantServer")}</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select
                value={grantTool}
                onChange={(e) => setGrantTool(e.target.value)}
                className="flex-1 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
              >
                <option value="*">*</option>
                {(tools[grantServer] || []).map((tl) => (
                  <option key={tl.name} value={tl.name}>
                    {tl.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                value={grantMinutes}
                onChange={(e) => setGrantMinutes(+e.target.value || 30)}
                className="w-16 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
                title={t("mcp.grantMinutes")}
              />
              <button
                onClick={() => {
                  if (!grantServer) {
                    showToast("error", t("mcp.grantNeedServer"));
                    return;
                  }
                  void mcpGrantTool(grantServer, grantTool || "*", grantMinutes).then(() => {
                    setGrantServer("");
                    setGrantTool("");
                    refreshSecurity();
                    showToast("success", t("mcp.grantAdded"));
                  });
                }}
                className="px-2 py-1 text-[11px] rounded bg-primary/10 text-primary hover:bg-primary/20 shrink-0"
              >
                {t("mcp.grantAdd")}
              </button>
            </div>
            {grants.length === 0 && (
              <p className="text-[10px] text-muted-foreground">{t("mcp.noGrants")}</p>
            )}
            {grants.map((g) => (
              <div key={`${g.server_id}:${g.tool}`} className="flex items-center gap-2 text-[11px]">
                <span className="text-muted-foreground truncate flex-1">
                  {g.server_id}/{g.tool === "*" ? "*" : g.tool}
                  {g.expires_at > 0 && (
                    <span className="text-[9px] text-primary ml-1">
                      ~{new Date(g.expires_at * 1000).toLocaleTimeString()}
                    </span>
                  )}
                </span>
                <button
                  onClick={() => void mcpRevokeTool(g.server_id, g.tool).then(refreshSecurity)}
                  className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                  title={t("mcp.revoke")}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
          {/* 审计日志 */}
          <div className="space-y-1">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
              {t("mcp.audit")}
            </div>
            {audit.length === 0 && (
              <p className="text-[10px] text-muted-foreground">{t("mcp.noAudit")}</p>
            )}
            {audit.map((a, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[10px]">
                <span
                  className={`px-1 py-px rounded-full shrink-0 ${
                    a.ok ? "bg-green-500/15 text-green-500" : "bg-destructive/15 text-destructive"
                  }`}
                >
                  {a.ok ? "OK" : "ERR"}
                </span>
                <span className="text-muted-foreground shrink-0">
                  {new Date(a.ts * 1000).toLocaleTimeString()}
                </span>
                <span className="text-foreground/80 truncate">
                  {a.server_name}/{a.tool} {a.args_preview}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function exampleArgs(schema: unknown): Record<string, unknown> {
  const props = (
    schema as { properties?: Record<string, { type?: string; default?: unknown }> } | null
  )?.properties;
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = v.type === "number" ? 0 : v.type === "boolean" ? true : v.default || "";
  }
  return out;
}
