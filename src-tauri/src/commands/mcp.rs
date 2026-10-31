// commands/mcp.rs — MCP (Model Context Protocol) client via stdio subprocesses
//
// Each server is launched on demand: spawn `command args`, run JSON-RPC
// handshake (initialize → notifications/initialized), then serve tools/list
// and tools/call. The process is torn down after each request (simple,
// stateless, no zombie children).

use crate::db::encryption;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

/// 后端 → 前端：请求用户对一次 MCP 工具调用授权。
pub const MCP_PERMISSION_REQUEST_EVENT: &str = "mcp-permission-request";

/// 权限询问的默认超时：超时按「拒绝」处理，避免调用方无限挂起。
const PERMISSION_TIMEOUT_SECS: u64 = 60;

/// env 值在 sled 中的密文前缀。带前缀 = DPAPI 密文；无前缀 = 旧版明文，
/// 读取时按明文使用并惰性迁移为密文（T-042）。
const ENV_CIPHER_PREFIX: &str = "enc:v1:";

/// env 中禁止覆盖的高危变量（大小写不敏感）。它们能改变子进程的动态库 /
/// 模块解析 / 解释器启动文件，等价于任意代码执行。`DYLD_` 前缀另外单独判定。
const BLOCKED_ENV_KEYS: [&str; 12] = [
    "PATH",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "PYTHONPATH",
    "PYTHONHOME",
    "PYTHONSTARTUP",
    "BASH_ENV",
    "ENV",
    "RUBYOPT",
    "PERL5OPT",
];

/// 权限/白名单键内的分隔符：US(0x1F)。旧版用 `server_id:tool` 冒号拼接，
/// `server_id` / `tool` 自身含冒号时两组权限会映射到同一个键互相覆盖（T-056）。
const KEY_PART_SEP: char = '\u{1f}';

/// stderr 环形缓冲上限：失败信息里带最后 50 行 / 8 KiB，够定位启动错误，
/// 又不会被刷屏的服务器把内存吃光。
const STDERR_TAIL_MAX_LINES: usize = 50;
const STDERR_TAIL_MAX_BYTES: usize = 8 * 1024;

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

/// env 值加密：空值与已带前缀的值原样返回（幂等），其余走 DPAPI。
fn encrypt_env_value(value: &str) -> Result<String, String> {
    if value.is_empty() || value.starts_with(ENV_CIPHER_PREFIX) {
        return Ok(value.to_string());
    }
    encryption::encrypt(value).map(|cipher| format!("{ENV_CIPHER_PREFIX}{cipher}"))
}

/// 原地解密 env 值，返回 `true` 表示存在旧版明文（调用方应惰性迁移）。
///
/// 解不开的密文（换 Windows 账户 / 重装系统）按空值处理并落日志：若原样把
/// 密文交给子进程，MCP 服务器只会看到一个「格式怪异的 token」，更难排查。
fn decrypt_env_in_place(env: &mut HashMap<String, String>) -> bool {
    let mut legacy = false;
    for (key, value) in env.iter_mut() {
        if value.is_empty() {
            continue; // 空值不加密，也不算旧数据
        }
        let Some(cipher) = value.strip_prefix(ENV_CIPHER_PREFIX) else {
            legacy = true;
            continue;
        };
        match encryption::decrypt(cipher) {
            Ok(plain) => *value = plain,
            Err(e) => {
                crate::commands::chat::log_chat_error(&format!(
                    "MCP_ENV: 服务器 env「{key}」解密失败，本次按空值处理（需重新填写）: {e}"
                ));
                *value = String::new();
            }
        }
    }
    legacy
}

fn save_server_to(tree: &sled::Tree, s: &McpServer) -> Result<(), String> {
    // 只加密落盘副本；调用方持有的对象继续使用明文（前端编辑 / 启动子进程）。
    let mut stored = s.clone();
    for value in stored.env.values_mut() {
        *value = encrypt_env_value(value)?;
    }
    tree.insert(
        crate::db::key("ms", &s.id),
        serde_json::to_vec(&stored).map_err(|e| format!("Ser: {e}"))?,
    )
    .map_err(|e| format!("Save: {e}"))?;
    Ok(())
}

fn load_servers_from(tree: &sled::Tree) -> Vec<McpServer> {
    let mut list = Vec::new();
    for (_, v) in crate::db::scan_prefix(tree, "ms:") {
        let Ok(mut s) = serde_json::from_slice::<McpServer>(&v) else {
            continue;
        };
        let legacy = decrypt_env_in_place(&mut s.env);
        if legacy {
            // 惰性迁移：旧版明文 env 第一次被读出时就改写为密文。
            if let Err(e) = save_server_to(tree, &s) {
                crate::commands::chat::log_chat_error(&format!(
                    "MCP_ENV: 服务器「{}」env 惰性迁移失败（本次仍按明文使用）: {e}",
                    s.id
                ));
            }
        }
        list.push(s);
    }
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    list
}

pub fn list_servers() -> Result<Vec<McpServer>, String> {
    Ok(load_servers_from(&crate::db::tree("mcp_servers")?))
}

fn save_server(s: &McpServer) -> Result<(), String> {
    save_server_to(&crate::db::tree("mcp_servers")?, s)
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

/// `rpc_call` 的超时参数。生产路径用 [`RpcTimeouts::DEFAULT`]；测试注入毫秒级
/// 超时，快速覆盖「超时 → 清理」分支而不必真等 15s / 2min。
#[derive(Clone, Copy)]
struct RpcTimeouts {
    handshake: std::time::Duration,
    call: std::time::Duration,
    /// 整个 `rpc_call`（握手 + 调用）的总时限。没有它时，服务器只要每秒发一条
    /// notification 就能把每次「单行等待」重新计时，调用永不超时（T-052）。
    total: std::time::Duration,
}

impl RpcTimeouts {
    const DEFAULT: Self = Self {
        handshake: std::time::Duration::from_secs(15),
        call: std::time::Duration::from_mins(2),
        total: std::time::Duration::from_secs(15 + 120),
    };
}

type StdoutLines = tokio::io::Lines<BufReader<ChildStdout>>;

/// MCP 子进程的 RAII 守卫。
///
/// 为什么需要它：`rpc_call` 有握手/调用两段读循环、十余条错误与超时返回路径，
/// 逐条手写 kill 必然漏掉一条（T-007 的实测缺陷）。此外 `tokio::spawn` 出来的
/// stderr drain 任务在 `JoinHandle` 被丢弃后是 **detach 而不是停止**，进程一旦
/// 泄漏，读任务就跟着长期占着 stderr 管道。
///
/// 守卫保证：
///   - 正常路径：`cleanup()` 在返回结果前统一杀进程树 + wait + abort drain；
///   - 提前 return / `?`：同样在 `rpc_call_with_timeouts` 尾部走 `cleanup()`；
///   - 未来被取消 / panic / 其他 drop：`Drop` abort drain，子进程由 spawn 时
///     设置的 `kill_on_drop(true)` 兜底终止。
struct ChildGuard {
    child: Option<Child>,
    stderr_task: Option<tokio::task::JoinHandle<String>>,
    pid: Option<u32>,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        let pid = child.id();
        Self {
            child: Some(child),
            stderr_task: None,
            pid,
        }
    }

    fn take_pipes(&mut self) -> Result<(ChildStdin, ChildStdout, ChildStderr), String> {
        let child = self.child.as_mut().ok_or("MCP 子进程句柄缺失")?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        Ok((stdin, stdout, stderr))
    }

    /// 异步排空 stderr，防止子进程写满管道后阻塞；只保留最后若干行，
    /// 避免恶意服务器用海量 stderr 撑爆内存（T-053）。
    fn attach_stderr_drain(&mut self, stderr: ChildStderr) {
        self.stderr_task = Some(tokio::spawn(async move {
            let mut lines: VecDeque<String> = VecDeque::new();
            let mut bytes = 0usize;
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = reader.next_line().await {
                bytes += l.len() + 1;
                lines.push_back(l);
                while lines.len() > STDERR_TAIL_MAX_LINES
                    || (bytes > STDERR_TAIL_MAX_BYTES && lines.len() > 1)
                {
                    if let Some(front) = lines.pop_front() {
                        bytes = bytes.saturating_sub(front.len() + 1);
                    }
                }
            }
            lines.into_iter().collect::<Vec<_>>().join("\n")
        }));
    }

    /// 统一清理：杀整棵进程树 → wait 回收 → 等待 stderr drain 收尾并取回尾部。
    ///
    /// 返回 `(退出状态, 进入 cleanup 时 drain 是否仍在运行, stderr 尾部)`。
    /// 第二个值留给测试断言「确有 reader 需要收尾」；第三个值用于把服务器的
    /// stderr 附到失败信息里（旧实现收完即丢，只剩「提前退出」一句废话）。
    async fn cleanup(&mut self) -> (Option<std::process::ExitStatus>, bool, String) {
        // 在杀进程之前观测：kill 会关闭 stderr 管道，drain 往往因此自然结束。
        let drain_was_running = self
            .stderr_task
            .as_ref()
            .is_some_and(|task| !task.is_finished());
        if let Some(pid) = self.pid {
            // 子进程句柄一直持有到此刻；Windows 在句柄关闭前不会回收 PID，
            // 所以按 PID 杀不会误伤复用了同一 PID 的进程。
            kill_process_tree(pid).await;
        }
        let status = if let Some(mut child) = self.child.take() {
            // Windows 上通常已被 taskkill 结束；这一刀兜住其他平台与 taskkill 失败。
            let _ = child.kill().await;
            child.wait().await.ok()
        } else {
            None
        };
        let stderr_tail = if let Some(mut task) = self.stderr_task.take() {
            // 进程退出后 stderr 管道会 EOF，正常几毫秒内 drain 就能返回。
            // 给一个短兜底：极端情况下（孙进程仍持有管道）才 abort，保证不挂起。
            match tokio::time::timeout(std::time::Duration::from_secs(2), &mut task).await {
                Ok(Ok(tail)) => tail,
                Ok(Err(_)) => String::new(),
                Err(_) => {
                    task.abort();
                    let _ = task.await;
                    String::new()
                }
            }
        } else {
            String::new()
        };
        (status, drain_was_running, stderr_tail)
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        // JoinHandle 被丢弃只是 detach；不 abort 的话读任务会继续挂在管道上。
        // 子进程此时由 spawn 时的 kill_on_drop(true) 负责终止。
        if let Some(task) = self.stderr_task.take() {
            task.abort();
        }
    }
}

