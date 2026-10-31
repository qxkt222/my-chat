// commands/translate.rs — 翻译引擎(专业翻译服务 / 本地 OpenAI 兼容模型)
//
// 用户明确要求:翻译用专业翻译服务而非对话 LLM。
// 引擎:
//  - google:免费免 key 网页接口(client=gtx,2026 仍可用),默认
//  - deepl:官方 API(免费档 500k 字符/月),需 key
//  - libre:LibreTranslate(开源,可自托管或公共实例),需 URL
//  - local:OpenAI 兼容本地端点(Ollama / LM Studio / llama.cpp server)
//
// T-015 修复:旧实现 `split("\n\n")` 不认 CRLF、单段超长不切、Google 走 GET
// 触发 414。这里统一 `chunk_text`：先归一化换行，再按 byte 上限在 char 边界
// 硬切；所有引擎共用同一分块器，各自使用自己的上限。

use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

/// 本地 `OpenAI` 兼容端点配置。字段与前端 `LocalTranslateConfig` 同形。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLlm {
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub temperature: f32,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub timeout_secs: u64,
}

/// 翻译请求参数(替代旧版 6 个位置参数)。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateOptions {
    pub engine: String,
    pub target_lang: String,
    #[serde(default)]
    pub deepl_key: String,
    #[serde(default)]
    pub libre_url: String,
    #[serde(default)]
    pub proxy_url: String,
    #[serde(default)]
    pub local: Option<LocalLlm>,
}

#[tauri::command]
pub async fn translate_text(text: String, opts: TranslateOptions) -> Result<String, String> {
    match opts.engine.as_str() {
        "deepl" => {
            deepl_translate(&text, &opts.target_lang, &opts.deepl_key, &opts.proxy_url).await
        }
        "libre" => {
            libre_translate(&text, &opts.target_lang, &opts.libre_url, &opts.proxy_url).await
        }
        "local" => local_translate(&text, &opts.target_lang, opts.local.as_ref()).await,
        _ => google_translate(&text, &opts.target_lang, &opts.proxy_url).await,
    }
}

/// 构造 HTTP 客户端;`proxy_url` 非空时走代理(国内访问 Google 必需,
/// 如 <http://127.0.0.1:7890>)。统一走 `net` 模块,继承 10s 建连 / 120s 总超时 /
/// 不跟随重定向的策略(RS-07)。
fn build_client(proxy_url: &str) -> Result<Client, String> {
    crate::net::client_with_proxy(proxy_url)
}

/// 长文本分块(单请求过长会失败):按段落聚合,每块 ≤ `CHUNK_MAX` 字节。
const CHUNK_MAX: usize = 4500;

/// 本地模型的单请求上限。本地推理没有公网 414 限制，给到 8k 字节
/// （对多字节文本仍是一个安全上界；按 byte 计，不超过 8k 字符）。
const LOCAL_CHUNK_MAX: usize = 8000;

/// 统一换行:CRLF / 孤立 CR 都归一到 LF，避免 `split("\n\n")` 漏掉 Windows 文本。
fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// 按 byte 上限在 char 边界硬切单段（不切断 UTF-8 字符）。
fn hard_split(paragraph: &str, max_bytes: usize) -> Vec<String> {
    if paragraph.len() <= max_bytes {
        return vec![paragraph.to_string()];
    }
    let mut pieces = Vec::new();
    let mut current = String::new();
    let mut current_len = 0_usize;
    for ch in paragraph.chars() {
        let width = ch.len_utf8();
        if current_len + width > max_bytes && !current.is_empty() {
            pieces.push(std::mem::take(&mut current));
            current_len = 0;
        }
        current.push(ch);
        current_len += width;
    }
    if !current.is_empty() {
        pieces.push(current);
    }
    pieces
}

