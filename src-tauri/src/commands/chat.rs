// commands/chat.rs
// SSE streaming chat command

use crate::adapters::engine::build_api_url;
use crate::adapters::sse_parser::{parse_sse_chunk, AdapterConfig};
use crate::net::{
    SseLineBuffer, FIRST_BYTE_TIMEOUT, FIRST_BYTE_TIMEOUT_MESSAGE, STREAM_IDLE_TIMEOUT,
    STREAM_TIMEOUT_MESSAGE,
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
            // Always record the failure (incl. the actual URL) so it can be
            // diagnosed from chat_errors.log when the UI shows an empty error.
            log_chat_error(&format!(
                "url={} model={} name={} err={}",
                build_api_url(&request.model_config.api_url),
                request.model_config.model,
                request.model_config.name,
                clip(&e, 2048)
            ));
            Err(e)
        }
    }
}

async fn stream_chat_inner(app: &AppHandle, request: &ChatRequest) -> Result<(), String> {
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

    // 空消息守卫：必须在任何网络请求之前。
    // 2026-09-25 实测事故 —— messages 为空时请求照样发了出去，DeepSeek 回
    // `400 Empty input messages`，界面上只有一句英文 API 报错，用户完全不知道
    // 是自己这轮没有内容可发。原样读取自 chat_errors.log 的真实记录。
    ensure_messages_non_empty(messages)?;

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
    // `send()` 会一直挂着。等待响应头也属于首字节阶段，同样受 180s 保护。
    let resp = await_headers(
        client
            .post(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .json(&body)
            .send(),
    )
    .await?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        // 上游错误页可能很大，截断后再回传（完整原文不再进 UI 与日志）
        return Err(format!("API error {status}: {}", clip(&text, 2048)));
    }

    let adapter = AdapterConfig::openai_compatible();

    let mut stream = resp.bytes_stream();
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
        let chunk = match tokio::time::timeout(wait, stream.next()).await {
            Ok(Some(chunk)) => {
                first_chunk = false;
                chunk.map_err(|e| format!("Stream error: {e}"))?
            }
            Ok(None) => break,
            Err(_) => return Err(timeout_msg.to_string()),
        };
        for line in lines.push(&chunk) {
            if handle_openai_line(
                app,
                request_id,
                &adapter,
                &line,
                &mut cache_hit,
                &mut cache_miss,
            ) {
                emit_done_with_cache(app, request_id, cache_hit, cache_miss);
                return Ok(());
            }
        }
    }

    // 流结束时 flush 末尾没有换行的残行（部分服务端最后一行不带 \n）。
    if let Some(line) = lines.flush() {
        if handle_openai_line(
            app,
            request_id,
            &adapter,
            &line,
            &mut cache_hit,
            &mut cache_miss,
        ) {
            emit_done_with_cache(app, request_id, cache_hit, cache_miss);
            return Ok(());
        }
    }

    emit_done_with_cache(app, request_id, cache_hit, cache_miss);

    Ok(())
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

/// 等待响应头（`send()`），超时计入首字节阶段。
///
/// `streaming_client()` 刻意没有总超时（长回答不能被一刀切断），但这也意味着
/// "连上了却不回响应头"会永久挂起。这里只包住等头阶段：进入 body 之后由
/// 逐片超时（首片 180s / 后续 60s）接管。
async fn await_headers<F, T, E>(fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    await_headers_with_timeout(FIRST_BYTE_TIMEOUT, fut).await
}

/// `await_headers` 的可注入超时版本：单测用毫秒级超时，避免真等 180s。
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

/// 处理一条 `OpenAI` 兼容 SSE 行；返回 `true` 表示收到 done。
fn handle_openai_line(
    app: &AppHandle,
    request_id: &str,
    adapter: &AdapterConfig,
    line: &str,
    cache_hit: &mut u64,
    cache_miss: &mut u64,
) -> bool {
    if line.is_empty() || line.starts_with(':') {
        return false;
    }

    // Track cache usage (present in the final chunk)
    if let Some((hit, miss)) = extract_usage(line) {
        *cache_hit = hit;
        *cache_miss = miss;
    }

    if let Some((content, done)) = parse_sse_chunk(adapter, line) {
        // Reasoning models (e.g. DeepSeek v4) stream their thinking in
        // delta.reasoning_content — surface it so the UI can show it.
        let reasoning = extract_reasoning(line);
        let _ = app.emit(
            "chat-stream",
            serde_json::json!({
                "request_id": request_id, "done": done,
                "content": content, "reasoning": reasoning
            }),
        );
        return done;
    }
    false
}

/// 处理一条模板 SSE 行；返回 `true` 表示收到 done。
fn handle_template_line(
    app: &AppHandle,
    request_id: &str,
    adapter: &AdapterConfig,
    line: &str,
) -> bool {
    if line.is_empty() || line.starts_with(':') {
        return false;
    }
    if let Some((content, done)) = parse_sse_chunk(adapter, line) {
        let _ = app.emit(
            "chat-stream",
            serde_json::json!({
                "request_id": request_id, "done": done, "content": content, "reasoning": ""
            }),
        );
        return done;
    }
    false
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
        // 与主路径一致：SSE 客户端无总超时，等响应头也纳入首字节 180s。
        await_headers(req.send()).await?
    } else {
        // 非流式仍由 `client()` 的 120s 总超时兜底。
        req.send()
            .await
            .map_err(|e| format!("Request error: {e}"))?
    };
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
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
        let mut stream = resp.bytes_stream();
        // RS-10：模板路径同样按完整行解码，避免中文跨分片被切碎。
        let mut lines = SseLineBuffer::new();
        // 与主路径一致：首片 180s，后续每片 60s。
        let mut first_chunk = true;
        loop {
            if is_cancelled(request_id) {
                break;
            }
            let (wait, timeout_msg) = stream_chunk_timeout(first_chunk);
            let chunk = match tokio::time::timeout(wait, stream.next()).await {
                Ok(Some(chunk)) => {
                    first_chunk = false;
                    chunk.map_err(|e| format!("Stream error: {e}"))?
                }
                Ok(None) => break,
                Err(_) => return Err(timeout_msg.to_string()),
            };
            for line in lines.push(&chunk) {
                if handle_template_line(app, request_id, &adapter, &line) {
                    return Ok(());
                }
            }
        }
        // 流结束：flush 末尾无换行的残行
        if let Some(line) = lines.flush() {
            if handle_template_line(app, request_id, &adapter, &line) {
                return Ok(());
            }
        }
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
        let _ = app.emit(
            "chat-stream",
            serde_json::json!({
                "request_id": request_id, "done": true, "content": content, "reasoning": ""
            }),
        );
        return Ok(());
    }

    let _ = app.emit(
        "chat-stream",
        serde_json::json!({
            "request_id": request_id, "done": true, "content": "", "reasoning": ""
        }),
    );
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
fn emit_done_with_cache(app: &tauri::AppHandle, request_id: &str, cache_hit: u64, cache_miss: u64) {
    let _ = app.emit(
        "chat-stream",
        serde_json::json!({
            "request_id": request_id, "done": true, "content": "", "reasoning": "",
            "cache_hit_tokens": cache_hit, "cache_miss_tokens": cache_miss
        }),
    );
}

/// Extract (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`) from an SSE line.
fn extract_usage(line: &str) -> Option<(u64, u64)> {
    let data = line.strip_prefix("data: ").unwrap_or(line).trim();
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
    let data = line.strip_prefix("data: ").unwrap_or(line).trim();
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