/// `taskkill` 参数：`/T` 连子孙进程一起杀（`npx.cmd` / `cmd /c` 包装的核心
/// 诉求），`/F` 强制终止。抽成函数是为了单测能钉住 `/T` 不被简化掉。
#[cfg(windows)]
fn taskkill_args(pid: u32) -> [String; 4] {
    [
        "/PID".to_string(),
        pid.to_string(),
        "/T".to_string(),
        "/F".to_string(),
    ]
}

/// Windows：`Child::kill` 只结束直接子进程，`npx.cmd` / `cmd /c` 拉起的孙进程
/// 会活下来（T-007）。这里用系统自带的 `taskkill /T` 清整棵树，不新增依赖。
///
/// 为什么不用 Job Object：Cargo.toml 的 windows-sys 只启用了加密/基础 feature，
/// Job Object 需要额外 feature + unsafe FFI；且「spawn 后再
/// `AssignProcessToJobObject`」存在子进程抢先创建孙进程的竞态，而 taskkill
/// 是在清理时刻按当前进程树一次性处理，对本场景更直接。
#[cfg(windows)]
async fn kill_process_tree(pid: u32) {
    let args = taskkill_args(pid);
    let _ = Command::new("taskkill")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}

#[cfg(not(windows))]
#[allow(clippy::unused_async)]
async fn kill_process_tree(_pid: u32) {
    // 非 Windows：直接子进程由 cleanup 里的 child.kill() 结束；整树语义
    // （进程组）不在本项目的目标平台上，保持最小行为。
}

/// JSON-RPC call over the server's stdio; spawns, handshakes, calls, kills.
async fn rpc_call(
    server: &McpServer,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    rpc_call_with_timeouts(server, method, params, RpcTimeouts::DEFAULT).await
}

/// 失败信息附上 stderr 尾部；没有输出时保持原文案。
fn with_stderr_tail(err: String, tail: &str) -> String {
    let tail = tail.trim_end();
    if tail.is_empty() {
        return err;
    }
    format!("{err}\n--- MCP stderr（最后 {STDERR_TAIL_MAX_LINES} 行） ---\n{tail}")
}

/// `rpc_call` 的可注入超时版本：测试用短超时覆盖「超时后清理」路径。
async fn rpc_call_with_timeouts(
    server: &McpServer,
    method: &str,
    params: serde_json::Value,
    timeouts: RpcTimeouts,
) -> Result<serde_json::Value, String> {
    // 保存与恢复是两条入口：从备份/旧数据恢复进来的记录没经过 mcp_save_server，
    // 必须在这里再校验一次，否则带 PATH/NODE_OPTIONS 的旧记录照样会被执行（T-051）。
    validate_server(server)?;
    let mut cmd = Command::new(&server.command);
    cmd.args(&server.args);
    for (k, v) in &server.env {
        cmd.env(k, v);
    }
    // 默认 false：Child 被 drop 时子进程会继续活着。任何提前 return 都会
    // 留下一个 MCP 进程，因此必须显式打开。
    cmd.kill_on_drop(true);
    let child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 MCP 服务器失败: {e}"))?;

    let mut guard = ChildGuard::new(child);
    let (mut stdin, stdout, stderr) = guard.take_pipes()?;
    let mut reader = BufReader::new(stdout).lines();
    guard.attach_stderr_drain(stderr);

    // 握手/调用内部的所有错误都从这里返回，清理在下方统一执行——
    // 不在每个 return 前手写 kill，避免再次漏掉某条路径。
    //
    // 总时限包住整个交换：单行等待的超时会被持续到达的 notification/空行
    // 不断重置，只有总时限才挡得住「服务器刷通知永不回包」（T-052）。
    let outcome = match tokio::time::timeout(
        timeouts.total,
        rpc_exchange(&mut stdin, &mut reader, method, params, timeouts),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!(
            "MCP 调用总超时（{} 秒内未完成 {method}；服务器可能持续发送通知而未回包）",
            timeouts.total.as_secs()
        )),
    };
    let (_, _, stderr_tail) = guard.cleanup().await;

    let result = outcome.map_err(|e| with_stderr_tail(e, &stderr_tail))?;
    if let Some(e) = result["error"].as_object() {
        return Err(with_stderr_tail(
            format!(
                "MCP {} 错误: {}",
                method,
                e["message"].as_str().unwrap_or("?")
            ),
            &stderr_tail,
        ));
    }
    Ok(result["result"].clone())
}

