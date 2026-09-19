// rag/embedder.rs — Text embedding providers (local + cloud)

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EmbeddingProvider {
    /// Simple keyword-based TF-IDF like embedding (no API required)
    Keyword,
    /// `OpenAI` text-embedding API
    OpenAI { api_key: String, model: String },
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

/// Call `OpenAI` embeddings API
async fn openai_embed(text: &str, api_key: &str, model: &str) -> Result<Vec<f32>, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "input": text,
    });

    let resp = client
        .post("https://api.openai.com/v1/embeddings")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Embed request: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Embed API error: {}", resp.status()));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| format!("Parse: {e}"))?;
    let embedding: Vec<f32> = json["data"][0]["embedding"]
        .as_array()
        .ok_or("No embedding in response")?
        .iter()
        .filter_map(|v| v.as_f64().map(|f| f as f32))
        .collect();

    Ok(embedding)
}
