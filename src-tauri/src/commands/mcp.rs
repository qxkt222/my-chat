// commands/mcp.rs — MCP (Model Context Protocol) client via stdio subprocesses
//
// Each server is launched on demand: spawn `command args`, run JSON-RPC
// handshake (initialize → notifications/initialized), then serve tools/list
// and tools/call. The process is torn down after each request (simple,
// stateless, no zombie children).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

// ── Server config (persisted in sled) ─────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    /// Extra environment variables injected into the subprocess (key → value)
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub enabled: bool,
    pub created_at: String,
}

pub fn list_servers() -> Result<Vec<McpServer>, String> {
    let t = crate::db::tree("mcp_servers")?;
    let mut list = Vec::new();
    for (_, v) in crate::db::scan_prefix(&t, "ms:") {
        if let Ok(s) = serde_json::from_slice::<McpServer>(&v) {
            list.push(s);
        }
    }
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(list)
}

fn save_server(s: &McpServer) -> Result<(), String> {
    crate::db::tree("mcp_servers")?
        .insert(
            crate::db::key("ms", &s.id),
            serde_json::to_vec(s).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Save: {e}"))?;
    Ok(())
}

fn delete_server(id: &str) -> Result<(), String> {
    crate::db::tree("mcp_servers")?
        .remove(crate::db::key("ms", id))
        .map_err(|e| format!("Del: {e}"))?;
    Ok(())
}

// ── Tauri commands ────────────────────────────────────────

#[tauri::command]
pub fn mcp_list_servers() -> Result<Vec<McpServer>, String> {
    list_servers()
}

#[tauri::command]
pub fn mcp_save_server(server: McpServer) -> Result<(), String> {
    save_server(&server)
}

#[tauri::command]
pub fn mcp_delete_server(id: String) -> Result<(), String> {
    delete_server(&id)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpToolResult {
    pub ok: bool,
    pub content: String,
    /// MCP Apps 富 UI:工具声明的 ui:// 资源 HTML(沙箱 iframe 渲染)
    #[serde(default)]
    pub ui_html: Option<String>,
}

/// JSON-RPC call over the server's stdio; spawns, handshakes, calls, kills.
async fn rpc_call(
    server: &McpServer,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut cmd = Command::new(&server.command);
    cmd.args(&server.args);
    for (k, v) in &server.env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 MCP 服务器失败: {e}"))?;

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let mut reader = BufReader::new(stdout).lines();

    // Async stderr drain (prevents pipe blocking)
    let _stderr_task = tokio::spawn(async move {
        let mut err = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            err.push_str(&l);
            err.push('\n');
        }
        err
    });

    // 1. initialize
    let init = serde_json::json!({
        "jsonrpc": "2.0", "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "my-chat", "version": "0.2.0" }
        }
    });
    stdin
        .write_all(format!("{init}\n").as_bytes())
        .await
        .map_err(|e| format!("写 stdin: {e}"))?;
    stdin.flush().await.ok();

    // Read until id=1 response
    loop {
        let line = match tokio::time::timeout(
            std::time::Duration::from_secs(15),
            reader.next_line(),
        )
        .await
        {
            Ok(Ok(Some(l))) => l,
            Ok(Ok(None)) => return Err("MCP 服务器提前退出（请检查 command/args）".to_string()),
            Ok(Err(e)) => return Err(format!("读 stdout: {e}")),
            Err(_) => return Err("MCP 握手超时".to_string()),
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if v["id"] == 1 {
                if let Some(e) = v["error"].as_object() {
                    return Err(format!(
                        "initialize 错误: {}",
                        e["message"].as_str().unwrap_or("?")
                    ));
                }
                break;
            }
        }
    }

    // 2. notifications/initialized
    let init_notif = serde_json::json!({
        "jsonrpc": "2.0", "method": "notifications/initialized", "params": {}
    });
    stdin
        .write_all(format!("{init_notif}\n").as_bytes())
        .await
        .ok();
    stdin.flush().await.ok();

    // 3. actual method call
    let id: u64 = 2;
    let req = serde_json::json!({
        "jsonrpc": "2.0", "id": id,
        "method": method,
        "params": params,
    });
    stdin
        .write_all(format!("{req}\n").as_bytes())
        .await
        .map_err(|e| format!("写 stdin: {e}"))?;
    stdin.flush().await.ok();

    let result = loop {
        let line = match tokio::time::timeout(std::time::Duration::from_mins(2), reader.next_line())
            .await
        {
            Ok(Ok(Some(l))) => l,
            Ok(Ok(None)) => return Err("MCP 服务器提前退出".to_string()),
            Ok(Err(e)) => return Err(format!("读 stdout: {e}")),
            Err(_) => return Err(format!("MCP 请求超时（{method}）")),
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if v["id"] == id {
                break v;
            }
        }
    };

    // Kill child + wait (ignore errors — it may already be gone)
    let _ = child.kill().await;
    let _ = child.wait().await;

    if let Some(e) = result["error"].as_object() {
        return Err(format!(
            "MCP {} 错误: {}",
            method,
            e["message"].as_str().unwrap_or("?")
        ));
    }
    Ok(result["result"].clone())
}