/// 握手 + 实际方法调用。返回 id=2 的完整响应（协议错误也包含在内），
/// 清理时机由调用方统一负责。
async fn rpc_exchange(
    stdin: &mut ChildStdin,
    reader: &mut StdoutLines,
    method: &str,
    params: serde_json::Value,
    timeouts: RpcTimeouts,
) -> Result<serde_json::Value, String> {
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
        let line = match tokio::time::timeout(timeouts.handshake, reader.next_line()).await {
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

    loop {
        let line = match tokio::time::timeout(timeouts.call, reader.next_line()).await {
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
                return Ok(v);
            }
        }
    }
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

/// `scope` 由前端声明当前所处模式：`"chat"` = 对话（受白名单约束），
/// `"work"` = 工作（不受约束）。**缺省按对话处理**（fail-closed）：绕过前端
/// 直接 `invoke("mcp_call_tool", ...)` 的调用同样会被「对话可用」白名单拦住（T-130）。
#[tauri::command]
pub async fn mcp_call_tool(
    app: tauri::AppHandle,
    server_id: String,
    tool_name: String,
    arguments: serde_json::Value,
    scope: Option<String>,
) -> Result<McpToolResult, String> {
    let server = list_servers()?
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or("服务器不存在")?;
    if !server.enabled {
        return Err("服务器未启用".to_string());
    }
    if scope_requires_lite(scope.as_deref()) {
        let lite_tree = crate::db::tree(LITE_TOOLS_TREE)?;
        if !lite_allowed_in(&lite_tree, &server_id, &tool_name) {
            return Err(format!(
                "工具 {tool_name} 不在「对话可用」白名单中：请先在设置 → MCP 勾选该工具，或切换到工作模式"
            ));
        }
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
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
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

/// 权限键：`mp:` + `server_id` + US + `tool`。`server_id` / `tool` 里的冒号不再
/// 参与拼接，`("a:b","c")` 与 `("a","b:c")` 不会映射到同一个键（T-056）。
fn permission_key(server_id: &str, tool: &str) -> Vec<u8> {
    crate::db::key("mp", &format!("{server_id}{KEY_PART_SEP}{tool}"))
}

/// 旧版冒号拼接键，仅用于迁移与清理。
fn legacy_permission_key(server_id: &str, tool: &str) -> Vec<u8> {
    crate::db::key("mp", &format!("{server_id}:{tool}"))
}

fn grant_key(server_id: &str, tool: &str) -> Vec<u8> {
    crate::db::key("mg", &format!("{server_id}{KEY_PART_SEP}{tool}"))
}

fn legacy_grant_key(server_id: &str, tool: &str) -> Vec<u8> {
    crate::db::key("mg", &format!("{server_id}:{tool}"))
}

/// 读取权限并把旧版键迁移到 US 分隔格式；迁移失败不阻塞读取。
fn load_permissions_from(t: &sled::Tree) -> Vec<McpPermission> {
    let mut list = Vec::new();
    for (raw_key, v) in crate::db::scan_prefix(t, "mp:") {
        let Ok(p) = serde_json::from_slice::<McpPermission>(&v) else {
            continue;
        };
        let expected = permission_key(&p.server_id, &p.tool);
        if raw_key != expected {
            let _ = t.insert(expected, v);
            let _ = t.remove(&raw_key);
        }
        list.push(p);
    }
    list
}

pub fn list_permissions() -> Result<Vec<McpPermission>, String> {
    Ok(load_permissions_from(&crate::db::tree("mcp_permissions")?))
}

fn save_permission_to(t: &sled::Tree, p: &McpPermission) -> Result<(), String> {
    validate_key_parts(&p.server_id, &p.tool)?;
    let value = serde_json::to_vec(p).map_err(|e| format!("Ser: {e}"))?;
    let key = permission_key(&p.server_id, &p.tool);
    t.insert(key.clone(), value)
        .map_err(|e| format!("Save: {e}"))?;
    let legacy = legacy_permission_key(&p.server_id, &p.tool);
    if legacy != key {
        // 清掉迁移前的旧键，避免删除/覆盖后旧记录「复活」。
        let _ = t.remove(legacy);
    }
    Ok(())
}

fn save_permission(p: &McpPermission) -> Result<(), String> {
    save_permission_to(&crate::db::tree("mcp_permissions")?, p)
}

fn delete_permission_from(t: &sled::Tree, server_id: &str, tool: &str) -> Result<(), String> {
    t.remove(permission_key(server_id, tool))
        .map_err(|e| format!("Del: {e}"))?;
    let _ = t.remove(legacy_permission_key(server_id, tool));
    Ok(())
}

fn delete_permission(server_id: &str, tool: &str) -> Result<(), String> {
    delete_permission_from(&crate::db::tree("mcp_permissions")?, server_id, tool)
}

/// 读取临时授权并迁移旧版键；过期授权跳过。
fn load_grants_from(t: &sled::Tree) -> Vec<McpGrant> {
    let mut list = Vec::new();
    let now = chrono_now_secs();
    for (raw_key, v) in crate::db::scan_prefix(t, "mg:") {
        let Ok(g) = serde_json::from_slice::<McpGrant>(&v) else {
            continue;
        };
        let expected = grant_key(&g.server_id, &g.tool);
        if raw_key != expected {
            let _ = t.insert(expected, v);
            let _ = t.remove(&raw_key);
        }
        if g.expires_at > 0 && g.expires_at < now {
            continue; // 过期授权跳过
        }
        list.push(g);
    }
    list
}

pub fn list_grants() -> Result<Vec<McpGrant>, String> {
    Ok(load_grants_from(&crate::db::tree("mcp_grants")?))
}

fn save_grant_to(t: &sled::Tree, g: &McpGrant) -> Result<(), String> {
    validate_key_parts(&g.server_id, &g.tool)?;
    let value = serde_json::to_vec(g).map_err(|e| format!("Ser: {e}"))?;
    let key = grant_key(&g.server_id, &g.tool);
    t.insert(key.clone(), value)
        .map_err(|e| format!("Save: {e}"))?;
    let legacy = legacy_grant_key(&g.server_id, &g.tool);
    if legacy != key {
        let _ = t.remove(legacy);
    }
    Ok(())
}

fn save_grant(g: &McpGrant) -> Result<(), String> {
    save_grant_to(&crate::db::tree("mcp_grants")?, g)
}

fn delete_grant(server_id: &str, tool: &str) -> Result<(), String> {
    let t = crate::db::tree("mcp_grants")?;
    t.remove(grant_key(server_id, tool))
        .map_err(|e| format!("Del: {e}"))?;
    let _ = t.remove(legacy_grant_key(server_id, tool));
    Ok(())
}

/// 临时授权上限：365 天。既防止「填个天文数字 = 永久授权」，也让 *60 不溢出。
const MAX_GRANT_MINUTES: i64 = 525_600;

/// 权限 action 白名单。旧实现不校验，拼错（如 `alow`）会静默退化成 Ask，
/// 用户以为设好了策略，实际每次都在弹窗（T-055）。
fn validate_permission_action(action: &str) -> Result<(), String> {
    match action {
        "allow" | "ask" | "deny" | "clear" => Ok(()),
        other => Err(format!(
            "权限 action 只能是 allow / ask / deny / clear（收到 {other}）"
        )),
    }
}

/// `server_id` / `tool` 不得包含键分隔符，否则权限键无法唯一反解。
fn validate_key_parts(server_id: &str, tool: &str) -> Result<(), String> {
    if server_id.contains(KEY_PART_SEP) || tool.contains(KEY_PART_SEP) {
        return Err("server_id / tool 不能包含分隔符 \\u{1f}".to_string());
    }
    Ok(())
}

/// 计算授权过期时间（unix 秒；0 = 长期）。负数曾被当成「长期」且 `*60` 可溢出
/// 成负的 `expires_at`，等于永久授权（T-055），这里统一拒绝。
fn grant_expiry_secs(now: i64, grant_minutes: i64) -> Result<i64, String> {
    if !(0..=MAX_GRANT_MINUTES).contains(&grant_minutes) {
        return Err(format!(
            "grant_minutes 必须在 0..={MAX_GRANT_MINUTES} 之间（收到 {grant_minutes}）"
        ));
    }
    if grant_minutes == 0 {
        return Ok(0);
    }
    grant_minutes
        .checked_mul(60)
        .and_then(|secs| now.checked_add(secs))
        .ok_or_else(|| "授权过期时间计算溢出".to_string())
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

/// `prefix` 后紧跟至少 8 个 token 字符（如 `sk-live...`、`ghp_...`）。
fn contains_prefixed_token(lower: &str, prefix: &str) -> bool {
    lower.match_indices(prefix).any(|(i, _)| {
        lower[i + prefix.len()..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            .count()
            >= 8
    })
}

/// 连续 40+ 个 base64/base64url 字符，视为裸密钥（长哈希、JWT 片段等）。
fn contains_long_base64_run(value: &str) -> bool {
    let mut run = 0usize;
    for c in value.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-' | '_') {
            run += 1;
            if run >= 40 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

/// URL 内嵌凭据（`scheme://user:password@host`）。
fn contains_url_credentials(value: &str) -> bool {
    let Some(scheme_end) = value.find("://") else {
        return false;
    };
    let authority = value[scheme_end + 3..]
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    authority
        .rsplit_once('@')
        .is_some_and(|(userinfo, _)| userinfo.contains(':'))
}

/// 值本身的敏感特征。审计脱敏不能只看键名：位置参数、数组元素、`input` 里的
/// `Bearer sk-...` 都可能把密钥原样写进审计 sled，并随备份外流（T-054）。
fn looks_like_secret(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("bearer ")
        || contains_prefixed_token(&lower, "sk-")
        || contains_prefixed_token(&lower, "ghp_")
        || contains_long_base64_run(value)
        || contains_url_credentials(value)
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
        serde_json::Value::String(s) => {
            if looks_like_secret(s) {
                serde_json::Value::String("***".to_string())
            } else {
                value.clone()
            }
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
    validate_permission_action(&action)?;
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
    let expires = grant_expiry_secs(chrono_now_secs(), grant_minutes)?;
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

// ── 对话模式 MCP 工具白名单（独立于 allow/ask/deny 权限）──────
//
// 「对话」子模式只允许调用用户手动勾选的工具；「工作」子模式不受此表影响。
// 白名单按 `(server_id, tool)` 存储，与 `mcp_permissions` 完全独立，默认空。

/// 白名单持久化 tree 名。
const LITE_TOOLS_TREE: &str = "mcp_lite_tools";

/// 键内分隔符：用 US(0x1F) 而非 `:`，避免与 `server_id` / `tool` 中的冒号冲突。
const LITE_KEY_SEP: char = KEY_PART_SEP;

/// 白名单条目的值语义：`"1"` = 允许；`"0"` = 在 `*` 通配下的显式排除。
/// 只有允许项才是真正的「白名单」，排除项只用于让逐工具取消生效（T-101）。
const LITE_ALLOW: &[u8] = b"1";
const LITE_DENY: &[u8] = b"0";

fn lite_tool_key(server_id: &str, tool: &str) -> Vec<u8> {
    format!("{server_id}{LITE_KEY_SEP}{tool}").into_bytes()
}

fn lite_value(tree: &sled::Tree, server_id: &str, tool: &str) -> Option<Vec<u8>> {
    tree.get(lite_tool_key(server_id, tool))
        .ok()
        .flatten()
        .map(|v| v.to_vec())
}

fn lite_wildcard_enabled(tree: &sled::Tree, server_id: &str) -> bool {
    lite_value(tree, server_id, "*").as_deref() == Some(LITE_ALLOW)
}

/// 取消整服务器授权时，清掉该服务器的排除墓碑，避免下次勾选 `*` 时旧排除复活。
fn clear_lite_excludes(tree: &sled::Tree, server_id: &str) {
    let prefix = format!("{server_id}{LITE_KEY_SEP}");
    for (k, v) in tree
        .scan_prefix(prefix.as_bytes())
        .filter_map(std::result::Result::ok)
    {
        if v.as_ref() == LITE_DENY {
            let _ = tree.remove(k);
        }
    }
}

/// 空参数（含纯空白）一律拒绝；`server_id` 不得包含键分隔符，否则无法反解。
fn validate_lite_tool(server_id: &str, tool: &str) -> Result<(), String> {
    if server_id.trim().is_empty() {
        return Err("MCP 对话白名单: server_id 不能为空".to_string());
    }
    if tool.trim().is_empty() {
        return Err("MCP 对话白名单: tool 不能为空".to_string());
    }
    if server_id.contains(LITE_KEY_SEP) {
        return Err("MCP 对话白名单: server_id 不能包含分隔符 \\u{1f}".to_string());
    }
    Ok(())
}

/// 写入（allowed=true）或删除（allowed=false）一条白名单项。
/// 注入 tree 便于单测使用临时库，不污染真实用户库。
///
/// `allowed=false` 且该服务器已勾选 `*` 时，不能只是删除精确项——通配仍然会
/// 放行，UI 显示未勾选但实际可用（T-101）。此时写入 `"0"` 显式排除墓碑。
fn set_lite_tool(
    tree: &sled::Tree,
    server_id: &str,
    tool: &str,
    allowed: bool,
) -> Result<(), String> {
    validate_lite_tool(server_id, tool)?;
    let key = lite_tool_key(server_id, tool);
    if allowed {
        // 重新勾选会覆盖此前的排除墓碑。
        tree.insert(key, LITE_ALLOW)
            .map_err(|e| format!("保存对话白名单失败: {e}"))?;
        return Ok(());
    }
    if tool != "*" && lite_wildcard_enabled(tree, server_id) {
        tree.insert(key, LITE_DENY)
            .map_err(|e| format!("保存对话白名单失败: {e}"))?;
        return Ok(());
    }
    tree.remove(key)
        .map_err(|e| format!("删除对话白名单失败: {e}"))?;
    if tool == "*" {
        clear_lite_excludes(tree, server_id);
    }
    Ok(())
}

/// 按值筛选白名单条目（`LITE_ALLOW` / `LITE_DENY`），按 `(server_id, tool)` 排序。
fn collect_lite_entries(tree: &sled::Tree, wanted: &[u8]) -> Vec<(String, String)> {
    let mut list = Vec::new();
    for (k, v) in tree.iter().filter_map(std::result::Result::ok) {
        if v.as_ref() != wanted {
            continue;
        }
        let raw = String::from_utf8_lossy(&k);
        let Some((server_id, tool)) = raw.split_once(LITE_KEY_SEP) else {
            continue; // 非法键（非本模块写入）跳过，避免整表读取失败
        };
        list.push((server_id.to_string(), tool.to_string()));
    }
    list.sort();
    list
}

/// 列出全部「允许」项（排除墓碑不返回给前端：它们不是白名单条目）。
fn list_lite_tools_from(tree: &sled::Tree) -> Vec<(String, String)> {
    collect_lite_entries(tree, LITE_ALLOW)
}

/// 列出全部显式排除项。
fn list_lite_excludes_from(tree: &sled::Tree) -> Vec<(String, String)> {
    collect_lite_entries(tree, LITE_DENY)
}

/// 纯函数判定：「对话」模式是否允许调用该工具。
/// 精确 `(server_id, tool)` 命中，或该服务器配置了 `*` 通配；
/// **显式排除优先于两者**（通配下取消某个工具后必须立即失效）。
#[must_use]
pub fn is_lite_allowed(
    allows: &[(String, String)],
    excludes: &[(String, String)],
    server_id: &str,
    tool: &str,
) -> bool {
    let hit = |list: &[(String, String)]| {
        list.iter()
            .any(|(s, t)| s == server_id && (t == tool || t == "*"))
    };
    if hit(excludes) {
        return false;
    }
    hit(allows)
}

/// 从 sled 读取规则并判定；`mcp_call_tool` 的 Rust 侧门禁走这里（T-130）。
fn lite_allowed_in(tree: &sled::Tree, server_id: &str, tool: &str) -> bool {
    is_lite_allowed(
        &list_lite_tools_from(tree),
        &list_lite_excludes_from(tree),
        server_id,
        tool,
    )
}

/// `scope` 缺省 / `"chat"` / 任何未知值 → 需要白名单（fail-closed）；
/// 只有显式 `"work"` 才放行整表。
fn scope_requires_lite(scope: Option<&str>) -> bool {
    !matches!(scope, Some("work"))
}

/// 勾选 / 取消「对话」模式下可用的 MCP 工具（`tool="*"` 表示整台服务器）。
#[tauri::command]
pub fn mcp_set_lite_tool(server_id: String, tool: String, allowed: bool) -> Result<(), String> {
    let tree = crate::db::tree(LITE_TOOLS_TREE)?;
    set_lite_tool(&tree, &server_id, &tool, allowed)
}

/// 列出「对话」模式 MCP 工具白名单（按 server/tool 排序）。
#[tauri::command]
pub fn mcp_list_lite_tools() -> Result<Vec<(String, String)>, String> {
    let tree = crate::db::tree(LITE_TOOLS_TREE)?;
    Ok(list_lite_tools_from(&tree))
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
            "NODE_PATH",
            "node_path",
            "LD_PRELOAD",
            "ld_preload",
            "LD_LIBRARY_PATH",
            "PYTHONPATH",
            "pythonpath",
            "PYTHONHOME",
            "PythonStartup",
            "BASH_ENV",
            "bash_env",
            "ENV",
            "RUBYOPT",
            "PERL5OPT",
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

    // ── 临时 sled 库 ───────────────────────────────────

    /// 临时 sled 库：tree 与 db 都要在删目录前显式释放，
    /// 否则 Windows 上句柄未关，`remove_dir_all` 会静默失败留下垃圾。
    struct TempSledTree {
        dir: std::path::PathBuf,
        db: Option<sled::Db>,
        tree: Option<sled::Tree>,
    }

    impl TempSledTree {
        fn new(tag: &str, tree_name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("mychat-mcp-{tag}-{}", uuid::Uuid::new_v4()));
            let _ = std::fs::remove_dir_all(&dir);
            let db = sled::open(&dir).expect("打开临时 sled");
            let tree = db.open_tree(tree_name).expect("打开临时 tree");
            Self {
                dir,
                db: Some(db),
                tree: Some(tree),
            }
        }

        fn tree(&self) -> &sled::Tree {
            self.tree.as_ref().expect("tree 存活")
        }
    }

    impl Drop for TempSledTree {
        fn drop(&mut self) {
            self.tree.take();
            self.db.take();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn pair(server: &str, tool: &str) -> (String, String) {
        (server.to_string(), tool.to_string())
    }

    // ── T-042 env 加密落盘 ──────────────────────────────

    #[test]
    fn env_values_are_encrypted_at_rest_and_roundtrip() {
        let t = TempSledTree::new("env-roundtrip", "mcp_servers");
        let s = mcp_server("node", &[("GITHUB_TOKEN", "ghp_supersecret123")]);
        save_server_to(t.tree(), &s).expect("保存服务器");

        let raw = t
            .tree()
            .get(crate::db::key("ms", "s1"))
            .expect("读 key")
            .expect("记录存在");
        let text = String::from_utf8_lossy(&raw);
        assert!(
            !text.contains("ghp_supersecret123"),
            "env 明文不得落盘: {text}"
        );
        assert!(text.contains(ENV_CIPHER_PREFIX), "应写入密文前缀: {text}");

        let loaded = load_servers_from(t.tree());
        assert_eq!(loaded.len(), 1);
        assert_eq!(
            loaded[0].env.get("GITHUB_TOKEN").map(String::as_str),
            Some("ghp_supersecret123"),
            "启动子进程时必须拿到解密后的 env"
        );
    }

    #[test]
    fn legacy_plaintext_env_is_migrated_on_read() {
        let t = TempSledTree::new("env-migrate", "mcp_servers");
        let legacy = mcp_server("node", &[("GITHUB_TOKEN", "ghp_legacy_plain")]);
        let raw = serde_json::to_vec(&legacy).expect("序列化旧记录");
        t.tree()
            .insert(crate::db::key("ms", "s1"), raw)
            .expect("写入旧记录");

        let loaded = load_servers_from(t.tree());
        assert_eq!(loaded[0].env["GITHUB_TOKEN"], "ghp_legacy_plain");

        let stored = t
            .tree()
            .get(crate::db::key("ms", "s1"))
            .expect("读 key")
            .expect("记录存在");
        let text = String::from_utf8_lossy(&stored);
        assert!(
            !text.contains("ghp_legacy_plain"),
            "惰性迁移后不得残留明文: {text}"
        );
        assert!(text.contains(ENV_CIPHER_PREFIX));

        // 迁移后可反复读取、反复解密。
        let again = load_servers_from(t.tree());
        assert_eq!(again[0].env["GITHUB_TOKEN"], "ghp_legacy_plain");
    }

    #[test]
    fn empty_env_values_stay_empty_without_migration_churn() {
        let t = TempSledTree::new("env-empty", "mcp_servers");
        let s = mcp_server("node", &[("OPTIONAL", "")]);
        save_server_to(t.tree(), &s).expect("保存");
        let loaded = load_servers_from(t.tree());
        assert_eq!(loaded[0].env["OPTIONAL"], "");
    }

    // ── T-055 权限 / 授权参数校验 ─────────────────────

    #[test]
    fn permission_action_whitelist() {
        for ok in ["allow", "ask", "deny", "clear"] {
            assert!(
                validate_permission_action(ok).is_ok(),
                "{ok} 应为合法 action"
            );
        }
        let err = validate_permission_action("alow").expect_err("拼错的 action 必须报错");
        assert!(err.contains("alow"), "错误应点名非法值：{err}");
    }

    #[test]
    fn grant_minutes_range_and_overflow_are_rejected() {
        assert_eq!(grant_expiry_secs(1_000, 0).expect("0 = 长期"), 0);
        assert_eq!(
            grant_expiry_secs(1_000, 60).expect("60 分钟"),
            1_000 + 3_600
        );
        assert!(grant_expiry_secs(1_000, -1).is_err(), "负数必须拒绝");
        assert!(
            grant_expiry_secs(1_000, MAX_GRANT_MINUTES + 1).is_err(),
            "超过上限必须拒绝"
        );
        assert!(
            grant_expiry_secs(i64::MAX - 1, MAX_GRANT_MINUTES).is_err(),
            "时间加法溢出必须返回 Err，而不是负的过期时间"
        );
    }

    // ── T-056 权限键编码 ───────────────────────────────

    #[test]
    fn permission_keys_with_colons_do_not_collide() {
        let t = TempSledTree::new("perm-colon", "mcp_permissions");
        let a = perm("a:b", "c", "allow");
        let b = perm("a", "b:c", "deny");
        save_permission_to(t.tree(), &a).expect("保存第一组");
        save_permission_to(t.tree(), &b).expect("保存第二组");

        let list = load_permissions_from(t.tree());
        assert_eq!(list.len(), 2, "两组权限不得互相覆盖: {list:?}");
        assert!(list.iter().any(|p| p == &a));
        assert!(list.iter().any(|p| p == &b));
    }

    #[test]
    fn legacy_permission_key_is_migrated() {
        let t = TempSledTree::new("perm-migrate", "mcp_permissions");
        let p = perm("s1", "t1", "allow");
        t.tree()
            .insert(
                legacy_permission_key("s1", "t1"),
                serde_json::to_vec(&p).expect("序列化"),
            )
            .expect("写入旧键");

        let list = load_permissions_from(t.tree());
        assert_eq!(list.len(), 1);
        assert!(t
            .tree()
            .get(legacy_permission_key("s1", "t1"))
            .expect("读旧键")
            .is_none());
        assert!(t
            .tree()
            .get(permission_key("s1", "t1"))
            .expect("读新键")
            .is_some());
    }

    #[test]
    fn grant_keys_with_colons_do_not_collide() {
        let t = TempSledTree::new("grant-colon", "mcp_grants");
        save_grant_to(
            t.tree(),
            &McpGrant {
                server_id: "a:b".into(),
                tool: "c".into(),
                expires_at: 0,
            },
        )
        .expect("第一组");
        save_grant_to(
            t.tree(),
            &McpGrant {
                server_id: "a".into(),
                tool: "b:c".into(),
                expires_at: 0,
            },
        )
        .expect("第二组");
        assert_eq!(load_grants_from(t.tree()).len(), 2);
    }

    // ── T-054 按值脱敏 ─────────────────────────────────

    #[test]
    fn args_preview_redacts_secret_values_without_sensitive_keys() {
        let args = serde_json::json!({
            "input": "Bearer sk-live-abcdef1234567890",
            "positional": ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
            "url": "https://alice:hunter2@example.com/x",
            "blob": "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2",
            "safe": "hello world",
        });
        let preview = redact_args_preview(&args, 2000);
        assert!(
            !preview.contains("sk-live"),
            "Bearer/sk- 值未脱敏：{preview}"
        );
        assert!(!preview.contains("ghp_"), "裸 token 未脱敏：{preview}");
        assert!(!preview.contains("hunter2"), "URL 凭据未脱敏：{preview}");
        assert!(
            !preview.contains("QUJDREVGR0hJ"),
            "长 base64 未脱敏：{preview}"
        );
        assert!(
            preview.contains("hello world"),
            "普通值不该被误伤：{preview}"
        );
    }

    #[test]
    fn secret_value_detector_matrix() {
        assert!(looks_like_secret("Bearer abc"));
        assert!(looks_like_secret("token=sk-12345678"));
        assert!(looks_like_secret("ghp_12345678"));
        assert!(looks_like_secret("https://user:pass@example.com/path"));
        assert!(looks_like_secret(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
        assert!(!looks_like_secret("hello world"));
        assert!(!looks_like_secret("/tmp/safe/path"));
        assert!(!looks_like_secret("http://localhost:8080/api"));
        assert!(!looks_like_secret("sk-short"));
    }

    // ── 对话模式 MCP 工具白名单 ────────────────────────

    #[test]
    fn lite_tool_set_list_remove_roundtrip() {
        let t = TempSledTree::new("lite-roundtrip", LITE_TOOLS_TREE);
        assert!(
            list_lite_tools_from(t.tree()).is_empty(),
            "白名单默认必须为空"
        );

        set_lite_tool(t.tree(), "s1", "t1", true).expect("设置成功");
        assert_eq!(
            t.tree()
                .get(lite_tool_key("s1", "t1"))
                .expect("读 key")
                .as_deref(),
            Some(&b"1"[..]),
            "值必须是 \"1\""
        );
        assert_eq!(
            list_lite_tools_from(t.tree()),
            vec![pair("s1", "t1")],
            "列出设置项"
        );

        // 重复设置幂等：同一 key 不会产生重复项。
        set_lite_tool(t.tree(), "s1", "t1", true).expect("重复设置");
        assert_eq!(list_lite_tools_from(t.tree()), vec![pair("s1", "t1")]);

        set_lite_tool(t.tree(), "s1", "t1", false).expect("取消成功");
        assert!(
            list_lite_tools_from(t.tree()).is_empty(),
            "取消后列表应为空"
        );
        assert!(
            t.tree()
                .get(lite_tool_key("s1", "t1"))
                .expect("读 key")
                .is_none(),
            "取消后 key 必须被删除"
        );
    }

    #[test]
    fn lite_tool_same_server_tools_do_not_cross_contaminate() {
        let t = TempSledTree::new("lite-isolation", LITE_TOOLS_TREE);
        set_lite_tool(t.tree(), "s1", "t1", true).expect("s1/t1");
        set_lite_tool(t.tree(), "s1", "t2", true).expect("s1/t2");
        set_lite_tool(t.tree(), "s2", "t1", true).expect("s2/t1");

        assert_eq!(
            list_lite_tools_from(t.tree()),
            vec![pair("s1", "t1"), pair("s1", "t2"), pair("s2", "t1")],
            "必须按 server/tool 排序"
        );

        set_lite_tool(t.tree(), "s1", "t1", false).expect("取消 s1/t1");
        assert_eq!(
            list_lite_tools_from(t.tree()),
            vec![pair("s1", "t2"), pair("s2", "t1")],
            "取消一个工具不得影响同服务器其他工具"
        );
    }

    #[test]
    fn lite_tool_wildcard_covers_whole_server() {
        let t = TempSledTree::new("lite-wildcard", LITE_TOOLS_TREE);
        set_lite_tool(t.tree(), "s1", "*", true).expect("设置整服务器");
        let list = list_lite_tools_from(t.tree());
        assert_eq!(list, vec![pair("s1", "*")]);
        assert!(is_lite_allowed(&list, &[], "s1", "anything"));
        assert!(!is_lite_allowed(&list, &[], "s2", "anything"));
    }

    #[test]
    fn lite_tool_rejects_empty_parameters() {
        let t = TempSledTree::new("lite-empty", LITE_TOOLS_TREE);
        let err = set_lite_tool(t.tree(), "", "t1", true).expect_err("空 server_id 必须拒绝");
        assert!(err.contains("server_id"), "错误应点名 server_id：{err}");
        let err = set_lite_tool(t.tree(), "s1", "", true).expect_err("空 tool 必须拒绝");
        assert!(err.contains("tool"), "错误应点名 tool：{err}");
        let err = set_lite_tool(t.tree(), "   ", "t1", true).expect_err("空白 server_id 必须拒绝");
        assert!(err.contains("server_id"), "{err}");
        let err = set_lite_tool(t.tree(), "s1", " \t ", true).expect_err("空白 tool 必须拒绝");
        assert!(err.contains("tool"), "{err}");
        assert!(
            list_lite_tools_from(t.tree()).is_empty(),
            "被拒绝的参数不得写入任何项"
        );
    }

    #[test]
    fn is_lite_allowed_matrix() {
        let allows = vec![pair("s1", "read"), pair("s2", "*")];
        // 精确匹配
        assert!(is_lite_allowed(&allows, &[], "s1", "read"));
        // 服务器级通配
        assert!(is_lite_allowed(&allows, &[], "s2", "write"));
        assert!(is_lite_allowed(&allows, &[], "s2", "read"));
        // 同服务器、不同工具
        assert!(!is_lite_allowed(&allows, &[], "s1", "write"));
        // 同工具、不同服务器
        assert!(!is_lite_allowed(&allows, &[], "s3", "read"));
        // 空列表
        assert!(!is_lite_allowed(&[], &[], "s1", "read"));
        // 通配只属于 s2，不泄漏到 s1
        assert!(!is_lite_allowed(&allows, &[], "s1", "*"));
        // 显式排除优先于 wildcard（T-101）
        let excludes = vec![pair("s2", "write")];
        assert!(!is_lite_allowed(&allows, &excludes, "s2", "write"));
        assert!(is_lite_allowed(&allows, &excludes, "s2", "read"));
    }

    #[test]
    fn lite_uncheck_under_wildcard_takes_effect() {
        let t = TempSledTree::new("lite-deny", LITE_TOOLS_TREE);
        set_lite_tool(t.tree(), "s1", "*", true).expect("整服务器");
        assert!(lite_allowed_in(t.tree(), "s1", "t1"));

        set_lite_tool(t.tree(), "s1", "t1", false).expect("取消 t1");
        assert!(
            !lite_allowed_in(t.tree(), "s1", "t1"),
            "通配下取消某工具后必须立即不可用"
        );
        assert!(
            lite_allowed_in(t.tree(), "s1", "t2"),
            "取消一个工具不得影响其他工具"
        );
        assert_eq!(
            list_lite_tools_from(t.tree()),
            vec![pair("s1", "*")],
            "排除墓碑不得混进白名单列表"
        );

        set_lite_tool(t.tree(), "s1", "t1", true).expect("重新勾选");
        assert!(lite_allowed_in(t.tree(), "s1", "t1"));
        assert!(list_lite_excludes_from(t.tree()).is_empty());
    }

    #[test]
    fn lite_removing_wildcard_clears_old_excludes() {
        let t = TempSledTree::new("lite-clear", LITE_TOOLS_TREE);
        set_lite_tool(t.tree(), "s1", "*", true).expect("整服务器");
        set_lite_tool(t.tree(), "s1", "t1", false).expect("取消 t1");
        set_lite_tool(t.tree(), "s1", "*", false).expect("取消整服务器");

        assert!(!lite_allowed_in(t.tree(), "s1", "t2"));
        assert!(
            list_lite_excludes_from(t.tree()).is_empty(),
            "取消 * 时必须清理排除墓碑"
        );

        set_lite_tool(t.tree(), "s1", "*", true).expect("重新勾选整服务器");
        assert!(
            lite_allowed_in(t.tree(), "s1", "t1"),
            "旧墓碑不得在重新勾选 * 后复活"
        );
    }

    #[test]
    fn lite_scope_is_fail_closed_by_default() {
        assert!(scope_requires_lite(None), "缺省必须按对话模式校验");
        assert!(scope_requires_lite(Some("chat")));
        assert!(scope_requires_lite(Some("WORK")), "未知值按严格处理");
        assert!(scope_requires_lite(Some("")));
        assert!(!scope_requires_lite(Some("work")));
    }

    // ── T-007 MCP 子进程清理 ────────────────────────────

    /// 合成测试：Windows 必须用 `taskkill /T`（整棵进程树），否则 npx.cmd /
    /// cmd 包装出来的孙进程会成为孤儿。单独钉参数，防止以后被简化掉。
    #[cfg(windows)]
    #[test]
    fn taskkill_args_target_whole_tree_and_force() {
        assert_eq!(
            taskkill_args(4321),
            [
                "/PID".to_string(),
                "4321".to_string(),
                "/T".to_string(),
                "/F".to_string()
            ]
        );
    }

    #[cfg(windows)]
    fn pid_is_alive(pid: u32) -> bool {
        let filter = format!("PID eq {pid}");
        std::process::Command::new("tasklist")
            .args(["/FI", filter.as_str(), "/NH", "/FO", "CSV"])
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
    }

    #[cfg(windows)]
    async fn wait_until_dead(pid: u32) -> bool {
        for _ in 0..40 {
            if !pid_is_alive(pid) {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        false
    }

    /// 轮询辅助进程写出的孙进程 PID（辅助进程启动 + 落盘需要一点时间）。
    #[cfg(windows)]
    async fn read_helper_pid(path: &std::path::Path) -> Option<u32> {
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(path) {
                if let Ok(pid) = text.trim().parse::<u32>() {
                    return Some(pid);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        None
    }

    /// 真机测试辅助进程：被当成「MCP 服务器」启动，先拉起一个长命 ping 孙进程
    /// 并把它的 PID 写进文件，然后装死（不回应 JSON-RPC）。父测试超时清理后，
    /// 这个孙进程必须一起消失——它正是 npx/cmd 包装孙进程的最小复现。
    ///
    /// 辅助进程按 `MYCHAT_MCP_TEST_HELPER_MODE` 扮演不同故障形态：
    /// - `init_then_hang`：回 initialize 后装死（调用阶段超时）；
    /// - `init_then_flood`：回 initialize 后持续刷 notification（总时限）；
    /// - `stderr_then_exit`：往 stderr 写一行错误后直接退出（stderr 尾部）；
    /// - `echo_tools`：正常完成握手并对 tools/list 回包（正例）；
    /// - 缺省：拉起长命 ping 孙进程后装死（握手超时 + 进程树清理）。
    ///
    /// ping 孙进程故意不 wait：它的存在就是为了验证 taskkill `/T` 能否清掉；
    /// 辅助进程自己也会被整树杀掉，不会留下可回收的僵尸句柄。
    #[cfg(windows)]
    #[test]
    #[allow(clippy::zombie_processes)]
    fn mcp_process_tree_helper() {
        use std::io::{BufRead as _, Write as _};

        let Ok(pid_file) = std::env::var("MYCHAT_MCP_TEST_HELPER_PIDFILE") else {
            return;
        };
        let mode = std::env::var("MYCHAT_MCP_TEST_HELPER_MODE").unwrap_or_default();
        let init = serde_json::json!({
            "jsonrpc": "2.0", "id": 1,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "serverInfo": { "name": "helper", "version": "0" }
            }
        });
        match mode.as_str() {
            "stderr_then_exit" => {
                eprintln!("mcp boom: missing config file");
                return;
            }
            "init_then_flood" => {
                println!("{init}");
                std::io::stdout().flush().ok();
                loop {
                    println!(
                        "{}",
                        serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": "notifications/message",
                            "params": { "level": "info", "data": "flood" }
                        })
                    );
                    std::io::stdout().flush().ok();
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            }
            "echo_tools" => {
                println!("{init}");
                std::io::stdout().flush().ok();
                let stdin = std::io::stdin();
                for line in stdin.lock().lines().map_while(std::result::Result::ok) {
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                        continue;
                    };
                    if v["id"] == 2 {
                        println!(
                            "{}",
                            serde_json::json!({
                                "jsonrpc": "2.0", "id": 2,
                                "result": { "tools": [] }
                            })
                        );
                        std::io::stdout().flush().ok();
                    }
                }
                return;
            }
            _ => {}
        }
        if mode == "init_then_hang" {
            println!("{init}");
            std::io::stdout().flush().ok();
        }
        let grandchild = std::process::Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("辅助进程启动 ping 孙进程");
        std::fs::write(&pid_file, grandchild.id().to_string()).expect("写入孙进程 PID");
        loop {
            std::thread::sleep(std::time::Duration::from_mins(1));
        }
    }

    /// 真机测试（Windows）：握手超时路径结束后，父进程与孙进程都必须退出。
    /// 走的是真实的 `rpc_call` 超时分支，而不是只测 cleanup 单元。
    #[cfg(windows)]
    #[tokio::test]
    async fn handshake_timeout_kills_whole_process_tree() {
        let pid_file =
            std::env::temp_dir().join(format!("mychat-mcp-tree-{}.pid", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_file(&pid_file);
        let mut server = mcp_server("", &[]);
        server.command = std::env::current_exe()
            .expect("取当前测试可执行文件")
            .to_string_lossy()
            .into_owned();
        server.args.push("mcp_process_tree_helper".to_string());
        server.env.insert(
            "MYCHAT_MCP_TEST_HELPER_PIDFILE".to_string(),
            pid_file.to_string_lossy().into_owned(),
        );
        let timeouts = RpcTimeouts {
            handshake: std::time::Duration::from_secs(3),
            call: std::time::Duration::from_secs(3),
            total: std::time::Duration::from_secs(10),
        };

        let err = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            rpc_call_with_timeouts(&server, "tools/list", serde_json::json!({}), timeouts),
        )
        .await
        .expect("超时清理不得挂起（挂起说明子进程没被杀掉）")
        .expect_err("装死的服务器必须触发握手超时");
        assert!(err.contains("握手超时"), "错误应为握手超时：{err}");

        // 辅助进程启动很快；稍等 PID 文件落盘（超时窗口内应已写好）。
        let grandchild = read_helper_pid(&pid_file)
            .await
            .expect("辅助进程未写出孙进程 PID（没启动成功？）");
        assert!(
            wait_until_dead(grandchild).await,
            "孙进程 {grandchild} 未随 MCP 进程树一起清理"
        );
        let _ = std::fs::remove_file(&pid_file);
    }

    /// 真机测试（Windows）：「tools/call 2 分钟无响应」的短超时版本。
    /// 辅助进程先回 initialize（过握手），再对 tools/list 装死；调用阶段超时后
    /// 同样必须清掉父进程与孙进程。
    #[cfg(windows)]
    #[tokio::test]
    async fn call_timeout_kills_whole_process_tree() {
        let pid_file =
            std::env::temp_dir().join(format!("mychat-mcp-tree-{}.pid", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_file(&pid_file);
        let mut server = mcp_server("", &[]);
        server.command = std::env::current_exe()
            .expect("取当前测试可执行文件")
            .to_string_lossy()
            .into_owned();
        // --nocapture：辅助进程要真的写 stdout（libtest 默认会吞掉 println!）。
        server.args = vec![
            "mcp_process_tree_helper".to_string(),
            "--nocapture".to_string(),
        ];
        server.env.insert(
            "MYCHAT_MCP_TEST_HELPER_PIDFILE".to_string(),
            pid_file.to_string_lossy().into_owned(),
        );
        server.env.insert(
            "MYCHAT_MCP_TEST_HELPER_MODE".to_string(),
            "init_then_hang".to_string(),
        );
        let timeouts = RpcTimeouts {
            handshake: std::time::Duration::from_secs(5),
            call: std::time::Duration::from_millis(1500),
            total: std::time::Duration::from_secs(10),
        };

        let err = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            rpc_call_with_timeouts(&server, "tools/list", serde_json::json!({}), timeouts),
        )
        .await
        .expect("超时清理不得挂起（挂起说明子进程没被杀掉）")
        .expect_err("不回 tools/list 的服务器必须触发调用超时");
        assert!(err.contains("请求超时"), "错误应为调用超时：{err}");

        let grandchild = read_helper_pid(&pid_file)
            .await
            .expect("辅助进程未写出孙进程 PID（没启动成功？）");
        assert!(
            wait_until_dead(grandchild).await,
            "孙进程 {grandchild} 未随 MCP 进程树一起清理"
        );
        let _ = std::fs::remove_file(&pid_file);
    }

    /// 真机测试（Windows）：cleanup 必须 kill/wait 子进程并 abort stderr drain，
    /// 不能留下挂起的读任务（T-007 的「错误路径遗留 reader」）。
    #[cfg(windows)]
    #[tokio::test]
    async fn cleanup_aborts_stderr_drain_and_reaps_child() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "ping -n 60 127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = cmd.spawn().expect("启动 cmd/ping");
        let mut guard = ChildGuard::new(child);
        let stderr = guard
            .child
            .as_mut()
            .expect("child 存活")
            .stderr
            .take()
            .expect("stderr 管道");
        guard.attach_stderr_drain(stderr);
        assert!(
            !guard
                .stderr_task
                .as_ref()
                .expect("drain 任务")
                .is_finished(),
            "子进程还活着时 stderr drain 应在等 EOF"
        );

        let (status, drain_was_running, stderr_tail) =
            tokio::time::timeout(std::time::Duration::from_secs(10), guard.cleanup())
                .await
                .expect("cleanup 不得挂起（挂起说明 child.wait 没等到进程退出）");

        assert!(status.is_some(), "cleanup 必须 wait 到子进程退出状态");
        assert!(
            drain_was_running,
            "cleanup 应观测到仍在运行的 stderr drain（证明 reader 确实需要收尾）"
        );
        assert!(guard.child.is_none(), "cleanup 后不得再持有子进程句柄");
        assert!(guard.stderr_task.is_none(), "cleanup 后不得遗留 drain 句柄");
        assert!(stderr_tail.is_empty(), "ping 不写 stderr：{stderr_tail}");
    }

    /// 正例：总时限存在时，正常握手 + 回包不受影响。
    #[cfg(windows)]
    #[tokio::test]
    async fn normal_call_succeeds_with_total_timeout() {
        let mut server = mcp_server("", &[]);
        server.command = std::env::current_exe()
            .expect("取当前测试可执行文件")
            .to_string_lossy()
            .into_owned();
        server.args = vec![
            "mcp_process_tree_helper".to_string(),
            "--nocapture".to_string(),
        ];
        server.env.insert(
            "MYCHAT_MCP_TEST_HELPER_PIDFILE".to_string(),
            std::env::temp_dir()
                .join(format!("mychat-mcp-ok-{}.pid", uuid::Uuid::new_v4()))
                .to_string_lossy()
                .into_owned(),
        );
        server.env.insert(
            "MYCHAT_MCP_TEST_HELPER_MODE".to_string(),
            "echo_tools".to_string(),
        );
        let timeouts = RpcTimeouts {
            handshake: std::time::Duration::from_secs(5),
            call: std::time::Duration::from_secs(5),
            total: std::time::Duration::from_secs(10),
        };

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            rpc_call_with_timeouts(&server, "tools/list", serde_json::json!({}), timeouts),
        )
        .await
        .expect("正常调用不得挂起")
        .expect("正常调用应成功");
        assert_eq!(result["tools"].as_array().map(Vec::len), Some(0));
    }

    /// T-053：服务器往 stderr 写错误后退出，错误信息必须带上该行。
    #[cfg(windows)]
    #[tokio::test]
    async fn startup_failure_includes_stderr_tail() {
        let mut server = mcp_server("", &[]);
        server.command = std::env::current_exe()
            .expect("取当前测试可执行文件")
            .to_string_lossy()
            .into_owned();
        server.args = vec![
            "mcp_process_tree_helper".to_string(),
            "--nocapture".to_string(),
        ];
        server.env.insert(
            "MYCHAT_MCP_TEST_HELPER_PIDFILE".to_string(),
            std::env::temp_dir()
                .join(format!("mychat-mcp-err-{}.pid", uuid::Uuid::new_v4()))
                .to_string_lossy()
                .into_owned(),
        );
        server.env.insert(
            "MYCHAT_MCP_TEST_HELPER_MODE".to_string(),
            "stderr_then_exit".to_string(),
        );
        let timeouts = RpcTimeouts {
            handshake: std::time::Duration::from_secs(5),
            call: std::time::Duration::from_secs(5),
            total: std::time::Duration::from_secs(10),
        };

        let err = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            rpc_call_with_timeouts(&server, "tools/list", serde_json::json!({}), timeouts),
        )
        .await
        .expect("失败路径不得挂起")
        .expect_err("提前退出的服务器必须报错");
        assert!(
            err.contains("mcp boom: missing config file"),
            "错误信息必须包含 stderr 尾部：{err}"
        );
    }

    /// T-052：服务器持续发 notification 时，单行等待会被不断重置；
    /// 整个调用必须被总时限掐断。
    #[cfg(windows)]
    #[tokio::test]
    async fn notification_flood_hits_total_timeout() {
        let mut server = mcp_server("", &[]);
        server.command = std::env::current_exe()
            .expect("取当前测试可执行文件")
            .to_string_lossy()
            .into_owned();
        server.args = vec![
            "mcp_process_tree_helper".to_string(),
            "--nocapture".to_string(),
        ];
        server.env.insert(
            "MYCHAT_MCP_TEST_HELPER_PIDFILE".to_string(),
            std::env::temp_dir()
                .join(format!("mychat-mcp-flood-{}.pid", uuid::Uuid::new_v4()))
                .to_string_lossy()
                .into_owned(),
        );
        server.env.insert(
            "MYCHAT_MCP_TEST_HELPER_MODE".to_string(),
            "init_then_flood".to_string(),
        );
        let timeouts = RpcTimeouts {
            handshake: std::time::Duration::from_secs(5),
            call: std::time::Duration::from_secs(5),
            total: std::time::Duration::from_millis(1200),
        };

        let err = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            rpc_call_with_timeouts(&server, "tools/list", serde_json::json!({}), timeouts),
        )
        .await
        .expect("总时限必须生效（挂起说明通知流可以无限延长调用）")
        .expect_err("持续刷通知的服务器必须失败");
        assert!(err.contains("总超时"), "错误应为总超时：{err}");
    }

    /// T-051：从备份/旧数据恢复进来的记录不经 `mcp_save_server`，
    /// 必须在启动前再校验一次，高危 env 直接拒绝。
    #[tokio::test]
    async fn blocked_env_is_rejected_at_spawn_even_if_not_saved_through_command() {
        let mut server = mcp_server("definitely-not-a-real-mcp-command", &[]);
        server
            .env
            .insert("NODE_OPTIONS".to_string(), "--require evil.js".to_string());
        let timeouts = RpcTimeouts {
            handshake: std::time::Duration::from_millis(100),
            call: std::time::Duration::from_millis(100),
            total: std::time::Duration::from_millis(500),
        };

        let err = rpc_call_with_timeouts(&server, "tools/list", serde_json::json!({}), timeouts)
            .await
            .expect_err("高危 env 必须在启动前被拒绝");
        assert!(err.contains("NODE_OPTIONS"), "错误应点名被拒的键：{err}");
        assert!(
            !err.contains("启动 MCP 服务器失败"),
            "必须在 spawn 之前拒绝，而不是执行后失败：{err}"
        );
    }
}
