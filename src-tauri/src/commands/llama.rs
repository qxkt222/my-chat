// commands/llama.rs — 内置 llama.cpp 运行时（用户自备 llama-server.exe + GGUF）
//
// 设计约束（冻结契约见 TRANS-DRAW-RECON.md 第 4 节）：
//  - 应用**不下载**任何二进制或模型，只负责启动/停止/健康检查/退出清理；
//  - 端口未指定时用 `TcpListener::bind("127.0.0.1:0")` 取空闲端口，失败重试 3 次；
//  - 子进程用 `kill_on_drop(true)` 兜底，显式停止走 `taskkill /T /F` 清整棵进程树；
//  - 健康检查轮询 `GET /health`：200=就绪、503=加载中，deadline 120s、间隔 500ms；
//  - 重复 `llama_start`：先停掉旧进程再启动新进程（新配置先做纯校验，校验失败不动旧进程）。

use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
use tauri::State;
use tokio::process::{Child, Command};

/// `ctx_size` 缺省值。
pub const DEFAULT_CTX_SIZE: u32 = 4096;
/// `n_gpu_layers` 缺省值：0 = 纯 CPU。
pub const DEFAULT_N_GPU_LAYERS: i32 = 0;

/// 端口分配失败时的重试次数（总共尝试次数）。
const PORT_ALLOC_ATTEMPTS: usize = 3;
/// 启动等待 `/health` 的总 deadline。
const HEALTH_DEADLINE: Duration = Duration::from_mins(2);
/// 健康检查轮询间隔。
const HEALTH_INTERVAL: Duration = Duration::from_millis(500);
/// 单次健康检查请求上限：本地请求正常毫秒级，慢请求不能吃掉整个 deadline。
const HEALTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// `stop` 等待子进程回收的上限，防止 taskkill 异常时卡死调用方。
const STOP_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
/// `CREATE_NO_WINDOW`：避免 Windows 上弹出控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 前端传入的启动配置。字段名按 camelCase 与前端对齐。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlamaConfig {
    /// `llama-server.exe` 绝对路径。
    pub server_path: String,
    /// `.gguf` 模型绝对路径。
    pub model_path: String,
    /// 上下文长度，缺省 4096。
    #[serde(default)]
    pub ctx_size: Option<u32>,
    /// 卸载到 GPU 的层数，缺省 0（CPU）。
    #[serde(default)]
    pub n_gpu_layers: Option<i32>,
    /// 端口，缺省自动分配。
    #[serde(default)]
    pub port: Option<u16>,
    /// 追加到命令行的额外参数。
    #[serde(default)]
    pub extra_args: Option<Vec<String>>,
}

/// 返回给前端的运行状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlamaStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

/// 已托管的子进程。`child` 一定带着 `kill_on_drop(true)` 创建。
struct ManagedLlama {
    child: Child,
    pid: u32,
    port: u16,
}

impl ManagedLlama {
    fn status(&self) -> LlamaStatus {
        LlamaStatus {
            running: true,
            port: Some(self.port),
            pid: Some(self.pid),
            error: None,
        }
    }
}

/// 健康检查参数。抽成结构体是为了单测能注入短 deadline / 短间隔。
#[derive(Debug, Clone, Copy)]
struct HealthOptions {
    deadline: Duration,
    interval: Duration,
    request_timeout: Duration,
}

impl HealthOptions {
    const DEFAULT: Self = Self {
        deadline: HEALTH_DEADLINE,
        interval: HEALTH_INTERVAL,
        request_timeout: HEALTH_REQUEST_TIMEOUT,
    };
}

/// 托管状态：`process` 存当前子进程，`last_error` 存最近一次启动失败/异常退出原因。
///
/// `op` 串行化 start/stop：两个并发 start 不会各自生成一个进程后互相覆盖。
pub struct LlamaState {
    process: Mutex<Option<ManagedLlama>>,
    last_error: Mutex<Option<String>>,
    op: tokio::sync::Mutex<()>,
}

impl Default for LlamaState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            last_error: Mutex::new(None),
            op: tokio::sync::Mutex::new(()),
        }
    }
}