/// 统一分块器:
/// 1. 归一化 CRLF/CR → LF；
/// 2. 按空行切段并聚合；
/// 3. 单段超过上限时在 char 边界硬切。
#[must_use]
fn chunk_text(text: &str, max_bytes: usize) -> Vec<String> {
    let max_bytes = max_bytes.max(16);
    let normalized = normalize_newlines(text);
    if normalized.trim().is_empty() {
        return Vec::new();
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut buf = String::new();
    for paragraph in normalized.split("\n\n") {
        if paragraph.is_empty() {
            continue;
        }
        for piece in hard_split(paragraph, max_bytes) {
            let separator = if buf.is_empty() { 0 } else { 2 };
            if !buf.is_empty() && buf.len() + separator + piece.len() > max_bytes {
                chunks.push(std::mem::take(&mut buf));
            }
            if !buf.is_empty() {
                buf.push_str("\n\n");
            }
            buf.push_str(&piece);
        }
    }
    if !buf.is_empty() {
        chunks.push(buf);
    }
    chunks
}

// ── 统一重试/退避（T-074）─────────────────────────────────
//
// Google 免费接口会对突发请求返回 429/5xx；旧实现直接失败。这里给所有
// 公网引擎的**单块请求**统一加指数退避：429/5xx/网络错误重试，其余 4xx
// （key 失效、参数错误、HTML 错误页）立即返回，避免无效重试。
const TRANSLATE_MAX_ATTEMPTS: usize = 3;
const TRANSLATE_RETRY_BASE: Duration = Duration::from_millis(400);

struct RetryFailure {
    message: String,
    retryable: bool,
}

fn is_retryable_status(code: u16) -> bool {
    code == 429 || (500..=599).contains(&code)
}

fn fail(message: impl Into<String>, retryable: bool) -> RetryFailure {
    RetryFailure {
        message: message.into(),
        retryable,
    }
}

async fn retry_backoff<T, F, Fut>(
    max_attempts: usize,
    base: Duration,
    mut attempt: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, RetryFailure>>,
{
    let max_attempts = max_attempts.max(1);
    let mut delay = base;
    let mut last_error = String::from("翻译请求重试耗尽");
    for i in 0..max_attempts {
        match attempt().await {
            Ok(value) => return Ok(value),
            Err(failure) => {
                last_error = failure.message;
                if !failure.retryable || i + 1 >= max_attempts {
                    break;
                }
                tokio::time::sleep(delay).await;
                delay = delay.saturating_mul(2);
            }
        }
    }
    Err(last_error)
}

/// 发送一次 POST 并读取文本体；429/5xx 标记为可重试。
async fn send_text(engine: &str, request: reqwest::RequestBuilder) -> Result<String, RetryFailure> {
    let resp = request
        .send()
        .await
        .map_err(|e| fail(format!("{engine} 请求失败: {e}"), true))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(fail(
            format!(
                "{engine} 错误 HTTP {}: {}",
                status.as_u16(),
                crate::net::truncate_for_error(&body)
            ),
            is_retryable_status(status.as_u16()),
        ));
    }
    Ok(body)
}

async fn google_translate(text: &str, target: &str, proxy_url: &str) -> Result<String, String> {
    let client = build_client(proxy_url)?;
    let chunks = chunk_text(text, CHUNK_MAX);
    if chunks.is_empty() {
        return Ok(String::new());
    }
    let mut out = String::new();
    for (i, q) in chunks.iter().enumerate() {
        // T-015：长文本用 GET query 会撞 414（URI 过长），改 POST 表单提交 body。
        // T-074：单块请求 429/5xx 指数退避重试。
        let body = retry_backoff(TRANSLATE_MAX_ATTEMPTS, TRANSLATE_RETRY_BASE, || {
            let request = client
                .post("https://translate.googleapis.com/translate_a/single")
                .form(&[
                    ("client", "gtx"),
                    ("sl", "auto"),
                    ("tl", target),
                    ("dt", "t"),
                    ("q", q.as_str()),
                ]);
            async move { send_text("Google 翻译", request).await }
        })
        .await?;
        let json: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("解析失败: {e}"))?;
        // translate_a 响应:[[["译文","原文",...],...],...] — 取 [0][n][0]
        if let Some(segs) = json
            .as_array()
            .and_then(|a| a.first())
            .and_then(|v| v.as_array())
        {
            for seg in segs {
                if let Some(s) = seg
                    .as_array()
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                {
                    out.push_str(s);
                }
            }
        }
        if i + 1 < chunks.len() {
            out.push_str("\n\n");
        }
    }
    Ok(out)
}

