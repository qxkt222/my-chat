// rag/embedder.rs — Text embedding providers (local + cloud)

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EmbeddingProvider {
    /// Simple keyword-based TF-IDF like embedding (no API required)
    Keyword,
    /// `OpenAI` text-embedding API
    OpenAI { api_key: String, model: String },
}

impl EmbeddingProvider {
    /// 稳定标识，写入 chunk 的 `embedding_provider` 元数据。
    /// 取值与 `commands/rag.rs` 的 `provider` 入参一致（keyword/openai）。
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::Keyword => "keyword",
            Self::OpenAI { .. } => "openai",
        }
    }
}

/// Generate a fixed-size embedding vector from text
pub async fn embed(text: &str, provider: &EmbeddingProvider) -> Result<Vec<f32>, String> {
    match provider {
        EmbeddingProvider::Keyword => Ok(keyword_embed(text)),
        EmbeddingProvider::OpenAI { api_key, model } => openai_embed(text, api_key, model).await,
    }
}

/// Simple keyword-based embedding using character n-gram hashing
/// Produces a 256-dimension vector from n-gram frequencies
/// (pub:供 memory 向量记忆复用)
pub fn keyword_embed(text: &str) -> Vec<f32> {
    let dim = 256usize;
    let mut vec = vec![0.0f32; dim];
    let lower = text.to_lowercase();

    // Character bigrams
    let chars: Vec<char> = lower.chars().collect();
    for window in chars.windows(2) {
        let s: String = window.iter().collect();
        let h = hash_str(&s) % dim;
        vec[h] += 1.0;
    }

    // Word unigrams
    for word in lower.split_whitespace() {
        let word = word.trim_matches(|c: char| !c.is_alphanumeric());
        if !word.is_empty() {
            let h = hash_str(word) % dim;
            vec[h] += 1.0;
        }
    }

    // Normalize
    let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for v in &mut vec {
            *v /= norm;
        }
    }

    vec
}

fn hash_str(s: &str) -> usize {
    let mut h: u64 = 5381;
    for b in s.bytes() {
        h = h.wrapping_mul(33).wrapping_add(b as u64);
    }
    h as usize
}

/// 嵌入请求最多尝试次数（含首次）。
const EMBED_MAX_ATTEMPTS: usize = 3;
/// 指数退避的首次等待，之后每次翻倍。
const EMBED_RETRY_BASE: Duration = Duration::from_millis(500);

/// 一次尝试的失败：`retryable` 决定是否值得指数退避重试。
struct RetryFailure {
    message: String,
    retryable: bool,
}

/// 429 与 5xx 视为暂时性错误；其余 4xx（key 失效、参数错误）重试无意义。
fn is_retryable_status(code: u16) -> bool {
    code == 429 || (500..=599).contains(&code)
}

/// 指数退避重试：`attempt()` 返回 `retryable` 失败时等待 `base`、`2*base`…
/// 后重试，耗尽次数返回最后一次错误。
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
    let mut last_error = String::from("嵌入请求重试耗尽");
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

/// 各模型的固定输出维度；未知模型只校验非空（不猜维度）。
fn expected_dimension(model: &str) -> Option<usize> {
    match model {
        "text-embedding-3-small" | "text-embedding-ada-002" => Some(1536),
        "text-embedding-3-large" => Some(3072),
        _ => None,
    }
}

/// 严格解析 `data[0].embedding`：
/// - 缺失/空数组 → 错误（旧实现会静默得到空向量）；
/// - 任一元素不是数值 → 错误（旧实现 `filter_map` 静默丢弃，得到短向量）；
/// - 已知模型维度不符 → 错误。
fn parse_embedding(
    json: &serde_json::Value,
    expected_dim: Option<usize>,
) -> Result<Vec<f32>, String> {
    let raw = json["data"][0]["embedding"]
        .as_array()
        .ok_or("No embedding in response")?;
    if raw.is_empty() {
        return Err("Embed API 返回空 embedding".to_string());
    }
    let mut embedding = Vec::with_capacity(raw.len());
    for value in raw {
        let number = value
            .as_f64()
            .ok_or_else(|| "Embed API 返回的 embedding 含非数值元素".to_string())?;
        embedding.push(number as f32);
    }
    if let Some(dim) = expected_dim {
        if embedding.len() != dim {
            return Err(format!(
                "Embed API 返回维度异常：期望 {dim}，实际 {}",
                embedding.len()
            ));
        }
    }
    Ok(embedding)
}