/// 锁中毒时取回内部值：状态本身没有不变量会被 panic 破坏，继续用比 panic 好。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl LlamaState {
    /// 启动 `llama-server` 并等待 `/health` 就绪。已有进程会先被停掉。
    ///
    /// # Errors
    /// 路径校验、spawn、健康检查超时/提前退出都会返回可读错误。
    pub async fn start(&self, cfg: LlamaConfig) -> Result<LlamaStatus, String> {
        self.start_with_health(cfg, HealthOptions::DEFAULT).await
    }

    async fn start_with_health(
        &self,
        cfg: LlamaConfig,
        health: HealthOptions,
    ) -> Result<LlamaStatus, String> {
        // 先校验新配置：配置本身不合法时不碰正在运行的旧进程。
        validate_config(&cfg)?;
        let _serial = self.op.lock().await;
        // 重复 start 的语义：先停旧的，再启动新的。
        // 注意：必须先把 Option 取出来再 await —— 让 std MutexGuard 活到 await
        // 之后会让整个 future 变成 !Send，Tauri 命令直接编译失败。
        let old = lock(&self.process).take();
        if let Some(old) = old {
            stop_managed(old).await;
        }
        match start_managed(&cfg, health).await {
            Ok(managed) => {
                let status = managed.status();
                *lock(&self.last_error) = None;
                *lock(&self.process) = Some(managed);
                Ok(status)
            }
            Err(e) => {
                *lock(&self.last_error) = Some(e.clone());
                Err(e)
            }
        }
    }

    /// 停止当前进程（幂等：没有进程时返回 Ok）。
    ///
    /// # Errors
    /// 当前实现不会失败；保留 `Result` 以匹配 Tauri 命令契约。
    #[allow(clippy::unnecessary_wraps)] // Tauri 命令签名强制 Result
    pub async fn stop(&self) -> Result<(), String> {
        let _serial = self.op.lock().await;
        let managed = lock(&self.process).take();
        if let Some(managed) = managed {
            stop_managed(managed).await;
        }
        *lock(&self.last_error) = None;
        Ok(())
    }

    /// 查询运行状态；进程已退出时返回 running=false 并把退出原因放进 error。
    #[must_use]
    pub fn status(&self) -> LlamaStatus {
        let exited = {
            let mut guard = lock(&self.process);
            match guard.as_mut() {
                None => None,
                Some(managed) => match managed.child.try_wait() {
                    Ok(None) => return managed.status(),
                    Ok(Some(status)) => Some(format!("llama-server 已退出（{status}）")),
                    Err(e) => Some(format!("无法查询 llama-server 进程状态: {e}")),
                },
            }
        };
        if let Some(err) = exited {
            let _ = lock(&self.process).take();
            *lock(&self.last_error) = Some(err);
        }
        LlamaStatus {
            running: false,
            port: None,
            pid: None,
            error: lock(&self.last_error).clone(),
        }
    }
}