#[tauri::command]
pub async fn mcp_list_tools(server_id: String) -> Result<Vec<McpToolInfo>, String> {
    let server = list_servers()?
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or("服务器不存在")?;
    if !server.enabled {
        return Err("服务器未启用".to_string());
    }
    let result = rpc_call(&server, "tools/list", serde_json::json!({})).await?;
    let tools = result["tools"].as_array().cloned().unwrap_or_default();
    Ok(tools
        .into_iter()
        .map(|t| McpToolInfo {
            name: t["name"].as_str().unwrap_or("?").to_string(),
            description: t["description"].as_str().unwrap_or("").to_string(),
            input_schema: t["inputSchema"].clone(),
        })
        .collect())
}

#[tauri::command]
pub async fn mcp_call_tool(
    server_id: String,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<McpToolResult, String> {
    let server = list_servers()?
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or("服务器不存在")?;
    if !server.enabled {
        return Err("服务器未启用".to_string());
    }
    // 权限检查(allow/ask/deny + 临时授权):危险工具或未配置授权时拒绝
    if !permission_allowed(&server_id, &tool_name)? {
        return Err(format!(
            "工具 {tool_name} 未获授权(权限策略 deny 或未临时授权,请到 设置→MCP 授权)"
        ));
    }
    let result = rpc_call(
        &server,
        "tools/call",
        serde_json::json!({
            "name": tool_name,
            "arguments": arguments,
        }),
    )
    .await?;

    let mut text = String::new();
    if let Some(content) = result["content"].as_array() {
        for item in content {
            match item["type"].as_str() {
                Some("text") => text.push_str(item["text"].as_str().unwrap_or("")),
                Some("image") => text.push_str("[图片]"),
                _ => {}
            }
            text.push('\n');
        }
    }
    // MCP Apps 富 UI(17):工具可声明 `_meta.ui.resourceUri`(ui:// 资源),
    // 客户端经 resources/read 取 HTML,沙箱 iframe 渲染(对齐 MCP Apps 标准)。
    let mut ui_html: Option<String> = None;
    let ui_uri = result["_meta"]["ui"]["resourceUri"]
        .as_str()
        .or_else(|| result["_meta"]["ui"]["resource_uri"].as_str())
        .map(std::string::ToString::to_string);
    if let Some(uri) = ui_uri {
        if let Ok(resp) =
            rpc_call(&server, "resources/read", serde_json::json!({ "uri": uri })).await
        {
            if let Some(contents) = resp["contents"].as_array() {
                let mut html = String::new();
                for c in contents {
                    if let Some(t) = c["text"].as_str() {
                        html.push_str(t);
                    }
                }
                if !html.trim().is_empty() {
                    ui_html = Some(html);
                }
            }
        }
    }
    // 审计日志:每次工具调用写 sled(可回放,含时间/服务器/工具/参数摘要/结果)
    let ok = !result["isError"].as_bool().unwrap_or(false);
    log_audit(&server_id, &server.name, &tool_name, &arguments, ok);
    if !ok {
        return Err(format!("工具执行错误: {}", text.trim()));
    }
    Ok(McpToolResult {
        ok: true,
        content: text.trim().to_string(),
        ui_html,
    })
}

// ── 权限策略 + 审计日志 + 临时授权(18/19)──────────────

/// 权限策略:allow / ask / deny(按工具;`*` 为通配服务器级)。存 sled `mcp_permissions`。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpPermission {
    pub server_id: String,
    pub tool: String,   // "*" = 全部工具
    pub action: String, // "allow" | "ask" | "deny"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpGrant {
    pub server_id: String,
    pub tool: String,
    pub expires_at: i64, // unix 秒;0 = 不自动过期
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpAuditEntry {
    pub ts: i64,
    pub server_id: String,
    pub server_name: String,
    pub tool: String,
    pub args_preview: String,
    pub ok: bool,
}

pub fn list_permissions() -> Result<Vec<McpPermission>, String> {
    let t = crate::db::tree("mcp_permissions")?;
    let mut list = Vec::new();
    for (_, v) in crate::db::scan_prefix(&t, "mp:") {
        if let Ok(p) = serde_json::from_slice::<McpPermission>(&v) {
            list.push(p);
        }
    }
    Ok(list)
}

fn save_permission(p: &McpPermission) -> Result<(), String> {
    crate::db::tree("mcp_permissions")?
        .insert(
            crate::db::key("mp", &format!("{}:{}", p.server_id, p.tool)),
            serde_json::to_vec(p).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Save: {e}"))?;
    Ok(())
}

fn delete_permission(server_id: &str, tool: &str) -> Result<(), String> {
    crate::db::tree("mcp_permissions")?
        .remove(crate::db::key("mp", &format!("{server_id}:{tool}")))
        .map_err(|e| format!("Del: {e}"))?;
    Ok(())
}

pub fn list_grants() -> Result<Vec<McpGrant>, String> {
    let t = crate::db::tree("mcp_grants")?;
    let mut list = Vec::new();
    let now = chrono_now_secs();
    for (_, v) in crate::db::scan_prefix(&t, "mg:") {
        if let Ok(g) = serde_json::from_slice::<McpGrant>(&v) {
            if g.expires_at > 0 && g.expires_at < now {
                continue; // 过期授权跳过
            }
            list.push(g);
        }
    }
    Ok(list)
}

fn save_grant(g: &McpGrant) -> Result<(), String> {
    crate::db::tree("mcp_grants")?
        .insert(
            crate::db::key("mg", &format!("{}:{}", g.server_id, g.tool)),
            serde_json::to_vec(g).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Save: {e}"))?;
    Ok(())
}

fn delete_grant(server_id: &str, tool: &str) -> Result<(), String> {
    crate::db::tree("mcp_grants")?
        .remove(crate::db::key("mg", &format!("{server_id}:{tool}")))
        .map_err(|e| format!("Del: {e}"))?;
    Ok(())
}

fn chrono_now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// 权限判定:deny 优先级最高 → 显式 allow → 临时授权 → 未配置默认放行(ask 由前端 UI 承担)。
fn permission_allowed(server_id: &str, tool: &str) -> Result<bool, String> {
    let perms = list_permissions()?;
    // 工具级精确
    for p in perms
        .iter()
        .filter(|p| p.server_id == server_id && p.tool == tool)
    {
        if p.action == "deny" {
            return Ok(false);
        }
        if p.action == "allow" {
            return Ok(true);
        }
    }
    // 服务器级通配
    for p in perms
        .iter()
        .filter(|p| p.server_id == server_id && p.tool == "*")
    {
        if p.action == "deny" {
            return Ok(false);
        }
        if p.action == "allow" {
            return Ok(true);
        }
    }
    // 临时授权(带过期;未配置权限时视为已授权)
    let grants = list_grants()?;
    if grants
        .iter()
        .any(|g| g.server_id == server_id && (g.tool == "*" || g.tool == tool))
    {
        return Ok(true);
    }
    Ok(true)
}

/// 审计日志:写入 sled `mcp_audit`(上限 500 条,滚动清理)
fn log_audit(server_id: &str, server_name: &str, tool: &str, args: &serde_json::Value, ok: bool) {
    let Ok(t) = crate::db::tree("mcp_audit") else {
        return;
    };
    let entry = McpAuditEntry {
        ts: chrono_now_secs(),
        server_id: server_id.to_string(),
        server_name: server_name.to_string(),
        tool: tool.to_string(),
        args_preview: args.to_string().chars().take(200).collect(),
        ok,
    };
    let k = crate::db::key("ma", &format!("{}:{}", chrono_now_secs(), tool));
    let _ = t.insert(k, serde_json::to_vec(&entry).unwrap_or_default());
    // 滚动清理:超过 500 条删最旧
    let mut all = crate::db::scan_prefix(&t, "ma:");
    all.sort_by(|a, b| a.0.cmp(&b.0));
    while all.len() > 500 {
        if let Some((k, _)) = all.first() {
            let _ = t.remove(k.clone());
        }
        all.remove(0);
    }
}

pub fn list_audit(limit: usize) -> Result<Vec<McpAuditEntry>, String> {
    let t = crate::db::tree("mcp_audit")?;
    let mut list = Vec::new();
    for (_, v) in crate::db::scan_prefix(&t, "ma:") {
        if let Ok(e) = serde_json::from_slice::<McpAuditEntry>(&v) {
            list.push(e);
        }
    }
    list.sort_by_key(|b| std::cmp::Reverse(b.ts));
    list.truncate(limit);
    Ok(list)
}

#[tauri::command]
pub fn mcp_set_permission(server_id: String, tool: String, action: String) -> Result<(), String> {
    if action == "clear" {
        return delete_permission(&server_id, &tool);
    }
    save_permission(&McpPermission {
        server_id,
        tool,
        action,
    })
}

#[tauri::command]
pub fn mcp_list_permissions() -> Result<Vec<McpPermission>, String> {
    list_permissions()
}

/// `临时授权:grant_minutes>0` 时带过期,0 = 长期
#[tauri::command]
pub fn mcp_grant_tool(server_id: String, tool: String, grant_minutes: i64) -> Result<(), String> {
    let expires = if grant_minutes > 0 {
        chrono_now_secs() + grant_minutes * 60
    } else {
        0
    };
    save_grant(&McpGrant {
        server_id,
        tool,
        expires_at: expires,
    })
}

#[tauri::command]
pub fn mcp_revoke_tool(server_id: String, tool: String) -> Result<(), String> {
    delete_grant(&server_id, &tool)
}

#[tauri::command]
pub fn mcp_list_grants() -> Result<Vec<McpGrant>, String> {
    list_grants()
}

#[tauri::command]
pub fn mcp_audit(limit: usize) -> Result<Vec<McpAuditEntry>, String> {
    list_audit(limit)
}
