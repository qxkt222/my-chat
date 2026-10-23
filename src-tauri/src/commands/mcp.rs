// commands/mcp.rs — MCP (Model Context Protocol) client via stdio subprocesses
//
// Each server is launched on demand: spawn `command args`, run JSON-RPC
// handshake (initialize → notifications/initialized), then serve tools/list
// and tools/call. The process is torn down after each request (simple,
// stateless, no zombie children).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// 后端 → 前端：请求用户对一次 MCP 工具调用授权。
pub const MCP_PERMISSION_REQUEST_EVENT: &str = "mcp-permission-request";

/// 权限询问的默认超时：超时按「拒绝」处理，避免调用方无限挂起。
const PERMISSION_TIMEOUT_SECS: u64 = 60;

/// env 中禁止覆盖的高危变量（大小写不敏感）。它们能改变子进程的动态库 /
/// 模块解析 / 解释器搜索路径，等价于任意代码执行。
const BLOCKED_ENV_KEYS: [&str; 4] = ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "PYTHONPATH"];

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

/// RS-02 最小收口：只拒绝「必然导致子进程失控 / 提权」的配置，不做命令白名单
/// （自定义 MCP server 是产品能力，真正的闸门是三态权限询问）。
fn validate_server(server: &McpServer) -> Result<(), String> {
    if server.command.trim().is_empty() {
        return Err("MCP 服务器 command 不能为空（否则无法启动子进程）".to_string());
    }
    for key in server.env.keys() {
        let upper = key.to_ascii_uppercase();
        if BLOCKED_ENV_KEYS.contains(&upper.as_str()) || upper.starts_with("DYLD_") {
            return Err(format!(
                "env 不允许覆盖高危变量 {key}：它会改变子进程的库/模块/解释器搜索路径，可能导致任意代码执行；如确需请直接写进 command"
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_save_server(server: McpServer) -> Result<(), String> {
    validate_server(&server)?;
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
    app: tauri::AppHandle,
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
    // 三态权限:deny 直接拒绝；allow 放行；未配置/显式 ask → 弹窗询问用户。
    let decision = decide_permission(
        &list_permissions()?,
        &list_grants()?,
        &server_id,
        &tool_name,
    );
    match decision {
        PermissionDecision::Deny => {
            return Err(format!("工具 {tool_name} 已被权限策略拒绝（deny）"));
        }
        PermissionDecision::Ask => {
            if !request_permission(&app, &server, &tool_name, &arguments).await? {
                return Err(format!(
                    "工具 {tool_name} 的调用未获授权（用户拒绝或等待超时）"
                ));
            }
        }
        PermissionDecision::Allow => {}
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

/// 一次调用的授权结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionDecision {
    Allow,
    Ask,
    Deny,
}

/// 纯函数权限判定（便于单测，不触碰 sled）：
///
/// 优先级（高 → 低）：
/// 1. 工具级 deny / 服务器级 `*` deny → Deny（deny 永远最高）
/// 2. 工具级 allow → Allow
/// 3. 工具级 ask → Ask（更具体的策略盖过通配）
/// 4. 服务器级 `*` allow → Allow
/// 5. 服务器级 `*` ask → Ask
/// 6. 有效临时授权（工具级或 `*`）→ Allow
/// 7. 其余（含完全未配置）→ **Ask**
///
/// 第 7 条是本轮行为变更的核心：以前未配置 = 直接放行。
fn decide_permission(
    perms: &[McpPermission],
    grants: &[McpGrant],
    server_id: &str,
    tool: &str,
) -> PermissionDecision {
    let hit = |want_tool: &str, action: &str| {
        perms
            .iter()
            .any(|p| p.server_id == server_id && p.tool == want_tool && p.action == action)
    };

    if hit(tool, "deny") || hit("*", "deny") {
        return PermissionDecision::Deny;
    }
    if hit(tool, "allow") {
        return PermissionDecision::Allow;
    }
    if hit(tool, "ask") {
        return PermissionDecision::Ask;
    }
    if hit("*", "allow") {
        return PermissionDecision::Allow;
    }
    if hit("*", "ask") {
        return PermissionDecision::Ask;
    }
    if grants
        .iter()
        .any(|g| g.server_id == server_id && (g.tool == "*" || g.tool == tool))
    {
        return PermissionDecision::Allow;
    }
    PermissionDecision::Ask
}

/// 等待前端回执的挂起请求。
struct PendingPermission {
    sender: tokio::sync::oneshot::Sender<bool>,
    server_id: String,
    tool: String,
}

static PENDING_PERMISSIONS: LazyLock<Mutex<HashMap<String, PendingPermission>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 向前端发事件并等待用户答复。超时 / 通道断开一律按拒绝处理。
async fn request_permission(
    app: &tauri::AppHandle,
    server: &McpServer,
    tool: &str,
    arguments: &serde_json::Value,
) -> Result<bool, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    {
        let mut pending = PENDING_PERMISSIONS
            .lock()
            .map_err(|_| "权限请求表已损坏".to_string())?;
        pending.insert(
            request_id.clone(),
            PendingPermission {
                sender: tx,
                server_id: server.id.clone(),
                tool: tool.to_string(),
            },
        );
    }

    let payload = serde_json::json!({
        "request_id": request_id,
        "server_id": server.id,
        "server_name": server.name,
        "tool": tool,
        "args_preview": redact_args_preview(arguments, 200),
    });
    if let Err(e) = app.emit(MCP_PERMISSION_REQUEST_EVENT, payload) {
        if let Ok(mut pending) = PENDING_PERMISSIONS.lock() {
            pending.remove(&request_id);
        }
        return Err(format!("发送权限请求失败: {e}"));
    }

    match tokio::time::timeout(std::time::Duration::from_secs(PERMISSION_TIMEOUT_SECS), rx).await {
        Ok(Ok(allowed)) => Ok(allowed),
        Ok(Err(_)) => Err("权限请求通道已关闭，已拒绝".to_string()),
        Err(_) => {
            if let Ok(mut pending) = PENDING_PERMISSIONS.lock() {
                pending.remove(&request_id);
            }
            Err(format!(
                "权限请求超时（{PERMISSION_TIMEOUT_SECS} 秒未响应），已拒绝"
            ))
        }
    }
}

/// 前端回执：`answer ∈ allow|deny`；`remember=true` 时写回权限策略。
#[tauri::command]
pub fn mcp_resolve_permission(
    request_id: String,
    answer: String,
    remember: bool,
) -> Result<(), String> {
    let allow = match answer.as_str() {
        "allow" => true,
        "deny" => false,
        other => return Err(format!("answer 只能是 allow 或 deny（收到 {other}）")),
    };

    // 先取元数据但不移除：写权限失败时请求仍可重试。
    let (server_id, tool) = {
        let pending = PENDING_PERMISSIONS
            .lock()
            .map_err(|_| "权限请求表已损坏".to_string())?;
        let p = pending
            .get(&request_id)
            .ok_or_else(|| "权限请求不存在或已过期".to_string())?;
        (p.server_id.clone(), p.tool.clone())
    };

    if remember {
        save_permission(&McpPermission {
            server_id,
            tool,
            action: if allow {
                "allow".to_string()
            } else {
                "deny".to_string()
            },
        })?;
    }

    let pending = PENDING_PERMISSIONS
        .lock()
        .map_err(|_| "权限请求表已损坏".to_string())?
        .remove(&request_id)
        .ok_or_else(|| "权限请求已过期".to_string())?;
    pending
        .sender
        .send(allow)
        .map_err(|_| "权限请求已过期".to_string())?;
    Ok(())
}

/// 审计写入计数：滚动清理不再每次全表扫描，而是每 20 次写触发一次。
static AUDIT_WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// 审计键：毫秒时间戳（13 位定长）+ 进程内自增序号（6 位定长）。
/// 定长保证字典序等于时间序，同时同一毫秒内的多次写入不会互相覆盖。
fn audit_key(ts_millis: i64, seq: u64, tool: &str) -> Vec<u8> {
    crate::db::key(
        "ma",
        &format!("{ts_millis:013}:{:06}:{tool}", seq % 1_000_000),
    )
}

/// 键名命中敏感词（大小写不敏感）即整体脱敏。
fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    ["key", "token", "secret", "password", "auth"]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn redact_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(k, v)| {
                    let safe = if is_sensitive_key(k) {
                        serde_json::Value::String("***".to_string())
                    } else {
                        redact_value(v)
                    };
                    (k.clone(), safe)
                })
                .collect(),
        ),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(redact_value).collect())
        }
        other => other.clone(),
    }
}