/// 退出清理（同步）：`RunEvent::Exit` 回调不能 await，这里用同步 taskkill + 轮询回收。
pub fn shutdown_blocking(state: &LlamaState) {
    let Some(managed) = lock(&state.process).take() else {
        return;
    };
    kill_process_tree_blocking(managed.pid);
    let mut child = managed.child;
    let _ = child.start_kill();
    let deadline = Instant::now() + STOP_WAIT_TIMEOUT;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// 校验路径与参数；纯函数，便于单测。
fn validate_config(cfg: &LlamaConfig) -> Result<(), String> {
    validate_file(&cfg.server_path, "llama-server 可执行文件")?;
    validate_file(&cfg.model_path, "GGUF 模型文件")?;
    let is_gguf = Path::new(&cfg.model_path)
        .extension()
        .is_some_and(|ext| ext.to_str().is_some_and(|e| e.eq_ignore_ascii_case("gguf")));
    if !is_gguf {
        return Err(format!(
            "模型文件必须是 .gguf 格式（大小写不敏感）: {}",
            cfg.model_path
        ));
    }
    if cfg.port == Some(0) {
        return Err("端口不能为 0：不指定端口（port=null）时由应用自动分配".to_string());
    }
    Ok(())
}

fn validate_file(raw: &str, label: &str) -> Result<(), String> {
    match std::fs::metadata(Path::new(raw)) {
        Ok(meta) if meta.is_file() => Ok(()),
        Ok(_) => Err(format!("{label}不是普通文件: {raw}")),
        Err(_) => Err(format!("{label}不存在或不可访问: {raw}")),
    }
}

/// 取一个当前可用的本地端口：bind 后立即释放，交给 llama-server 重新绑定。
fn allocate_port() -> Result<u16, String> {
    let mut last_err = "未知错误".to_owned();
    for _ in 0..PORT_ALLOC_ATTEMPTS {
        match TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => match listener.local_addr() {
                Ok(addr) => return Ok(addr.port()),
                Err(e) => last_err = e.to_string(),
            },
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(format!(
        "分配本地端口失败（已尝试 {PORT_ALLOC_ATTEMPTS} 次）: {last_err}"
    ))
}

/// spawn + 等待就绪；失败路径统一杀进程树并回收。
async fn start_managed(cfg: &LlamaConfig, health: HealthOptions) -> Result<ManagedLlama, String> {
    let port = cfg.port.map_or_else(allocate_port, Ok)?;
    let ctx_size = cfg.ctx_size.unwrap_or(DEFAULT_CTX_SIZE);
    let n_gpu_layers = cfg.n_gpu_layers.unwrap_or(DEFAULT_N_GPU_LAYERS);

    let mut cmd = Command::new(&cfg.server_path);
    cmd.arg("-m")
        .arg(&cfg.model_path)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("-c")
        .arg(ctx_size.to_string())
        .arg("-ngl")
        .arg(n_gpu_layers.to_string())
        .arg("--jinja");
    if let Some(extra) = &cfg.extra_args {
        cmd.args(extra);
    }
    // 不接管道：GUI 进程里没人读 stdout/stderr，接管道反而有写满阻塞的风险。
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 llama-server 失败（{}）: {e}", cfg.server_path))?;
    let pid = child
        .id()
        .ok_or_else(|| "无法获取 llama-server 的进程 PID".to_string())?;
    let mut managed = ManagedLlama { child, pid, port };
    if let Err(e) = wait_until_healthy(&mut managed.child, port, health).await {
        stop_managed(managed).await;
        return Err(e);
    }
    // 指定端口上可能已有别的服务应答 /health：再确认一次自己的进程还活着。
    if let Ok(Some(status)) = managed.child.try_wait() {
        stop_managed(managed).await;
        return Err(format!(
            "llama-server 在健康检查通过后立即退出（{status}）；端口 {port} 可能已被其他服务占用"
        ));
    }
    Ok(managed)
}

/// 轮询 `/health` 直到 200 或 deadline。503 表示模型仍在加载，继续等。
async fn wait_until_healthy(
    child: &mut Child,
    port: u16,
    opts: HealthOptions,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(opts.request_timeout)
        // 本机回环地址绝不能被系统代理接管。
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("创建健康检查客户端失败: {e}"))?;
    let url = format!("http://127.0.0.1:{port}/health");
    let started = Instant::now();
    let mut last_status: Option<u16> = None;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "llama-server 启动过程中退出（{status}）。请检查模型路径、显存/内存与端口 {port} 是否可用"
                ));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("无法查询 llama-server 进程状态: {e}")),
        }
        if let Ok(resp) = client.get(&url).send().await {
            let code = resp.status().as_u16();
            if code == 200 {
                return Ok(());
            }
            last_status = Some(code);
        }
        if started.elapsed() >= opts.deadline {
            return Err(timeout_message(port, last_status, opts.deadline));
        }
        tokio::time::sleep(opts.interval).await;
    }
}

fn timeout_message(port: u16, last_status: Option<u16>, deadline: Duration) -> String {
    let secs = deadline.as_secs();
    last_status.map_or_else(
        || {
            format!(
                "启动 llama-server 超时（{secs} 秒内无法连接 127.0.0.1:{port}/health，进程可能未监听该端口）"
            )
        },
        |code| {
            format!(
                "启动 llama-server 超时（{secs} 秒内 /health 始终返回 HTTP {code}，模型可能仍在加载或参数有误）"
            )
        },
    )
}

