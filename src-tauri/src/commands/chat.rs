// commands/chat.rs
// SSE streaming chat command

use crate::adapters::engine::build_api_url;
use crate::adapters::sse_parser::{parse_sse_chunk, AdapterConfig};
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
    match stream_chat_inner(&app, &request).await {
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

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        // 上游错误页可能很大，截断后再回传（完整原文不再进 UI 与日志）
        return Err(format!("API error {status}: {}", clip(&text, 2048)));
    }

    let adapter = AdapterConfig::openai_compatible();

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    // DeepSeek prompt-cache telemetry: last chunk carries usage; track it so the
    // frontend can display the cache hit rate.
    let mut cache_hit: u64 = 0;
    let mut cache_miss: u64 = 0;

    while let Some(chunk) = stream.next().await {
        // Honour cancellation for this specific request (user pressed Stop)
        if is_cancelled(request_id) {
            break;
        }
        let chunk = chunk.map_err(|e| format!("Stream error: {e}"))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            // Track cache usage (present in the final chunk)
            if let Some((hit, miss)) = extract_usage(&line) {
                cache_hit = hit;
                cache_miss = miss;
            }

            if let Some((content, done)) = parse_sse_chunk(&adapter, &line) {
                // Reasoning models (e.g. DeepSeek v4) stream their thinking in
                // delta.reasoning_content — surface it so the UI can show it.
                let reasoning = extract_reasoning(&line);
                let _ = app.emit(
                    "chat-stream",
                    serde_json::json!({
                        "request_id": request_id, "done": done,
                        "content": content, "reasoning": reasoning
                    }),
                );
                if done {
                    emit_done_with_cache(app, request_id, cache_hit, cache_miss);
                    return Ok(());
                }
            }
        }
    }

    emit_done_with_cache(app, request_id, cache_hit, cache_miss);

    Ok(())
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

    let client = reqwest::Client::new();
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

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Request error: {e}"))?;
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
        let mut buffer = String::new();
        while let Some(chunk) = stream.next().await {
            if is_cancelled(request_id) {
                break;
            }
            let chunk = chunk.map_err(|e| format!("Stream error: {e}"))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim().to_string();
                buffer = buffer[pos + 1..].to_string();
                if line.is_empty() || line.starts_with(':') {
                    continue;
                }
                if let Some((content, done)) = parse_sse_chunk(&adapter, &line) {
                    let _ = app.emit("chat-stream", serde_json::json!({
                        "request_id": request_id, "done": done, "content": content, "reasoning": ""
                    }));
                    if done {
                        return Ok(());
                    }
                }
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
