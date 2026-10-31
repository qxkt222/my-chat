// commands/chat.rs
// SSE streaming chat command

use crate::adapters::engine::build_api_url;
use crate::adapters::sse_parser::{parse_sse_chunk, strip_data_prefix, AdapterConfig};
use crate::net::{
    redact_url, redact_urls_in_text, SseLineBuffer, FIRST_BYTE_TIMEOUT, FIRST_BYTE_TIMEOUT_MESSAGE,
    STREAM_IDLE_TIMEOUT, STREAM_TIMEOUT_MESSAGE,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Round-robin counter for multi-key rotation (Cherry Studio style: comma-separated keys)
static KEY_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Per-request cancellation: each stream is identified by a frontend-generated
/// `request_id` (uuid); `cancel_chat` inserts the id and the stream loop checks it.
/// Ids are unique per stream, but the map would grow forever on a long-lived
/// process — entries carry their insert time and stale ones are pruned once the
/// map passes a threshold (a fresh cancel always inserts a new entry, so pruning
/// old ones never breaks an active stop request).
static CANCELLED: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const CANCEL_TTL: Duration = Duration::from_mins(10);
const CANCEL_MAX: usize = 1024;

#[tauri::command]
#[allow(clippy::unnecessary_wraps)] // Tauri 命令签名强制 Result
pub fn cancel_chat(request_id: String) -> Result<(), String> {
    let mut map = CANCELLED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if map.len() >= CANCEL_MAX {
        map.retain(|_, t| t.elapsed() < CANCEL_TTL);
    }
    map.insert(request_id, Instant::now());
    Ok(())
}

/// Frontend-facing diagnostics: record an error that happened in the
/// frontend/invoke layer (before `stream_chat`'s body ever ran), so we can
/// diagnose IPC failures that never reach the Rust stream logic.
#[tauri::command]
#[allow(clippy::unnecessary_wraps)] // Tauri 命令签名强制 Result
pub fn log_diag(message: String) -> Result<(), String> {
    log_chat_error(&format!("FRONTEND: {message}"));
    Ok(())
}

fn is_cancelled(request_id: &str) -> bool {
    CANCELLED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains_key(request_id)
}

/// 请求结束（成功 / 失败 / 超时 / 用户取消）后清掉取消标记。
/// 只插不删会让错误路径留下幽灵条目：同 id 的后续请求一进来就被误判为已取消。
fn clear_cancelled(request_id: &str) {
    CANCELLED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(request_id);
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Message {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub timestamp: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelConfig {
    pub name: String,
    pub api_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub provider: String,
}

/// Custom API template (the "adapter" subsystem): lets a request use a fully
/// user-defined URL / method / headers / body / SSE parsing instead of the
/// hardcoded OpenAI-compatible path.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApiTemplateDto {
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub api_url: String,
    #[serde(default)]
    pub request_method: String,
    #[serde(default)]
    pub request_headers: HashMap<String, String>,
    #[serde(default)]
    pub request_body_template: String,
    #[serde(default)]
    pub sse_enabled: bool,
    #[serde(default)]
    pub sse_data_prefix: String,
    #[serde(default)]
    pub sse_done_marker: String,
    #[serde(default)]
    pub sse_content_path: String,
    #[serde(default)]
    pub response_content_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatRequest {
    pub model_config: ModelConfig,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub temperature: Option<f64>,
    /// Max output tokens (global default parameters) — sent only when set.
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Samplers (酒馆 API 响应配置) — sent only when set; the extended fields
    /// (`top_k` / `repetition_penalty` / `min_p`) apply to local backends
    /// (vLLM / llama.cpp etc.), `OpenAI` standard fields apply to all.
    #[serde(default)]
    pub top_p: Option<f64>,
    #[serde(default)]
    pub top_k: Option<u32>,
    #[serde(default)]
    pub repetition_penalty: Option<f64>,
    #[serde(default)]
    pub frequency_penalty: Option<f64>,
    #[serde(default)]
    pub presence_penalty: Option<f64>,
    #[serde(default)]
    pub min_p: Option<f64>,
    /// DRY / Mirostat (llama.cpp 本地端点扩展采样器) — sent only when set
    #[serde(default)]
    pub mirostat: Option<u32>,
    #[serde(default)]
    pub mirostat_tau: Option<f64>,
    #[serde(default)]
    pub mirostat_eta: Option<f64>,
    #[serde(default)]
    pub dry_multiplier: Option<f64>,
    #[serde(default)]
    pub dry_base: Option<f64>,
    #[serde(default)]
    pub dry_allowed_length: Option<u32>,
    #[serde(default)]
    pub dry_penalty_last_n: Option<i64>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub knowledge_context: Option<String>,
    /// Frontend-generated id that routes stream events and enables per-request cancel
    #[serde(default)]
    pub request_id: String,
    /// Thinking mode for reasoning models (`DeepSeek` v4): Some(true) → enabled, Some(false) → disabled, None → server default
    #[serde(default)]
    pub thinking_enabled: Option<bool>,
    /// Reasoning effort: "low" | "medium" | "high" | "max" ("" or "auto" = leave to server)
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// Stopping strings (酒馆 Stopping Strings): 生成到这些串时提前终止;按序发送给支持
    /// 的服务端(OpenAI `stop` 参数),本地后端(llama.cpp)同样支持
    #[serde(default)]
    pub stopping_strings: Option<Vec<String>>,
    /// Custom API template — when present, the request is built/parsed from the
    /// template instead of the hardcoded OpenAI-compatible path.
    #[serde(default)]
    pub template: Option<ApiTemplateDto>,
}

#[tauri::command]
pub async fn stream_chat(app: AppHandle, request: ChatRequest) -> Result<(), String> {
    let result = stream_chat_inner(&app, &request).await;
    // 无论成功、失败、超时还是用户取消，这个请求都已经结束：清掉取消标记。
    // 否则错误路径会在 CANCELLED 里留下幽灵条目（同 id 请求会被误判为已取消）。
    clear_cancelled(&request.request_id);
    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            // Always record the failure so it can be diagnosed from
            // chat_errors.log when the UI shows an empty error. URL 必须先脱敏：
            // 日志会同时落到 %APPDATA% 与 exe 同级目录（T-067）。
            log_chat_error(&failure_log_message(
                &request.model_config.api_url,
                &request.model_config.model,
                &request.model_config.name,
                &e,
            ));
            Err(e)
        }
    }
}

/// 失败日志行：`api_url` 与错误正文里的 URL 都先脱敏（T-067）。
///
/// query 里可能带 `key` / `token`；`reqwest::Error` 的 Display 也会带完整
/// 请求 URL，两处都必须擦掉，只保留 host/path 供排障。
fn failure_log_message(api_url: &str, model: &str, name: &str, error: &str) -> String {
    format!(
        "url={} model={model} name={name} err={}",
        redact_url(&build_api_url(api_url)),
        redact_urls_in_text(&clip(error, 2048))
    )
}

async fn stream_chat_inner(app: &AppHandle, request: &ChatRequest) -> Result<(), String> {
    // 空消息守卫必须在**所有**分支之前（T-060）：模板路径此前先 return，
    // 空消息照样发网络，用户看到的是上游 400，而不是本地可读提示。
    preflight(request)?;

    // Custom API template path (adapter subsystem): full user-defined control
    if let Some(tpl) = &request.template {
        return stream_via_template(app, request, tpl).await;
    }

    let ChatRequest {
        model_config,
        messages,
        temperature,
        max_tokens,
        top_p,
        top_k,
        repetition_penalty,
        frequency_penalty,
        presence_penalty,
        min_p,
        mirostat,
        mirostat_tau,
        mirostat_eta,
        dry_multiplier,
        dry_base,
        dry_allowed_length,
        dry_penalty_last_n,
        request_id,
        thinking_enabled,
        reasoning_effort,
        stopping_strings,
        ..
    } = request;

    let url = build_api_url(&model_config.api_url);
    let temp = temperature.unwrap_or(0.7);

    // Multi-key rotation: comma-separated API keys are used round-robin (Cherry Studio style)
    let keys: Vec<&str> = model_config
        .api_key
        .split(',')
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .collect();
    let api_key = if keys.is_empty() {
        String::new()
    } else {
        keys[KEY_COUNTER.fetch_add(1, AtomicOrdering::Relaxed) % keys.len()].to_string()
    };

    let mut msg_list: Vec<serde_json::Value> = Vec::new();

    // NOTE: system prompt + knowledge context are already baked into `messages`
    // by the frontend in cache-friendly order (stable prefix first, variable
    // tail last). Do NOT prepend them here — duplicating a system message
    // would invalidate the DeepSeek prompt cache prefix.
    for m in messages {
        msg_list.push(serde_json::json!({"role": m.role, "content": m.content}));
    }

    let mut body = serde_json::json!({
        "model": model_config.model,
        "messages": msg_list,
        "temperature": temp,
        "stream": true
    });

    // Max output tokens from the frontend's global default parameters
    if let Some(max_tokens) = max_tokens {
        if *max_tokens > 0 {
            body["max_tokens"] = serde_json::json!(*max_tokens);
        }
    }

    // Samplers (酒馆 API 响应配置):有值才写,不影响现有服务商
    if let Some(v) = top_p {
        body["top_p"] = serde_json::json!(v);
    }
    if let Some(v) = top_k {
        if *v > 0 {
            body["top_k"] = serde_json::json!(v);
        }
    }
    if let Some(v) = repetition_penalty {
        body["repetition_penalty"] = serde_json::json!(v);
    }
    if let Some(v) = frequency_penalty {
        body["frequency_penalty"] = serde_json::json!(v);
    }
    if let Some(v) = presence_penalty {
        body["presence_penalty"] = serde_json::json!(v);
    }
    if let Some(v) = min_p {
        body["min_p"] = serde_json::json!(v);
    }
    // DRY / Mirostat (llama.cpp 本地端点;仅 mirostat>0 时发,其余有值即发)
    if let Some(v) = mirostat {
        if *v > 0 {
            body["mirostat"] = serde_json::json!(v);
        }
    }
    if let Some(v) = mirostat_tau {
        body["mirostat_tau"] = serde_json::json!(v);
    }
    if let Some(v) = mirostat_eta {
        body["mirostat_eta"] = serde_json::json!(v);
    }
    if let Some(v) = dry_multiplier {
        body["dry_multiplier"] = serde_json::json!(v);
    }
    if let Some(v) = dry_base {
        body["dry_base"] = serde_json::json!(v);
    }
    if let Some(v) = dry_allowed_length {
        body["dry_allowed_length"] = serde_json::json!(v);
    }
    if let Some(v) = dry_penalty_last_n {
        body["dry_penalty_last_n"] = serde_json::json!(v);
    }

    // Reasoning model controls (DeepSeek v4 etc.): thinking switch + effort
    if let Some(enabled) = thinking_enabled {
        body["thinking"] =
            serde_json::json!({ "type": if *enabled { "enabled" } else { "disabled" } });
    }
    if let Some(effort) = reasoning_effort {
        if !effort.is_empty() && effort != "auto" {
            body["reasoning_effort"] = serde_json::json!(effort);
        }
    }

    // Stopping strings (酒馆 Stopping Strings): 非空才发送(OpenAI `stop` 参数)
    if let Some(stops) = stopping_strings {
        let clean: Vec<String> = stops
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !clean.is_empty() {
            body["stop"] = serde_json::json!(clean);
        }
    }

    let client = crate::net::streaming_client();
    // 流式客户端没有总超时：若服务端接受连接后永不返回响应头，
    // `send()` 会一直挂着。等待响应头也属于首字节阶段，同样受 180s 保护；
    // 等待期间还要响应「停止」（T-063）—— 否则用户点停止后最多再等 180s。
    let Some(resp) = await_headers_cancellable(
        client
            .post(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .json(&body)
            .send(),
        request_id,
        app,
    )
    .await?
    else {
        return Ok(());
    };

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        // 错误体读取有硬上限并响应取消，避免半开连接让请求永久挂起。
        let Some(text) = read_error_body(resp, request_id).await? else {
            return Ok(());
        };
        // 上游错误页可能很大，截断后再回传（完整原文不再进 UI 与日志）
        return Err(format!("API error {status}: {}", clip(&text, 2048)));
    }

    let adapter = AdapterConfig::openai_compatible();

    // 统一收尾：`[DONE]`、对端正常关闭、用户取消都在 `run_sse_stream` 内发
    // **恰好一次** done（带 cache 统计）；读取失败/超时/流内错误返回 Err，
    // 由 invoke 的 rejection 触发前端 onError —— 同一次失败绝不双发 done。
    run_sse_stream(app, request_id, resp.bytes_stream(), |line| {
        handle_openai_line(app, request_id, &adapter, line)
    })
    .await
}

/// 选择本次 `stream.next()` 的等待上限与对应错误文案。
///
/// - 首片：`FIRST_BYTE_TIMEOUT`（180s），对应"首字节超时"；
/// - 后续：`STREAM_IDLE_TIMEOUT`（60s），对应"响应超时（无数据）"。
fn stream_chunk_timeout(first_chunk: bool) -> (Duration, &'static str) {
    if first_chunk {
        (FIRST_BYTE_TIMEOUT, FIRST_BYTE_TIMEOUT_MESSAGE)
    } else {
        (STREAM_IDLE_TIMEOUT, STREAM_TIMEOUT_MESSAGE)
    }
}

/// 等待响应头（`send()`），超时计入首字节阶段，并响应取消（T-063）。
///
/// `streaming_client()` 刻意没有总超时（长回答不能被一刀切断），但这也意味着
/// "连上了却不回响应头"会永久挂起。这里只包住等头阶段：进入 body 之后由
/// 逐片超时（首片 180s / 后续 60s）接管。
///
/// 用户点「停止」时返回 `Ok(None)`，并按流契约补发唯一一次 done —— 与
/// `run_sse_stream` 的取消路径一致，前端不会把取消当成失败。
async fn await_headers_cancellable<F, T, E>(
    fut: F,
    request_id: &str,
    app: &AppHandle,
) -> Result<Option<T>, String>
where
    F: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    match await_cancellable_with_timeout(
        fut,
        request_id,
        FIRST_BYTE_TIMEOUT,
        FIRST_BYTE_TIMEOUT_MESSAGE,
    )
    .await
    {
        Ok(Ok(value)) => Ok(Some(value)),
        Ok(Err(e)) => Err(format!("Request error: {e}")),
        Err(_) if is_cancelled(request_id) => {
            emit_done_with_cache(app, request_id, 0, 0);
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// `await_headers` 的可注入超时版本：单测用毫秒级超时，避免真等 180s。
#[cfg(test)]
async fn await_headers_with_timeout<F, T, E>(wait: Duration, fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    match tokio::time::timeout(wait, fut).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => Err(format!("Request error: {e}")),
        Err(_) => Err(FIRST_BYTE_TIMEOUT_MESSAGE.to_string()),
    }
}

/// 非 2xx 响应体的读取上限。`streaming_client()` 没有总超时（长回答不能被
/// 一刀切断），但错误体若在响应头之后卡死/半开，`resp.text()` 会永久挂起，
/// 点停止也无效 —— 这里给错误体读取一个硬上限。
const ERROR_BODY_TIMEOUT: Duration = Duration::from_secs(30);
const ERROR_BODY_TIMEOUT_MESSAGE: &str = "读取错误响应超时（30 秒）";
const ERROR_BODY_CANCELLED_MESSAGE: &str = "请求已取消";
/// 取消轮询间隔：足够短以让「停止」及时生效，又不至于空转。
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// 读取非 2xx 响应体，最多等待 `ERROR_BODY_TIMEOUT`，期间轮询取消标记。
///
/// `Ok(Some(text))` 读到 body；`Ok(None)` 表示用户已停止（与流循环的静默
/// `break` 一致，不上报错误）；读取失败沿用原行为（空 body），HTTP 状态码
/// 仍会回传；只有超时才返回 `Err`。
async fn read_error_body(
    resp: reqwest::Response,
    request_id: &str,
) -> Result<Option<String>, String> {
    match await_cancellable(resp.text(), request_id, ERROR_BODY_TIMEOUT).await {
        Ok(text) => Ok(Some(text.unwrap_or_default())),
        Err(error) => {
            if is_cancelled(request_id) {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

/// 等待 `fut` 完成，但不超过 `wait`；等待期间轮询 `request_id` 的取消标记。
///
/// 超时返回 `ERROR_BODY_TIMEOUT_MESSAGE`，取消返回 `ERROR_BODY_CANCELLED_MESSAGE`。
/// `fut` 被 `Box::pin` 后反复轮询，单次超时轮次**不会丢弃**它 —— 下一轮继续等。
async fn await_cancellable<F, T>(fut: F, request_id: &str, wait: Duration) -> Result<T, String>
where
    F: std::future::Future<Output = T>,
{
    await_cancellable_with_timeout(fut, request_id, wait, ERROR_BODY_TIMEOUT_MESSAGE).await
}

/// [`await_cancellable`] 的可定制超时文案版本。
///
/// SSE 分片等待用各自阶段的文案（首片 180s / 后续 60s），错误体读取用
/// 30s 文案；取消语义一致（每 [`CANCEL_POLL_INTERVAL`] 轮询一次取消标记）。
async fn await_cancellable_with_timeout<F, T>(
    fut: F,
    request_id: &str,
    wait: Duration,
    timeout_msg: &str,
) -> Result<T, String>
where
    F: std::future::Future<Output = T>,
{
    let mut fut = Box::pin(fut);
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        if is_cancelled(request_id) {
            return Err(ERROR_BODY_CANCELLED_MESSAGE.to_string());
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(timeout_msg.to_string());
        }
        if let Ok(value) = tokio::time::timeout(remaining.min(CANCEL_POLL_INTERVAL), &mut fut).await
        {
            return Ok(value);
        }
    }
}

/// 单行 SSE 的处理结果。
///
/// 本行产生的正文/思考内容由 handler 直接 emit 成 **非 done** 的 token 事件；
/// 这里只回传收尾决策，让 `run_sse_stream` 成为唯一的 done 出口。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct LineEffect {
    /// 本行携带的 prompt-cache 用量（`DeepSeek` 最后一片的 usage）。
    usage: Option<(u64, u64)>,
    /// 本行是结束标记（如 `[DONE]` / 模板自定义 marker）。
    done: bool,
}

/// `chat-stream` 事件的发送端口。
///
/// 生产环境由 `AppHandle` 实现；单测用记录型 sink 替代，从而能在没有
/// Tauri 运行时的前提下钉住「每次请求 done 恰好一次」的契约。
trait ChatEventSink {
    fn emit_stream(&self, payload: serde_json::Value);
}

impl ChatEventSink for AppHandle {
    fn emit_stream(&self, payload: serde_json::Value) {
        let _ = Emitter::emit(self, "chat-stream", payload);
    }
}

/// 驱动一条 SSE 流直到结束，并保证**恰好一次** done 事件。
///
/// - 收到结束标记 / 对端正常关闭 / 用户取消 → 发一次 done（携带累计 cache
///   统计）后返回 `Ok(())`；
/// - 读取失败、超时或流内错误 → 返回 `Err` 且**不发 done**：前端已经通过
///   `invoke` 的 rejection 走 `onError`，再发 done 就是同一失败报两次。
async fn run_sse_stream<S, T, V, E, H>(
    sink: &S,
    request_id: &str,
    mut stream: T,
    mut on_line: H,
) -> Result<(), String>
where
    S: ChatEventSink,
    T: futures::Stream<Item = Result<V, E>> + Unpin,
    V: AsRef<[u8]>,
    E: std::fmt::Display,
    H: FnMut(&str) -> Result<LineEffect, String>,
{
    // RS-10：按字节缓冲，只在凑齐完整行时解码 —— 跨分片的中文不会再变成 `�`。
    let mut lines = SseLineBuffer::new();
    // DeepSeek prompt-cache telemetry: last chunk carries usage; track it so the
    // frontend can display the cache hit rate.
    let mut cache_hit: u64 = 0;
    let mut cache_miss: u64 = 0;

    // 首片与后续片的容忍度不同：模型冷启动/排队时首字节可能很慢（180s），
    // 但一旦开始吐字，超过 60s 没有新数据就应判定为卡死。
    let mut first_chunk = true;
    loop {
        // Honour cancellation for this specific request (user pressed Stop).
        // 每个等待周期检查一次：端点挂起时由下面的超时兜底，
        // 不会再出现"停止无效、请求永远挂着"（RS-07）。
        if is_cancelled(request_id) {
            break;
        }
        let (wait, timeout_msg) = stream_chunk_timeout(first_chunk);
        // 等待分片本身也要响应取消（T-063）：旧实现只在两次 `next()` 之间
        // 检查标记，点停止后仍要等满 60s / 180s，连接迟迟不关。
        let chunk = match await_cancellable_with_timeout(
            stream.next(),
            request_id,
            wait,
            timeout_msg,
        )
        .await
        {
            Ok(Some(chunk)) => {
                first_chunk = false;
                chunk.map_err(|e| format!("Stream error: {e}"))?
            }
            Ok(None) => break,
            Err(_) if is_cancelled(request_id) => break,
            Err(e) => return Err(e),
        };
        for line in lines.push(chunk.as_ref())? {
            if apply_line_effect(
                on_line(&line)?,
                &mut cache_hit,
                &mut cache_miss,
                sink,
                request_id,
            ) {
                return Ok(());
            }
        }
    }

    // 流结束时 flush 末尾没有换行的残行（部分服务端最后一行不带 \n）。
    if let Some(line) = lines.flush() {
        if apply_line_effect(
            on_line(&line)?,
            &mut cache_hit,
            &mut cache_miss,
            sink,
            request_id,
        ) {
            return Ok(());
        }
    }

    emit_done_with_cache(sink, request_id, cache_hit, cache_miss);
    Ok(())
}

/// 累积本行的 cache 用量；若本行是结束标记则发唯一一次 done 并返回 `true`。
fn apply_line_effect<S: ChatEventSink>(
    effect: LineEffect,
    cache_hit: &mut u64,
    cache_miss: &mut u64,
    sink: &S,
    request_id: &str,
) -> bool {
    if let Some((hit, miss)) = effect.usage {
        *cache_hit = hit;
        *cache_miss = miss;
    }
    if effect.done {
        emit_done_with_cache(sink, request_id, *cache_hit, *cache_miss);
        return true;
    }
    false
}

/// 处理一条 `OpenAI` 兼容 SSE 行；只 emit 正文/思考 token，不发 done。
///
/// 结束标记通过 `LineEffect::done` 回传，由 `run_sse_stream` 统一收尾。
/// 流内错误事件（HTTP 200 + `{"error":...}`）返回 `Err`，由调用方中断整条流。
fn handle_openai_line<S: ChatEventSink>(
    sink: &S,
    request_id: &str,
    adapter: &AdapterConfig,
    line: &str,
) -> Result<LineEffect, String> {
    if line.is_empty() || line.starts_with(':') {
        return Ok(LineEffect::default());
    }

    // usage 可能与正文/结束信息同处一行，必须在判定 done 之前记下来，
    // 否则最后一片的 cache 统计会丢。
    let usage = extract_usage(line);

    if let Some((content, done)) = parse_sse_chunk(adapter, line)? {
        if done {
            // 结束标记行本身不发事件：唯一 done 由 run_sse_stream 统一发。
            return Ok(LineEffect { usage, done: true });
        }
        // Reasoning models (e.g. DeepSeek v4) stream their thinking in
        // delta.reasoning_content — surface it so the UI can show it.
        let reasoning = extract_reasoning(line);
        if !content.is_empty() || !reasoning.is_empty() {
            sink.emit_stream(serde_json::json!({
                "request_id": request_id, "done": false,
                "content": content, "reasoning": reasoning
            }));
        }
    }
    Ok(LineEffect { usage, done: false })
}

/// 处理一条模板 SSE 行；只 emit 正文 token，不发 done。
///
/// 结束标记通过 `LineEffect::done` 回传，由 `run_sse_stream` 统一收尾。
/// 流内错误事件（HTTP 200 + `{"error":...}`）返回 `Err`，由调用方中断整条流。
fn handle_template_line<S: ChatEventSink>(
    sink: &S,
    request_id: &str,
    adapter: &AdapterConfig,
    line: &str,
) -> Result<LineEffect, String> {
    if line.is_empty() || line.starts_with(':') {
        return Ok(LineEffect::default());
    }
    if let Some((content, done)) = parse_sse_chunk(adapter, line)? {
        if done {
            return Ok(LineEffect {
                usage: None,
                done: true,
            });
        }
        if !content.is_empty() {
            sink.emit_stream(serde_json::json!({
                "request_id": request_id, "done": false, "content": content, "reasoning": ""
            }));
        }
    }
    Ok(LineEffect::default())
}

/// Stream via a custom API template: build the request from
/// `request_body_template` / `request_headers` / `api_url`, then parse the response
/// using `sse_content_path` (SSE) or `response_content_path` (single JSON body).
async fn stream_via_template(
    app: &AppHandle,
    request: &ChatRequest,
    tpl: &ApiTemplateDto,
) -> Result<(), String> {
    let request_id = &request.request_id;
    let temp = request.temperature.unwrap_or(0.7);
    let max_tokens = request.max_tokens.unwrap_or(0);

    // Multi-key rotation (same as OpenAI path)
    let keys: Vec<&str> = request
        .model_config
        .api_key
        .split(',')
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .collect();
    let api_key = if keys.is_empty() {
        String::new()
    } else {
        keys[KEY_COUNTER.fetch_add(1, AtomicOrdering::Relaxed) % keys.len()].to_string()
    };

    // Messages + system prompt. The frontend bakes system prompt AND knowledge
    // context into `messages` in cache-friendly order — so sp must carry ONLY
    // the system prompt here. Appending knowledge_context again would duplicate
    // the "Reference Knowledge" block when the template uses both {{messages}}
    // and {{system_prompt}} (the knowledge would be injected twice).
    let mut msg_list: Vec<serde_json::Value> = Vec::new();
    let mut sp = String::new();
    if let Some(s) = &request.system_prompt {
        sp.push_str(s);
    }
    for m in &request.messages {
        msg_list.push(serde_json::json!({"role": m.role, "content": m.content}));
    }

    // Render body from template
    let body = render_template_body(
        &tpl.request_body_template,
        &request.model_config.model,
        &msg_list,
        temp,
        &api_key,
        &sp,
        max_tokens,
    );

    let url = tpl.api_url.trim_end_matches('/').to_string();
    let method = if tpl.request_method.eq_ignore_ascii_case("GET") {
        reqwest::Method::GET
    } else {
        reqwest::Method::POST
    };

    // SSE 用无总超时的流式客户端；普通 JSON 响应用带 120s 总超时的客户端。
    let client = if tpl.sse_enabled {
        crate::net::streaming_client()
    } else {
        crate::net::client()
    };
    let mut req = client.request(method.clone(), &url);
    for (k, v) in &tpl.request_headers {
        req = req.header(k, v.replace("{{api_key}}", &api_key));
    }
    if method == reqwest::Method::GET {
        // GET has no body — send rendered JSON as query params (best-effort)
        let params: serde_json::Value =
            serde_json::from_str(&body).unwrap_or_else(|_| serde_json::json!({}));
        req = req.query(&params);
    } else {
        req = req.body(body);
    }

    let resp = if tpl.sse_enabled {
        // 与主路径一致：SSE 客户端无总超时，等响应头也纳入首字节 180s，
        // 并且等待期间响应「停止」（T-063）。
        let Some(resp) = await_headers_cancellable(req.send(), request_id, app).await? else {
            return Ok(());
        };
        resp
    } else {
        // 非流式仍由 `client()` 的 120s 总超时兜底。
        req.send()
            .await
            .map_err(|e| format!("Request error: {e}"))?
    };
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        // 模板路径同形：错误体读取有硬上限并响应取消。
        let Some(text) = read_error_body(resp, request_id).await? else {
            return Ok(());
        };
        // 模板路径同形，同样先截断
        return Err(format!("API error {status}: {}", clip(&text, 2048)));
    }

    if tpl.sse_enabled {
        // SSE stream, parsed with the template's content path
        let path = split_json_path(&tpl.sse_content_path);
        let adapter = AdapterConfig::custom(
            tpl.sse_data_prefix.clone(),
            tpl.sse_done_marker.clone(),
            path,
        );
        // 与主路径共用同一套收尾契约：任何正常结束都只发一次 done。
        run_sse_stream(app, request_id, resp.bytes_stream(), |line| {
            handle_template_line(app, request_id, &adapter, line)
        })
        .await?;
    } else {
        // Non-SSE: parse the whole JSON body with response_content_path
        let text = resp.text().await.map_err(|e| format!("Read body: {e}"))?;
        let json: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("Parse body: {e}"))?;
        let path = split_json_path(&tpl.response_content_path);
        let content = extract_path(&json, &path)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        // 一次性响应模板：正文先作为普通 token 事件送出，done 只负责收尾。
        // 与 SSE 路径同一契约（done 恰好一次），也让正文走正常的 onToken 通道。
        if !content.is_empty() {
            app.emit_stream(serde_json::json!({
                "request_id": request_id, "done": false, "content": content, "reasoning": ""
            }));
        }
        emit_done_with_cache(app, request_id, 0, 0);
    }
    Ok(())
}

/// Replace template variables in the body template.
/// {{model}} / {{messages}} / {{temperature}} / {{`api_key`}} / {{`system_prompt`}} / {{`max_tokens`}}
fn render_template_body(
    template: &str,
    model: &str,
    messages: &[serde_json::Value],
    temperature: f64,
    api_key: &str,
    system_prompt: &str,
    max_tokens: u32,
) -> String {
    let msgs_json = serde_json::to_string(messages).unwrap_or_else(|_| "[]".to_string());
    template
        .replace(
            "{{model}}",
            &serde_json::to_string(model).unwrap_or_default(),
        )
        .replace("{{messages}}", &msgs_json)
        .replace("{{temperature}}", &temperature.to_string())
        .replace(
            "{{api_key}}",
            &serde_json::to_string(api_key).unwrap_or_default(),
        )
        .replace(
            "{{system_prompt}}",
            &serde_json::to_string(system_prompt).unwrap_or_default(),
        )
        .replace("{{knowledge_context}}", "\"\"")
        .replace("{{max_tokens}}", &max_tokens.to_string())
}

/// Convert "$.choices[0].delta.content" into ["choices","0","delta","content"].
fn split_json_path(path: &str) -> Vec<String> {
    let clean = path.trim_start_matches('$').trim_start_matches('.').trim();
    if clean.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for seg in clean.split('.') {
        if let Some(open) = seg.find('[') {
            let key = &seg[..open];
            let idx = seg[open..].trim_matches(|c| c == '[' || c == ']');
            if !key.is_empty() {
                out.push(key.to_string());
            }
            out.push(idx.to_string());
        } else if !seg.is_empty() {
            out.push(seg.to_string());
        }
    }
    out
}

/// Extract a value from JSON by a segmented path (["choices","0","delta","content"]).
fn extract_path<'a>(
    value: &'a serde_json::Value,
    path: &[String],
) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for key in path {
        match current {
            serde_json::Value::Object(map) => {
                current = map.get(key)?;
            }
            serde_json::Value::Array(arr) => {
                let idx: usize = key.parse().ok()?;
                current = arr.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(current)
}

/// Emit the stream-done event, including `DeepSeek` prompt-cache telemetry.
///
/// 这是全仓**唯一**的 done 出口：每次请求只允许走到这里一次。
fn emit_done_with_cache<S: ChatEventSink>(
    sink: &S,
    request_id: &str,
    cache_hit: u64,
    cache_miss: u64,
) {
    sink.emit_stream(serde_json::json!({
        "request_id": request_id, "done": true, "content": "", "reasoning": "",
        "cache_hit_tokens": cache_hit, "cache_miss_tokens": cache_miss
    }));
}

/// Extract (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`) from an SSE line.
fn extract_usage(line: &str) -> Option<(u64, u64)> {
    let data = strip_data_prefix("data: ", line).trim();
    if data.is_empty() || data.starts_with(':') {
        return None;
    }
    let json: serde_json::Value = serde_json::from_str(data).ok()?;
    let u = json.get("usage")?;
    let hit = u
        .get("prompt_cache_hit_tokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let miss = u
        .get("prompt_cache_miss_tokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if hit == 0 && miss == 0 {
        None
    } else {
        Some((hit, miss))
    }
}

/// Extract `reasoning_content` from an SSE data line (reasoning models).
/// Returns "" when the delta carries no reasoning text.
fn extract_reasoning(line: &str) -> String {
    let data = strip_data_prefix("data: ", line).trim();
    if data.is_empty() || data.starts_with(':') {
        return String::new();
    }
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
        if let Some(v) = json.pointer("/choices/0/delta/reasoning_content") {
            if let Some(s) = v.as_str() {
                return s.to_string();
            }
        }
    }
    String::new()
}

/// 发送前统一校验（模板路径与 `OpenAI` 路径共用，T-060）。
///
/// 必须放在 [`stream_chat_inner`] 入口、任何分支之前：模板分支此前在空消息
/// 守卫之前 return，空消息照样发网络，用户看到的是上游 400。
fn preflight(request: &ChatRequest) -> Result<(), String> {
    ensure_messages_non_empty(&request.messages)
}

/// 空消息守卫：拒绝「没有任何可发送内容」的请求。
///
/// 为什么要有它（2026-09-25 实测事故）：messages 为空时旧实现照发不误，
/// 换来 `DeepSeek` 的 `400 Empty input messages`，界面上只显示这句英文，
/// 用户看不出是自己这轮没内容可发。守在这里可以把失败拦在本地，
/// 并且给出一句能读懂的话，而不是替服务端转发它的报错。
///
/// 两种都算空，都要拒：
///   1. 数组本身为空；
///   2. 数组里每一条内容都是空白（只有空格/换行）——服务端同样拒。
fn ensure_messages_non_empty(messages: &[Message]) -> Result<(), String> {
    let has_content = messages.iter().any(|m| !m.content.trim().is_empty());
    if has_content {
        Ok(())
    } else {
        Err("没有可发送的内容：当前消息列表为空（或全部为空白）。请先输入内容再发送。".to_string())
    }
}

/// 截断过长文本（上游 4xx/5xx 常返回整页 HTML，动辄几百 KB），
/// 避免把整页塞进 UI 与 `chat_errors.log`。
/// 按字符边界截，不会切出半个 UTF-8 字符。
fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…（已截断，原文 {} 字节）", &s[..end], s.len())
}

/// Append a line to `chat_errors.log` (diagnostics for failures that don't
/// surface a useful message in the UI). Writes to both %APPDATA%\com.my-chat
/// and the directory next to the exe, so at least one copy always lands.
///
/// `pub(crate)`：路径守卫（main.rs）与加密层（db/encryption.rs）也要用它落盘——
/// 失败静默正是本轮要修的毛病。
pub(crate) fn log_chat_error(msg: &str) {
    use std::io::Write;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    // RS-23：消息里可能带用户可控内容（路径、URL、模型输出）。不转义换行的话
    // 一条消息就能伪造出多行日志（含伪造时间戳），污染排障结论。
    let msg = escape_log_line(msg);
    let line = format!("[{ts}] {msg}\n");

    let mut targets: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(base) = std::env::var("APPDATA") {
        targets.push(
            std::path::PathBuf::from(base)
                .join("com.my-chat")
                .join("chat_errors.log"),
        );
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            targets.push(dir.join("chat_errors.log"));
        }
    }
    for path in targets {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

/// 日志行转义：CR/LF 变成字面量 `\r` / `\n`，确保一条消息只占一行。
fn escape_log_line(msg: &str) -> String {
    msg.replace('\r', "\\r").replace('\n', "\\n")
}

#[cfg(test)]
mod empty_messages_guard_tests {
    use super::{ensure_messages_non_empty, Message};

    fn msg(role: &str, content: &str) -> Message {
        Message {
            role: role.to_string(),
            content: content.to_string(),
            timestamp: String::new(),
        }
    }

    #[test]
    fn rejects_empty_list() {
        let r = ensure_messages_non_empty(&[]);
        assert!(r.is_err(), "空数组必须被拒 —— 否则会发到服务端换回 400");
        assert!(
            r.unwrap_err().contains("没有可发送的内容"),
            "错误文案要能读懂,不能是英文 API 原文"
        );
    }

    #[test]
    fn rejects_whitespace_only_content() {
        let msgs = vec![msg("user", "   "), msg("system", "\n\t ")];
        assert!(
            ensure_messages_non_empty(&msgs).is_err(),
            "全部为空白内容同样等于没内容,服务端也会拒 —— 必须本地拦住"
        );
    }

    #[test]
    fn allows_single_non_empty_message() {
        let msgs = vec![msg("user", "你好")];
        assert!(ensure_messages_non_empty(&msgs).is_ok(), "正常消息必须放行");
    }

    #[test]
    fn allows_when_any_one_message_has_content() {
        // 空白与有内容混排:只要有一条有内容就该放行(前缀里有空 system 是允许的)
        let msgs = vec![msg("system", ""), msg("user", "hi")];
        assert!(
            ensure_messages_non_empty(&msgs).is_ok(),
            "只要有一条有内容就应放行,不能把合法的空 system 前缀也拦掉"
        );
    }
}

#[cfg(test)]
mod clip_tests {
    use super::clip;

    #[test]
    fn clip_truncates_on_char_boundary_and_keeps_short_text() {
        assert_eq!(clip("short", 2048), "short", "短文本应原样返回");

        let long = "错误".repeat(2000); // 6000 字节，远超前限
        let out = clip(&long, 2048);
        assert!(out.len() < long.len(), "超长文本应被截断");
        assert!(out.contains("已截断"), "应标注已截断");
        assert!(out.starts_with('错'), "按字符边界截，不应切碎中文");
    }
}

#[cfg(test)]
mod stream_timeout_selection_tests {
    use super::{await_headers_with_timeout, stream_chunk_timeout};
    use crate::net::{
        FIRST_BYTE_TIMEOUT, FIRST_BYTE_TIMEOUT_MESSAGE, STREAM_IDLE_TIMEOUT, STREAM_TIMEOUT_MESSAGE,
    };
    use std::time::Duration;

    #[test]
    fn first_chunk_gets_180s_and_first_byte_wording() {
        let (wait, msg) = stream_chunk_timeout(true);
        assert_eq!(wait, FIRST_BYTE_TIMEOUT, "首片必须等 180 秒");
        assert_eq!(msg, FIRST_BYTE_TIMEOUT_MESSAGE);
        assert!(msg.contains("首字节"), "首片超时文案要说明是首字节: {msg}");
        assert!(msg.contains("180"), "文案要带 180 秒: {msg}");
    }

    #[test]
    fn subsequent_chunks_get_60s_and_idle_wording() {
        let (wait, msg) = stream_chunk_timeout(false);
        assert_eq!(wait, STREAM_IDLE_TIMEOUT, "后续片必须等 60 秒");
        assert_eq!(msg, STREAM_TIMEOUT_MESSAGE);
        assert!(msg.contains("响应超时"), "后续超时文案应是响应超时: {msg}");
        assert!(msg.contains("60"), "文案要带 60 秒: {msg}");
    }

    #[tokio::test]
    async fn header_wait_times_out_with_first_byte_message() {
        // 服务端接受连接却永不返回响应头：等待必须有上限，不能永久挂起。
        let err = await_headers_with_timeout(
            Duration::from_millis(20),
            std::future::pending::<Result<(), std::io::Error>>(),
        )
        .await
        .expect_err("永久 pending 的响应头等待必须超时");
        assert_eq!(err, FIRST_BYTE_TIMEOUT_MESSAGE);
    }

    #[tokio::test]
    async fn header_wait_passes_value_and_maps_transport_error() {
        let ok = await_headers_with_timeout(Duration::from_secs(5), async {
            Ok::<u8, std::io::Error>(7)
        })
        .await
        .expect("立即完成的响应头等待不应超时");
        assert_eq!(ok, 7);

        let err = await_headers_with_timeout(Duration::from_secs(5), async {
            Err::<u8, std::io::Error>(std::io::Error::other("boom"))
        })
        .await
        .expect_err("传输错误应向上返回");
        assert!(err.contains("Request error: boom"), "错误文案: {err}");
    }
}

#[cfg(test)]
mod single_done_event_tests {
    use super::{handle_openai_line, handle_template_line, run_sse_stream, ChatEventSink};
    use crate::adapters::sse_parser::AdapterConfig;
    use std::cell::RefCell;

    /// 记录所有 `chat-stream` 事件的测试 sink。
    #[derive(Default)]
    struct RecordingSink {
        events: RefCell<Vec<serde_json::Value>>,
    }

    impl RecordingSink {
        fn done_count(&self) -> usize {
            self.events
                .borrow()
                .iter()
                .filter(|e| e["done"].as_bool() == Some(true))
                .count()
        }

        fn done_events(&self) -> Vec<serde_json::Value> {
            self.events
                .borrow()
                .iter()
                .filter(|e| e["done"].as_bool() == Some(true))
                .cloned()
                .collect()
        }

        fn token_contents(&self) -> Vec<String> {
            self.events
                .borrow()
                .iter()
                .filter(|e| e["done"].as_bool() == Some(false))
                .filter_map(|e| e["content"].as_str().map(str::to_string))
                .collect()
        }
    }

    impl ChatEventSink for RecordingSink {
        fn emit_stream(&self, payload: serde_json::Value) {
            self.events.borrow_mut().push(payload);
        }
    }

    fn chunks(parts: &[&str]) -> Vec<Result<Vec<u8>, String>> {
        parts.iter().map(|p| Ok(p.as_bytes().to_vec())).collect()
    }

    /// `[DONE]` 正常流：正文走 token 事件，done 恰好一次且带 cache 统计。
    /// 即使上游重复下发 `[DONE]`，也只允许一次 done。
    #[tokio::test]
    async fn done_marker_emits_exactly_one_done_with_cache() {
        let sink = RecordingSink::default();
        let adapter = AdapterConfig::openai_compatible();
        let stream = futures::stream::iter(chunks(&[
            "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n",
            "data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_cache_hit_tokens\":12,\"prompt_cache_miss_tokens\":3}}\n",
            "data: [DONE]\n",
            "data: [DONE]\n",
        ]));

        run_sse_stream(&sink, "t011-done-once", stream, |line| {
            handle_openai_line(&sink, "t011-done-once", &adapter, line)
        })
        .await
        .expect("收到 [DONE] 应正常结束");

        assert_eq!(sink.done_count(), 1, "done 必须恰好一次");
        assert_eq!(sink.token_contents(), vec!["你".to_string()]);
        let done = sink.done_events();
        assert_eq!(done[0]["cache_hit_tokens"], serde_json::json!(12));
        assert_eq!(done[0]["cache_miss_tokens"], serde_json::json!(3));
    }

    /// 连接直接关闭（没有 `[DONE]`）：同样只发一次 done。
    #[tokio::test]
    async fn connection_close_emits_exactly_one_done() {
        let sink = RecordingSink::default();
        let adapter = AdapterConfig::openai_compatible();
        let stream = futures::stream::iter(chunks(&[
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n",
        ]));

        run_sse_stream(&sink, "t011-close-once", stream, |line| {
            handle_openai_line(&sink, "t011-close-once", &adapter, line)
        })
        .await
        .expect("对端正常关闭应视为成功结束");

        assert_eq!(sink.done_count(), 1, "对端关闭也必须恰好一次 done");
        assert_eq!(sink.token_contents(), vec!["hi".to_string()]);
    }

    /// 流内错误（HTTP 200 + error 事件）：上抛 Err，不发 done ——
    /// 前端通过 invoke rejection 走 onError，同一失败不能报两次。
    #[tokio::test]
    async fn stream_error_event_emits_no_done() {
        let sink = RecordingSink::default();
        let adapter = AdapterConfig::openai_compatible();
        let stream = futures::stream::iter(chunks(&["data: {\"error\":{\"message\":\"boom\"}}\n"]));

        let err = run_sse_stream(&sink, "t011-error-event", stream, |line| {
            handle_openai_line(&sink, "t011-error-event", &adapter, line)
        })
        .await
        .expect_err("流内错误必须上抛");

        assert!(err.contains("boom"), "错误消息要可读: {err}");
        assert_eq!(
            sink.done_count(),
            0,
            "错误路径不得再发 done（onError 已报告）"
        );
    }

    /// 传输层读取失败：同样上抛 Err 且不发 done。
    #[tokio::test]
    async fn transport_error_emits_no_done() {
        let sink = RecordingSink::default();
        let adapter = AdapterConfig::openai_compatible();
        let stream =
            futures::stream::iter(vec![Err::<Vec<u8>, String>("connection reset".to_string())]);

        let err = run_sse_stream(&sink, "t011-transport-error", stream, |line| {
            handle_openai_line(&sink, "t011-transport-error", &adapter, line)
        })
        .await
        .expect_err("传输错误必须上抛");

        assert!(err.contains("connection reset"), "错误文案: {err}");
        assert_eq!(sink.done_count(), 0, "传输错误不得发 done");
    }

    /// 模板 SSE 路径同契约：结束标记只触发一次 done，正文走 token 事件。
    #[tokio::test]
    async fn template_done_marker_emits_exactly_one_done() {
        let sink = RecordingSink::default();
        let adapter = AdapterConfig::custom(
            "DATA|".to_string(),
            "END".to_string(),
            vec!["result".to_string(), "text".to_string()],
        );
        let stream = futures::stream::iter(chunks(&[
            "DATA|{\"result\":{\"text\":\"ok\"}}\n",
            "DATA|END\n",
        ]));

        run_sse_stream(&sink, "t011-template-done", stream, |line| {
            handle_template_line(&sink, "t011-template-done", &adapter, line)
        })
        .await
        .expect("模板结束标记应正常结束");

        assert_eq!(sink.done_count(), 1, "模板路径 done 必须恰好一次");
        assert_eq!(sink.token_contents(), vec!["ok".to_string()]);
    }

    /// T-058：正文里出现字面量 `[DONE]` 后，后续 delta 仍必须照常送出。
    #[tokio::test]
    async fn content_with_done_literal_keeps_streaming() {
        let sink = RecordingSink::default();
        let adapter = AdapterConfig::openai_compatible();
        let stream = futures::stream::iter(chunks(&[
            "data: {\"choices\":[{\"delta\":{\"content\":\"前置 [DONE] 文本\"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"后续内容\"}}]}\n",
            "data: [DONE]\n",
        ]));

        run_sse_stream(&sink, "t058-done-literal", stream, |line| {
            handle_openai_line(&sink, "t058-done-literal", &adapter, line)
        })
        .await
        .expect("正文含 [DONE] 不应提前结束");

        assert_eq!(
            sink.token_contents(),
            vec!["前置 [DONE] 文本".to_string(), "后续内容".to_string()],
            "含 [DONE] 的正文与之后的内容都必须保留"
        );
        assert_eq!(sink.done_count(), 1, "只在真正的 [DONE] 行结束");
    }
}

#[cfg(test)]
mod error_body_read_tests {
    use super::{
        await_cancellable, clear_cancelled, ERROR_BODY_CANCELLED_MESSAGE,
        ERROR_BODY_TIMEOUT_MESSAGE,
    };
    use std::time::Duration;

    #[tokio::test]
    async fn stalled_error_body_times_out_with_readable_message() {
        // 响应头之后 body 卡死：必须在有界时间内返回，不能永久挂起。
        let err = await_cancellable(
            std::future::pending::<String>(),
            "t010-timeout-not-cancelled",
            Duration::from_millis(20),
        )
        .await
        .expect_err("永久 pending 的错误体读取必须超时");
        assert_eq!(err, ERROR_BODY_TIMEOUT_MESSAGE);
        assert!(err.contains("30"), "文案要带 30 秒: {err}");
    }

    #[tokio::test]
    async fn cancel_flag_aborts_error_body_read() {
        let id = "t010-cancelled-body";
        clear_cancelled(id);
        super::cancel_chat(id.to_string()).expect("取消标记应写入");
        let err = await_cancellable(
            std::future::pending::<String>(),
            id,
            Duration::from_secs(30),
        )
        .await
        .expect_err("已取消的请求不应继续等错误体");
        clear_cancelled(id);
        assert_eq!(err, ERROR_BODY_CANCELLED_MESSAGE);
    }

    #[tokio::test]
    async fn completed_error_body_returns_text() {
        let text = await_cancellable(
            async { "upstream said no".to_string() },
            "t010-completed-body",
            Duration::from_secs(5),
        )
        .await
        .expect("立即完成的读取不应超时");
        assert_eq!(text, "upstream said no");
    }
}

#[cfg(test)]
mod log_escape_tests {
    use super::escape_log_line;

    #[test]
    fn escape_log_line_prevents_log_injection() {
        // 换行必须被转义，否则一条消息可以伪造出多行日志（含假时间戳）
        assert_eq!(escape_log_line("a\nb"), r"a\nb");
        assert_eq!(escape_log_line("a\r\nb"), r"a\r\nb");
        assert_eq!(escape_log_line("a\rb"), r"a\rb");
        assert_eq!(escape_log_line("clean"), "clean");
    }
}

/// T-067：失败日志里的 `api_url` / 错误正文都不得出现明文 query token。
#[cfg(test)]
mod failure_log_tests {
    use super::failure_log_message;

    #[test]
    fn failure_log_redacts_token_in_url_and_error_text() {
        let msg = failure_log_message(
            "https://gateway.example/v1?token=SECRET123",
            "deepseek-chat",
            "主模型",
            "error sending request for url (https://gateway.example/v1?token=SECRET123)",
        );
        assert!(
            !msg.contains("SECRET123"),
            "日志会落到 %APPDATA% 与 exe 同级目录，绝不能带明文 token: {msg}"
        );
        assert!(
            msg.contains("gateway.example"),
            "保留 host/path 便于排障: {msg}"
        );
        assert!(msg.contains("deepseek-chat"), "模型名要保留: {msg}");
    }
}

/// T-060：模板路径与 `OpenAI` 路径共用同一前置校验。
#[cfg(test)]
mod preflight_tests {
    use super::{preflight, ApiTemplateDto, ChatRequest, Message, ModelConfig};
    use std::collections::HashMap;

    fn empty_request_with_template() -> ChatRequest {
        ChatRequest {
            model_config: ModelConfig {
                name: "模板模型".to_string(),
                api_url: "https://gateway.example/v1".to_string(),
                api_key: String::new(),
                model: "m".to_string(),
                provider: String::new(),
            },
            messages: Vec::new(),
            temperature: None,
            max_tokens: None,
            top_p: None,
            top_k: None,
            repetition_penalty: None,
            frequency_penalty: None,
            presence_penalty: None,
            min_p: None,
            mirostat: None,
            mirostat_tau: None,
            mirostat_eta: None,
            dry_multiplier: None,
            dry_base: None,
            dry_allowed_length: None,
            dry_penalty_last_n: None,
            system_prompt: None,
            knowledge_context: None,
            request_id: "t060-preflight".to_string(),
            thinking_enabled: None,
            reasoning_effort: None,
            stopping_strings: None,
            template: Some(ApiTemplateDto {
                mode: String::new(),
                api_url: "https://gateway.example/template".to_string(),
                request_method: "POST".to_string(),
                request_headers: HashMap::new(),
                request_body_template: "{\"messages\":{{messages}}}".to_string(),
                sse_enabled: true,
                sse_data_prefix: "data: ".to_string(),
                sse_done_marker: "[DONE]".to_string(),
                sse_content_path: "$.choices[0].delta.content".to_string(),
                response_content_path: String::new(),
            }),
        }
    }

    #[test]
    fn template_with_empty_messages_is_rejected_locally() {
        let req = empty_request_with_template();
        let err = preflight(&req).expect_err("模板 + 空消息必须在本地拦下，不能发给上游换回 400");
        assert!(err.contains("没有可发送的内容"), "错误文案要能读懂: {err}");
    }

    #[test]
    fn template_with_content_passes() {
        let mut req = empty_request_with_template();
        req.messages.push(Message {
            role: "user".to_string(),
            content: "hi".to_string(),
            timestamp: String::new(),
        });
        assert!(preflight(&req).is_ok(), "有内容时模板路径必须放行");
    }
}

/// T-063：等待分片（无数据）期间点停止，必须在一个轮询周期内退出。
#[cfg(test)]
mod cancel_during_wait_tests {
    use super::{cancel_chat, clear_cancelled, run_sse_stream, ChatEventSink, LineEffect};
    use std::cell::RefCell;
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct CountSink {
        events: RefCell<Vec<serde_json::Value>>,
    }

    impl ChatEventSink for CountSink {
        fn emit_stream(&self, payload: serde_json::Value) {
            self.events.borrow_mut().push(payload);
        }
    }

    #[tokio::test]
    async fn cancel_aborts_pending_stream_wait_quickly() {
        let sink = CountSink::default();
        let id = "t063-cancel-pending";
        clear_cancelled(id);
        // 永不产出数据的流：旧实现会一直等到 180s 首字节超时。
        let stream = futures::stream::pending::<Result<Vec<u8>, String>>();
        let started = Instant::now();
        let canceller = {
            let id = id.to_string();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                cancel_chat(id).expect("写入取消标记");
            })
        };

        run_sse_stream(&sink, id, stream, |_line| Ok(LineEffect::default()))
            .await
            .expect("用户取消应按正常收尾处理（发 done 后 Ok）");
        canceller.await.expect("取消任务不应 panic");
        let elapsed = started.elapsed();
        clear_cancelled(id);

        assert!(
            elapsed < Duration::from_secs(2),
            "停止后必须在一个轮询周期内结束，实际等待 {elapsed:?}"
        );
        let done = sink
            .events
            .borrow()
            .iter()
            .filter(|e| e["done"].as_bool() == Some(true))
            .count();
        assert_eq!(done, 1, "取消路径仍应恰好发一次 done");
    }
}