/// Call `OpenAI` embeddings API
async fn openai_embed(text: &str, api_key: &str, model: &str) -> Result<Vec<f32>, String> {
    let client = crate::net::client();
    let body = serde_json::json!({
        "model": model,
        "input": text,
    });
    let expected_dim = expected_dimension(model);
    retry_backoff(EMBED_MAX_ATTEMPTS, EMBED_RETRY_BASE, || {
        let client = &client;
        let body = &body;
        async move {
            let resp = client
                .post("https://api.openai.com/v1/embeddings")
                .header("Authorization", format!("Bearer {api_key}"))
                .header("Content-Type", "application/json")
                .json(body)
                .send()
                .await
                .map_err(|e| RetryFailure {
                    message: format!("Embed request: {e}"),
                    retryable: true,
                })?;
            let status = resp.status();
            let raw = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(RetryFailure {
                    message: format!(
                        "Embed API error {}: {}",
                        status.as_u16(),
                        crate::net::truncate_for_error(&raw)
                    ),
                    retryable: is_retryable_status(status.as_u16()),
                });
            }
            let json: serde_json::Value = serde_json::from_str(&raw).map_err(|e| RetryFailure {
                message: format!("Parse: {e}"),
                retryable: false,
            })?;
            parse_embedding(&json, expected_dim).map_err(|message| RetryFailure {
                message,
                retryable: false,
            })
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

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

    /// T-069 验收：429/5xx 后重试成功。
    #[tokio::test]
    async fn retry_backoff_retries_then_succeeds() {
        let attempts = AtomicUsize::new(0);
        let value = retry_backoff(3, Duration::from_millis(1), || {
            let n = attempts.fetch_add(1, Ordering::SeqCst);
            async move {
                if n < 2 {
                    Err(retryable("HTTP 429"))
                } else {
                    Ok(42)
                }
            }
        })
        .await
        .expect("第 3 次尝试应成功");
        assert_eq!(value, 42);
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    /// 4xx（非 429）不重试，避免拿失效 key 反复打服务端。
    #[tokio::test]
    async fn retry_backoff_does_not_retry_fatal_errors() {
        let attempts = AtomicUsize::new(0);
        let err = retry_backoff::<i32, _, _>(3, Duration::ZERO, || {
            attempts.fetch_add(1, Ordering::SeqCst);
            async { Err(fatal("HTTP 401")) }
        })
        .await
        .expect_err("401 必须直接失败");
        assert!(err.contains("401"), "{err}");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retry_backoff_stops_after_max_attempts() {
        let attempts = AtomicUsize::new(0);
        let err = retry_backoff::<i32, _, _>(3, Duration::ZERO, || {
            attempts.fetch_add(1, Ordering::SeqCst);
            async { Err(retryable("HTTP 503")) }
        })
        .await
        .expect_err("重试耗尽必须报错");
        assert!(err.contains("503"), "{err}");
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    /// T-069 验收：短向量 / 非数值元素必须报错，不能被静默截断。
    #[test]
    fn parse_embedding_rejects_empty_short_and_non_numeric_vectors() {
        let empty = serde_json::json!({ "data": [{ "embedding": [] }] });
        let err = parse_embedding(&empty, Some(1536)).expect_err("空向量必须报错");
        assert!(err.contains("空"), "{err}");

        let short = serde_json::json!({ "data": [{ "embedding": [0.1, 0.2] }] });
        let err = parse_embedding(&short, Some(1536)).expect_err("短向量必须报错");
        assert!(err.contains("维度"), "{err}");

        let non_numeric = serde_json::json!({ "data": [{ "embedding": [0.1, "oops", 0.3] }] });
        let err = parse_embedding(&non_numeric, None).expect_err("非数值元素必须报错");
        assert!(err.contains("非数值"), "{err}");

        let missing = serde_json::json!({ "data": [] });
        assert!(parse_embedding(&missing, None).is_err());
    }

    #[test]
    fn parse_embedding_accepts_matching_dimension() {
        let values: Vec<f64> = (0..1536).map(|i| f64::from(i) / 1536.0).collect();
        let json = serde_json::json!({ "data": [{ "embedding": values }] });
        let parsed = parse_embedding(&json, Some(1536)).expect("维度一致必须通过");
        assert_eq!(parsed.len(), 1536);
    }

    #[test]
    fn retryable_status_covers_429_and_5xx_only() {
        assert!(is_retryable_status(429));
        assert!(is_retryable_status(500));
        assert!(is_retryable_status(503));
        assert!(!is_retryable_status(400));
        assert!(!is_retryable_status(401));
        assert!(!is_retryable_status(404));
    }
}