/// 参数摘要：先按键名脱敏，再截断到 `max_chars` 个字符。
fn redact_args_preview(args: &serde_json::Value, max_chars: usize) -> String {
    redact_value(args)
        .to_string()
        .chars()
        .take(max_chars)
        .collect()
}

/// 审计日志:写入 sled `mcp_audit`(上限 500 条,每 20 次写滚动清理一次)
fn log_audit(server_id: &str, server_name: &str, tool: &str, args: &serde_json::Value, ok: bool) {
    let Ok(t) = crate::db::tree("mcp_audit") else {
        return;
    };
    let seq = AUDIT_WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let entry = McpAuditEntry {
        ts: chrono_now_secs(),
        server_id: server_id.to_string(),
        server_name: server_name.to_string(),
        tool: tool.to_string(),
        args_preview: redact_args_preview(args, 200),
        ok,
    };
    let _ = t.insert(
        audit_key(now_millis(), seq, tool),
        serde_json::to_vec(&entry).unwrap_or_default(),
    );
    if seq.is_multiple_of(20) {
        // 滚动清理:超过 500 条删最旧(键定长,字典序即时间序)
        let mut all = crate::db::scan_prefix(&t, "ma:");
        all.sort_by(|a, b| a.0.cmp(&b.0));
        while all.len() > 500 {
            if let Some((k, _)) = all.first() {
                let _ = t.remove(k.clone());
            }
            all.remove(0);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn perm(server: &str, tool: &str, action: &str) -> McpPermission {
        McpPermission {
            server_id: server.to_string(),
            tool: tool.to_string(),
            action: action.to_string(),
        }
    }

    fn grant(server: &str, tool: &str) -> McpGrant {
        McpGrant {
            server_id: server.to_string(),
            tool: tool.to_string(),
            expires_at: 0,
        }
    }

    fn mcp_server(command: &str, env: &[(&str, &str)]) -> McpServer {
        McpServer {
            id: "s1".to_string(),
            name: "测试服务器".to_string(),
            command: command.to_string(),
            args: Vec::new(),
            env: env
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
            enabled: true,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    // ── RS-01 三态权限判定 ─────────────────────────────

    #[test]
    fn unconfigured_tool_is_ask_not_allow() {
        // 行为变更核心：没配权限 = 每次询问，而不是旧的「默认放行」。
        assert_eq!(
            decide_permission(&[], &[], "s1", "t1"),
            PermissionDecision::Ask
        );
    }

    #[test]
    fn explicit_ask_is_ask() {
        assert_eq!(
            decide_permission(&[perm("s1", "t1", "ask")], &[], "s1", "t1"),
            PermissionDecision::Ask
        );
    }

    #[test]
    fn tool_deny_beats_server_allow() {
        assert_eq!(
            decide_permission(
                &[perm("s1", "t1", "deny"), perm("s1", "*", "allow")],
                &[grant("s1", "t1")],
                "s1",
                "t1"
            ),
            PermissionDecision::Deny
        );
    }

    #[test]
    fn server_deny_beats_tool_allow() {
        assert_eq!(
            decide_permission(
                &[perm("s1", "t1", "allow"), perm("s1", "*", "deny")],
                &[],
                "s1",
                "t1"
            ),
            PermissionDecision::Deny
        );
    }

    #[test]
    fn tool_allow_allows() {
        assert_eq!(
            decide_permission(&[perm("s1", "t1", "allow")], &[], "s1", "t1"),
            PermissionDecision::Allow
        );
    }

    #[test]
    fn server_wildcard_allow_allows() {
        assert_eq!(
            decide_permission(&[perm("s1", "*", "allow")], &[], "s1", "t1"),
            PermissionDecision::Allow
        );
    }

    #[test]
    fn explicit_tool_ask_beats_server_allow() {
        // 更具体的工具级 ask 必须盖过服务器级 allow，否则用户设的「询问」是摆设。
        assert_eq!(
            decide_permission(
                &[perm("s1", "t1", "ask"), perm("s1", "*", "allow")],
                &[],
                "s1",
                "t1"
            ),
            PermissionDecision::Ask
        );
    }

    #[test]
    fn valid_grant_allows() {
        assert_eq!(
            decide_permission(&[], &[grant("s1", "t1")], "s1", "t1"),
            PermissionDecision::Allow
        );
        assert_eq!(
            decide_permission(&[], &[grant("s1", "*")], "s1", "t1"),
            PermissionDecision::Allow
        );
    }

    #[test]
    fn permission_of_other_server_or_tool_does_not_leak() {
        assert_eq!(
            decide_permission(
                &[
                    perm("other", "t1", "allow"),
                    perm("s1", "other-tool", "allow")
                ],
                &[grant("other", "t1")],
                "s1",
                "t1"
            ),
            PermissionDecision::Ask
        );
    }

    // ── RS-02 保存校验 ─────────────────────────────────

    #[test]
    fn save_rejects_empty_command() {
        let err = validate_server(&mcp_server("   ", &[])).unwrap_err();
        assert!(err.contains("command"), "错误信息应说明 command：{err}");
    }

    #[test]
    fn save_rejects_dangerous_env_case_insensitively() {
        let keys = [
            "PATH",
            "path",
            "Node_Options",
            "LD_PRELOAD",
            "ld_preload",
            "PYTHONPATH",
            "pythonpath",
            "DYLD_INSERT_LIBRARIES",
            "dyld_library_path",
        ];
        for key in keys {
            let s = mcp_server("node", &[(key, "x")]);
            let err = validate_server(&s).expect_err(&format!("高危 env 键 {key} 必须被拒绝"));
            assert!(err.contains(key), "错误信息应点名被拒的键 {key}");
        }
    }

    #[test]
    fn save_accepts_benign_env() {
        let s = mcp_server(
            "node",
            &[("FOO", "bar"), ("MCP_API_URL", "http://localhost")],
        );
        assert!(validate_server(&s).is_ok());
    }

    // ── RS-15 审计脱敏 + 键唯一 ────────────────────────

    #[test]
    fn args_preview_redacts_sensitive_keys_recursively() {
        let args = serde_json::json!({
            "apiKey": "sk-live-123",
            "Token": "abc",
            "password": "hunter2",
            "authorization": "Bearer xyz",
            "client_secret": "s3cr3t",
            "nested": { "db_password": "pw", "safe": "keep" },
            "items": [{ "refresh_token": "rt" }],
            "path": "/tmp/safe",
        });
        let preview = redact_args_preview(&args, 1000);
        assert!(!preview.contains("sk-live-123"), "apiKey 未脱敏：{preview}");
        assert!(!preview.contains("hunter2"), "password 未脱敏：{preview}");
        assert!(!preview.contains("s3cr3t"), "secret 未脱敏：{preview}");
        assert!(!preview.contains("Bearer xyz"), "auth 未脱敏：{preview}");
        assert!(!preview.contains("rt"), "嵌套 token 未脱敏：{preview}");
        assert!(preview.contains("***"), "应出现脱敏占位符：{preview}");
        assert!(preview.contains("keep"), "普通字段不该被误伤：{preview}");
        assert!(
            preview.contains("/tmp/safe"),
            "普通字段不该被误伤：{preview}"
        );
    }

    #[test]
    fn args_preview_truncates_to_limit() {
        let args = serde_json::json!({ "payload": "x".repeat(1000) });
        let preview = redact_args_preview(&args, 200);
        assert!(preview.chars().count() <= 200);
    }

    #[test]
    fn audit_keys_are_unique_within_same_millisecond() {
        let mut seen = std::collections::HashSet::new();
        for i in 0..100_u64 {
            let k = audit_key(1_700_000_000_000, i, "same_tool");
            assert!(seen.insert(k), "同毫秒第 {i} 条审计键发生覆盖");
        }
        assert_eq!(seen.len(), 100);
    }

    #[test]
    fn audit_keys_sort_chronologically() {
        let older = audit_key(1_700_000_000_001, 5, "t");
        let newer = audit_key(1_700_000_000_002, 0, "t");
        assert!(
            older < newer,
            "时间更早的键必须排在前面（滚动清理依赖此序）"
        );
    }
}