/// 杀进程树并回收；超时兜底后由 `kill_on_drop` 再补一刀。
async fn stop_managed(managed: ManagedLlama) {
    kill_process_tree(managed.pid).await;
    let mut child = managed.child;
    let _ = child.start_kill();
    let _ = tokio::time::timeout(STOP_WAIT_TIMEOUT, child.wait()).await;
}

/// `taskkill` 参数：`/T` 连子孙进程一起杀，`/F` 强制终止。
#[cfg(windows)]
fn taskkill_args(pid: u32) -> [String; 4] {
    [
        "/PID".to_string(),
        pid.to_string(),
        "/T".to_string(),
        "/F".to_string(),
    ]
}

/// Windows：`llama-server` 可能自己再拉起子进程，必须按进程树清理。
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
    // 非 Windows：直接子进程由 start_kill 结束。
}

/// 同步版进程树清理，供 `RunEvent::Exit` 使用。
#[cfg(windows)]
fn kill_process_tree_blocking(pid: u32) {
    let args = taskkill_args(pid);
    let _ = std::process::Command::new("taskkill")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn kill_process_tree_blocking(_pid: u32) {
    // 非 Windows：直接子进程由 start_kill 结束。
}

// ── Tauri commands ───────────────────────────────────────

/// 启动（或重启）内置 llama.cpp 运行时。
///
/// # Errors
/// 配置不合法、进程无法启动或 120 秒内未就绪时返回可读错误。
#[tauri::command]
pub async fn llama_start(
    state: State<'_, LlamaState>,
    cfg: LlamaConfig,
) -> Result<LlamaStatus, String> {
    state.start(cfg).await
}

/// 停止内置 llama.cpp 运行时（幂等）。
///
/// # Errors
/// 当前实现不会失败；保留 `Result` 以匹配前端契约。
#[tauri::command]
pub async fn llama_stop(state: State<'_, LlamaState>) -> Result<(), String> {
    state.stop().await
}

/// 查询内置 llama.cpp 运行状态。
///
/// # Errors
/// 当前实现不会失败；保留 `Result` 以匹配前端契约。
#[tauri::command]
#[allow(clippy::unused_async)] // 契约要求 async 命令
pub async fn llama_status(state: State<'_, LlamaState>) -> Result<LlamaStatus, String> {
    Ok(state.status())
}

// ── Tests ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Read as _, Write as _};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let p = std::env::temp_dir().join(format!(
            "my-chat-llama-test-{tag}-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&p).expect("创建临时目录");
        p
    }

    fn write_file(dir: &Path, name: &str, content: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, content).expect("写临时文件");
        path
    }

    fn config_for(server: &Path, model: &Path) -> LlamaConfig {
        LlamaConfig {
            server_path: server.to_string_lossy().into_owned(),
            model_path: model.to_string_lossy().into_owned(),
            ctx_size: None,
            n_gpu_layers: None,
            port: None,
            extra_args: None,
        }
    }

    /// 路径不存在 → 可读错误（点名是 llama-server 还是模型）。
    #[test]
    fn rejects_missing_server_path() {
        let dir = temp_dir("missing-server");
        let model = write_file(&dir, "m.gguf", b"x");
        let cfg = config_for(&dir.join("no-such-llama-server.exe"), &model);

        let err = validate_config(&cfg).expect_err("不存在的可执行文件必须被拒绝");
        assert!(err.contains("llama-server"), "错误应点名可执行文件: {err}");
        assert!(err.contains("不存在"), "错误应说明原因: {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 目录冒充可执行文件 → 明确说「不是普通文件」。
    #[test]
    fn rejects_directory_as_server_path() {
        let dir = temp_dir("dir-server");
        let model = write_file(&dir, "m.gguf", b"x");
        let cfg = config_for(&dir, &model);

        let err = validate_config(&cfg).expect_err("目录不能被当成可执行文件");
        assert!(err.contains("不是普通文件"), "错误应说明类型: {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 非 .gguf 后缀 → 拒绝。
    #[test]
    fn rejects_non_gguf_model() {
        let dir = temp_dir("bad-model");
        let server = write_file(&dir, "llama-server.exe", b"fake");
        let model = write_file(&dir, "model.bin", b"x");
        let cfg = config_for(&server, &model);

        let err = validate_config(&cfg).expect_err("非 .gguf 模型必须被拒绝");
        assert!(err.contains(".gguf"), "错误应说明后缀要求: {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 后缀大小写不敏感：MODEL.GGUF 必须放行。
    #[test]
    fn accepts_uppercase_gguf_suffix() {
        let dir = temp_dir("upper-model");
        let server = write_file(&dir, "llama-server.exe", b"fake");
        let model = write_file(&dir, "MODEL.GGUF", b"x");
        let cfg = config_for(&server, &model);

        assert!(
            validate_config(&cfg).is_ok(),
            "大小写不敏感：MODEL.GGUF 应放行"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端口 0 是「自动分配」的占位，不应由前端显式传入。
    #[test]
    fn rejects_explicit_zero_port() {
        let dir = temp_dir("zero-port");
        let server = write_file(&dir, "llama-server.exe", b"fake");
        let model = write_file(&dir, "m.gguf", b"x");
        let mut cfg = config_for(&server, &model);
        cfg.port = Some(0);

        let err = validate_config(&cfg).expect_err("端口 0 应被拒绝");
        assert!(err.contains("端口"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 自动分配的端口必须真的能再次绑定。
    #[test]
    fn allocated_port_is_bindable() {
        let port = allocate_port().expect("应能分配端口");
        assert_ne!(port, 0, "不能把 0 当端口返回");
        let listener = TcpListener::bind(("127.0.0.1", port)).expect("分配到的端口应可绑定");
        drop(listener);
    }

    // ── 以下用例会真的起子进程：仅 Windows ────────────────

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
        for _ in 0..60 {
            if !pid_is_alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[cfg(windows)]
    fn test_health_options() -> HealthOptions {
        HealthOptions {
            deadline: Duration::from_secs(10),
            interval: Duration::from_millis(50),
            request_timeout: Duration::from_secs(2),
        }
    }

    /// 假 `/health` 服务：按给定序列返回状态码（序列耗尽后沿用最后一个）。
    #[cfg(windows)]
    struct FakeHealthServer {
        port: u16,
        stop: Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    #[cfg(windows)]
    impl FakeHealthServer {
        fn start(statuses: &[u16]) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("绑定假健康检查端口");
            listener.set_nonblocking(true).expect("设为非阻塞");
            let port = listener.local_addr().expect("取本地地址").port();
            let stop = Arc::new(AtomicBool::new(false));
            let stop_thread = Arc::clone(&stop);
            let statuses: Vec<u16> = statuses.to_vec();
            let handle = std::thread::spawn(move || {
                let mut served = 0usize;
                while !stop_thread.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let mut buf = [0u8; 512];
                            let _ = stream.read(&mut buf);
                            let fallback = statuses.last().copied().unwrap_or(200);
                            let code = statuses.get(served).copied().unwrap_or(fallback);
                            served += 1;
                            let body = b"{\"status\":\"ok\"}";
                            let head = format!(
                                "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            let _ = stream.write_all(head.as_bytes());
                            let _ = stream.write_all(body);
                            let _ = stream.flush();
                        }
                        Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                port,
                stop,
                handle: Some(handle),
            }
        }
    }

    #[cfg(windows)]
    impl Drop for FakeHealthServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    /// 临时脚本扮演 llama-server：忽略参数，长命 ping 撑住进程。
    #[cfg(windows)]
    fn fake_server_script(dir: &Path) -> PathBuf {
        write_file(
            dir,
            "fake-llama-server.cmd",
            b"@echo off\r\nping -n 120 127.0.0.1 >nul\r\n",
        )
    }

    /// 健康检查超时：deadline 到期必须返回可读错误，且清理后进程树不残留。
    /// 用 `cmd /c ping` 模拟「进程活着但永远不就绪」的 server。
    #[cfg(windows)]
    #[tokio::test]
    async fn health_timeout_kills_process_and_leaves_no_residue() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "ping -n 60 127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = cmd.spawn().expect("启动假 server");
        let pid = child.id().expect("取 PID");
        let port = allocate_port().expect("分配端口");
        let mut managed = ManagedLlama { child, pid, port };

        let opts = HealthOptions {
            deadline: Duration::from_millis(800),
            interval: Duration::from_millis(100),
            request_timeout: Duration::from_millis(300),
        };
        let err = tokio::time::timeout(
            Duration::from_secs(10),
            wait_until_healthy(&mut managed.child, port, opts),
        )
        .await
        .expect("健康检查不得挂起")
        .expect_err("没有服务监听 /health，必须超时");
        assert!(err.contains("超时"), "错误应为健康检查超时: {err}");

        tokio::time::timeout(Duration::from_secs(10), stop_managed(managed))
            .await
            .expect("清理不得挂起");
        assert!(
            wait_until_dead(pid).await,
            "超时后假 server 进程（树）必须被清理，不能残留"
        );
    }

    /// 503（加载中）应继续轮询，直到 200。
    #[cfg(windows)]
    #[tokio::test]
    async fn health_polls_through_503_until_ready() {
        let server = FakeHealthServer::start(&[503, 503, 200]);
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "ping -n 60 127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = cmd.spawn().expect("启动假 server");
        let pid = child.id().expect("取 PID");
        let mut managed = ManagedLlama {
            child,
            pid,
            port: server.port,
        };

        tokio::time::timeout(
            Duration::from_secs(10),
            wait_until_healthy(&mut managed.child, server.port, test_health_options()),
        )
        .await
        .expect("健康检查不得挂起")
        .expect("503 之后出现 200 应判定为就绪");

        tokio::time::timeout(Duration::from_secs(10), stop_managed(managed))
            .await
            .expect("清理不得挂起");
        assert!(wait_until_dead(pid).await, "假 server 必须被清理");
    }

    /// 重复 start：旧进程必须先被停掉，新进程接管状态。
    #[cfg(windows)]
    #[tokio::test]
    async fn second_start_stops_previous_process() {
        let dir = temp_dir("dup-start");
        let model = write_file(&dir, "m.gguf", b"x");
        let script = fake_server_script(&dir);
        let state = LlamaState::default();

        let first_server = FakeHealthServer::start(&[200]);
        let mut cfg1 = config_for(&script, &model);
        cfg1.port = Some(first_server.port);
        let first = state
            .start_with_health(cfg1, test_health_options())
            .await
            .expect("第一次启动应成功");
        assert!(first.running, "第一次启动后应处于运行状态");
        let pid1 = first.pid.expect("第一次启动的 PID");

        let second_server = FakeHealthServer::start(&[200]);
        let mut cfg2 = config_for(&script, &model);
        cfg2.port = Some(second_server.port);
        let second = state
            .start_with_health(cfg2, test_health_options())
            .await
            .expect("第二次启动应成功");
        let pid2 = second.pid.expect("第二次启动的 PID");
        assert_ne!(pid1, pid2, "第二次启动必须换一个新进程");
        assert!(
            wait_until_dead(pid1).await,
            "重复 start 必须先停掉旧进程 {pid1}"
        );
        assert!(pid_is_alive(pid2), "新进程 {pid2} 应仍在运行");

        let status = state.status();
        assert!(status.running, "状态应反映新进程在运行");
        assert_eq!(status.pid, Some(pid2));

        state.stop().await.expect("停止应成功");
        assert!(wait_until_dead(pid2).await, "stop 后进程必须退出");
        assert!(!state.status().running, "stop 后状态必须为未运行");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 进程自行退出后，status 必须给出 running=false 与可读原因。
    #[cfg(windows)]
    #[tokio::test]
    async fn status_reports_exited_process() {
        let state = LlamaState::default();
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "exit 7"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = cmd.spawn().expect("启动短命进程");
        let pid = child.id().expect("取 PID");
        *lock(&state.process) = Some(ManagedLlama {
            child,
            pid,
            port: 6553,
        });

        // 等一小会儿让进程真正退出。
        for _ in 0..40 {
            if !pid_is_alive(pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let status = state.status();
        assert!(!status.running, "进程已退出时必须报告 running=false");
        assert!(status.pid.is_none());
        assert!(status.port.is_none());
        let err = status.error.expect("应附带退出原因");
        assert!(err.contains("已退出"), "错误应说明进程已退出: {err}");
    }
}