async fn deepl_translate(
    text: &str,
    target: &str,
    key: &str,
    proxy_url: &str,
) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("未配置 DeepL API Key(设置 → 翻译)".to_string());
    }
    let client = build_client(proxy_url)?;
    // 免费 key(以 :fx 结尾)走 api-free,否则走 api
    let base = if key.ends_with(":fx") {
        "https://api-free.deepl.com"
    } else {
        "https://api.deepl.com"
    };
    let chunks = chunk_text(text, CHUNK_MAX);
    if chunks.is_empty() {
        return Ok(String::new());
    }
    let mut out = String::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let body = retry_backoff(TRANSLATE_MAX_ATTEMPTS, TRANSLATE_RETRY_BASE, || {
            let request = client
                .post(format!("{base}/v2/translate"))
                .header("Authorization", format!("DeepL-Auth-Key {key}"))
                .json(&serde_json::json!({ "text": [chunk], "target_lang": target }));
            async move { send_text("DeepL", request).await }
        })
        .await?;
        let json: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("解析失败: {e}"))?;
        let piece = json["translations"][0]["text"]
            .as_str()
            .ok_or_else(|| "DeepL 响应无译文".to_string())?;
        if i > 0 {
            out.push_str("\n\n");
        }
        out.push_str(piece);
    }
    Ok(out)
}

async fn libre_translate(
    text: &str,
    target: &str,
    url: &str,
    proxy_url: &str,
) -> Result<String, String> {
    let base = url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(
            "未配置 LibreTranslate 服务地址(设置 → 翻译,如自托管 http://localhost:5000 或公共实例)"
                .to_string(),
        );
    }
    let client = build_client(proxy_url)?;
    let chunks = chunk_text(text, CHUNK_MAX);
    if chunks.is_empty() {
        return Ok(String::new());
    }
    let mut out = String::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let body = retry_backoff(TRANSLATE_MAX_ATTEMPTS, TRANSLATE_RETRY_BASE, || {
            let request = client
                .post(format!("{base}/translate"))
                .json(&serde_json::json!({
                    "q": chunk,
                    "source": "auto",
                    "target": target,
                    "format": "text"
                }));
            async move { send_text("LibreTranslate", request).await }
        })
        .await?;
        let json: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("解析失败: {e}"))?;
        if let Some(err) = json.get("error") {
            return Err(format!("LibreTranslate: {err}"));
        }
        let piece = json["translatedText"]
            .as_str()
            .ok_or_else(|| "LibreTranslate 响应无译文".to_string())?;
        if i > 0 {
            out.push_str("\n\n");
        }
        out.push_str(piece);
    }
    Ok(out)
}

/// 本地模型的 system prompt：用户留空时给一条明确的翻译指令。
fn local_system_prompt(llm: &LocalLlm, target: &str) -> String {
    let configured = llm.system_prompt.trim();
    if configured.is_empty() {
        format!(
            "You are a professional translator. Translate the user's text into {target}. \
             Output only the translation, without explanations or commentary."
        )
    } else {
        configured.to_string()
    }
}

fn local_request_body(llm: &LocalLlm, target: &str, chunk: &str) -> serde_json::Value {
    serde_json::json!({
        "model": llm.model.trim(),
        "messages": [
            { "role": "system", "content": local_system_prompt(llm, target) },
            { "role": "user", "content": chunk }
        ],
        "temperature": llm.temperature,
        "stream": false
    })
}

fn local_timeout(llm: &LocalLlm) -> Duration {
    let secs = if llm.timeout_secs == 0 {
        120
    } else {
        llm.timeout_secs.clamp(5, 600)
    };
    Duration::from_secs(secs)
}

async fn local_translate(
    text: &str,
    target: &str,
    local: Option<&LocalLlm>,
) -> Result<String, String> {
    let llm = local.ok_or_else(|| "未配置本地翻译模型(设置 → 翻译 → 本地)".to_string())?;
    if llm.base_url.trim().is_empty() {
        return Err("未配置本地模型服务地址(设置 → 翻译 → 本地)".to_string());
    }
    if llm.model.trim().is_empty() {
        return Err("未配置本地模型名称(设置 → 翻译 → 本地)".to_string());
    }
    let chunks = chunk_text(text, LOCAL_CHUNK_MAX);
    if chunks.is_empty() {
        return Ok(String::new());
    }
    let client = crate::net::long_client();
    let url = crate::net::openai_api_url(&llm.base_url, "chat/completions");
    let timeout = local_timeout(llm);
    let mut out = String::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let request = crate::net::with_bearer(
            client
                .post(&url)
                .timeout(timeout)
                .json(&local_request_body(llm, target, chunk)),
            &llm.api_key,
        );
        let resp = request
            .send()
            .await
            .map_err(|e| format!("本地翻译请求失败: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "本地翻译错误 HTTP {}: {}",
                status.as_u16(),
                crate::net::truncate_for_error(&body)
            ));
        }
        let json: serde_json::Value = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;
        let piece = json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| {
                format!(
                    "本地翻译响应无 content: {}",
                    crate::net::truncate_for_error(&json.to_string())
                )
            })?;
        if i > 0 {
            out.push_str("\n\n");
        }
        out.push_str(piece);
    }
    Ok(out)
}

/// 探测本地 `OpenAI` 兼容端点可用模型：`GET {base}/v1/models`。
#[tauri::command]
pub async fn probe_local_llm(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    if base_url.trim().is_empty() {
        return Err("未配置本地模型服务地址(设置 → 翻译 → 本地)".to_string());
    }
    let url = crate::net::openai_api_url(&base_url, "models");
    let client = crate::net::long_client();
    let request =
        crate::net::with_bearer(client.get(&url).timeout(Duration::from_secs(30)), &api_key);
    let resp = request
        .send()
        .await
        .map_err(|e| format!("连接本地模型服务失败: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "本地模型服务返回 HTTP {}: {}",
            status.as_u16(),
            crate::net::truncate_for_error(&body)
        ));
    }
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析模型列表失败: {e}"))?;
    let models: Vec<String> = json["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::{
        chunk_text, is_retryable_status, local_request_body, retry_backoff, LocalLlm, RetryFailure,
        TranslateOptions, CHUNK_MAX,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn retryable(message: &str) -> RetryFailure {
        RetryFailure {
            message: message.to_string(),
            retryable: true,
        }
    }

    fn fatal(message: &str) -> RetryFailure {
        RetryFailure {
            message: message.to_string(),
            retryable: false,
        }
    }

    /// T-074 验收：429 重试后成功。
    #[tokio::test]
    async fn retry_backoff_recovers_from_429() {
        let attempts = AtomicUsize::new(0);
        let value = retry_backoff(3, Duration::from_millis(1), || {
            let n = attempts.fetch_add(1, Ordering::SeqCst);
            async move {
                if n == 0 {
                    Err(retryable("Google 翻译错误 HTTP 429"))
                } else {
                    Ok("译文".to_string())
                }
            }
        })
        .await
        .expect("429 后重试应成功");
        assert_eq!(value, "译文");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn retry_backoff_does_not_retry_4xx_html_error() {
        let attempts = AtomicUsize::new(0);
        let err = retry_backoff::<String, _, _>(3, Duration::ZERO, || {
            attempts.fetch_add(1, Ordering::SeqCst);
            async { Err(fatal("LibreTranslate 错误 HTTP 400: <html>bad</html>")) }
        })
        .await
        .expect_err("4xx 必须直接返回");
        assert!(err.contains("400"), "{err}");
        assert!(err.contains("html"), "错误体应保留: {err}");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retry_backoff_gives_up_after_max_attempts() {
        let attempts = AtomicUsize::new(0);
        let err = retry_backoff::<String, _, _>(3, Duration::ZERO, || {
            attempts.fetch_add(1, Ordering::SeqCst);
            async { Err(retryable("HTTP 503")) }
        })
        .await
        .expect_err("重试耗尽必须报错");
        assert!(err.contains("503"), "{err}");
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn retryable_status_covers_429_and_5xx_only() {
        assert!(is_retryable_status(429));
        assert!(is_retryable_status(500));
        assert!(is_retryable_status(502));
        assert!(!is_retryable_status(400));
        assert!(!is_retryable_status(403));
        assert!(!is_retryable_status(404));
    }

    fn llm() -> LocalLlm {
        LocalLlm {
            base_url: "http://localhost:11434/v1".to_string(),
            api_key: String::new(),
            model: "qwen2.5:7b".to_string(),
            temperature: 0.2,
            system_prompt: String::new(),
            timeout_secs: 0,
        }
    }

    #[test]
    fn chunk_text_normalizes_crlf_and_keeps_paragraphs() {
        let chunks = chunk_text("第一段\r\n\r\n第二段\r\n\r\n第三段", CHUNK_MAX);
        assert_eq!(chunks, vec!["第一段\n\n第二段\n\n第三段".to_string()]);
        assert!(
            chunks.iter().all(|c| !c.contains('\r')),
            "CRLF 必须归一化，否则按 \\n\\n 切段会失效"
        );
    }

    #[test]
    fn chunk_text_hard_splits_oversized_single_paragraph() {
        let text = "a".repeat(5000);
        let chunks = chunk_text(&text, CHUNK_MAX);
        assert_eq!(chunks.len(), 2, "5000 字节单段在 4500 上限下必须切成 2 块");
        assert!(chunks.iter().all(|c| c.len() <= CHUNK_MAX));
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn chunk_text_hard_split_respects_utf8_boundaries() {
        // 每个汉字 3 字节；4500 不是 3 的倍数，硬切必须落在 char 边界
        let text = "中".repeat(2000); // 6000 字节
        let chunks = chunk_text(&text, CHUNK_MAX);
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().all(|c| c.len() <= CHUNK_MAX));
        assert_eq!(chunks.concat(), text, "拼接后必须与原文逐字一致");
    }

    #[test]
    fn chunk_text_empty_and_blank_input_yields_no_chunks() {
        assert!(chunk_text("", CHUNK_MAX).is_empty());
        assert!(chunk_text("  \r\n\r\n \n\n", CHUNK_MAX).is_empty());
    }

    #[test]
    fn local_request_body_uses_model_temperature_and_target_language() {
        let body = local_request_body(&llm(), "zh-CN", "hello");
        assert_eq!(body["model"], "qwen2.5:7b");
        assert_eq!(body["stream"], false);
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "hello");
        let system = body["messages"][0]["content"]
            .as_str()
            .expect("system prompt 应为字符串");
        assert!(system.contains("zh-CN"), "默认提示词必须包含目标语言");
    }

    #[test]
    fn local_request_body_keeps_custom_system_prompt() {
        let mut custom = llm();
        custom.system_prompt = "只输出译文".to_string();
        let body = local_request_body(&custom, "ja", "你好");
        assert_eq!(body["messages"][0]["content"], "只输出译文");
    }

    #[test]
    fn translate_options_deserializes_camel_case_with_local_block() {
        let json = serde_json::json!({
            "engine": "local",
            "targetLang": "zh-CN",
            "deeplKey": "",
            "libreUrl": "",
            "proxyUrl": "",
            "local": {
                "baseUrl": "http://127.0.0.1:1234/v1",
                "apiKey": "lm-studio",
                "model": "qwen2.5",
                "temperature": 0.1,
                "systemPrompt": "",
                "timeoutSecs": 90
            }
        });
        let opts: TranslateOptions =
            serde_json::from_value(json).expect("camelCase 契约必须可反序列化");
        assert_eq!(opts.engine, "local");
        assert_eq!(opts.target_lang, "zh-CN");
        let local = opts.local.expect("local 块必须保留");
        assert_eq!(local.base_url, "http://127.0.0.1:1234/v1");
        assert_eq!(local.api_key, "lm-studio");
        assert_eq!(local.timeout_secs, 90);
    }
}
