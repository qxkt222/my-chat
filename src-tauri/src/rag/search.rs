// rag/search.rs — Hybrid retrieval: BM25 keyword track + vector track, fused with RRF

use crate::db::knowledge::KnowledgeChunk;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::LazyLock;
use std::sync::Mutex;

/// Tokenize cache: `chunk_id` → (content hash, tokens). Docs only change through
/// `save_chunk`, so on a hash mismatch we recompute and overwrite — self-healing,
/// no invalidation coordination needed. Prevents re-tokenizing every chunk on
/// every RAG query (the dominant cost of a full-table BM25 scan).
/// `分词缓存:chunk_id` → (内容 hash, 已分词结果)
type TokenCacheValue = (u64, Vec<String>);
static TOKEN_CACHE: LazyLock<Mutex<HashMap<String, TokenCacheValue>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const TOKEN_CACHE_MAX: usize = 20_000;
/// BM25 参数(模块级常量,避免循环内 items-after-statements)
const BM25_K1: f32 = 1.2;
const BM25_B: f32 = 0.75;

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub chunk_id: String,
    pub content: String,
    pub score: f32,
    pub kb_name: String,
    pub file_name: String,
}

// ── Tokenization ──────────────────────────────────────────
// English words (lowercased) + CJK bigrams, so BM25 works for both
// Chinese and English knowledge bases.

fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c) || ('\u{3400}'..='\u{4dbf}').contains(&c)
}

fn tokenize(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut tokens: Vec<String> = Vec::new();

    // ASCII words
    for w in lower.split(|c: char| !c.is_alphanumeric()) {
        if !w.is_empty() && !w.chars().any(is_cjk) {
            tokens.push(w.to_string());
        }
    }

    // CJK bigrams (adjacent char pairs) — single char fallback
    let chars: Vec<char> = lower.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if is_cjk(chars[i]) {
            if i + 1 < chars.len() && is_cjk(chars[i + 1]) {
                tokens.push(format!("{}{}", chars[i], chars[i + 1]));
                i += 2;
                continue;
            }
            tokens.push(chars[i].to_string());
        }
        i += 1;
    }

    tokens
}

// ── BM25 keyword track ────────────────────────────────────
// Linear scan over chunks (fine for personal-scale knowledge bases).

fn content_hash(content: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut h);
    h.finish()
}

/// Tokens of a chunk, served from the per-chunk cache when the content hash
/// matches (docs only change through `save_chunk`).
fn cached_tokens(chunk: &KnowledgeChunk) -> Vec<String> {
    let key = chunk.id.clone();
    let h = content_hash(&chunk.content);
    {
        let cache = TOKEN_CACHE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((cached_h, toks)) = cache.get(&key) {
            if *cached_h == h {
                return toks.clone();
            }
        }
    }
    let toks = tokenize(&chunk.content);
    let mut cache = TOKEN_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if cache.len() >= TOKEN_CACHE_MAX {
        cache.clear(); // bounded memory; rebuilt lazily on demand
    }
    cache.insert(key, (h, toks.clone()));
    toks
}

pub fn keyword_search(chunks: &[KnowledgeChunk], query: &str, top_k: usize) -> Vec<(String, f32)> {
    let q_tokens = tokenize(query);
    if q_tokens.is_empty() || chunks.is_empty() {
        return Vec::new();
    }

    let n = chunks.len() as f32;
    let doc_tokens: Vec<Vec<String>> = chunks.iter().map(cached_tokens).collect();
    let avgdl = doc_tokens.iter().map(|t| t.len() as f32).sum::<f32>() / n;

    // Document frequency: in how many docs does each token appear
    let mut df: HashMap<String, usize> = HashMap::new();
    for toks in &doc_tokens {
        let mut seen: HashSet<String> = HashSet::new();
        for t in toks {
            seen.insert(t.clone());
        }
        for t in seen {
            *df.entry(t).or_insert(0) += 1;
        }
    }

    let mut scored: Vec<(String, f32)> = Vec::new();
    for (chunk, toks) in chunks.iter().zip(doc_tokens.iter()) {
        let dl = toks.len() as f32;
        if dl == 0.0 {
            continue;
        }
        let mut tf: HashMap<String, usize> = HashMap::new();
        for t in toks {
            *tf.entry(t.clone()).or_insert(0) += 1;
        }

        let mut score = 0.0f32;
        for q in &q_tokens {
            let dfv = *df.get(q).unwrap_or(&0) as f32;
            if dfv == 0.0 {
                continue;
            }
            let idf = ((n - dfv + 0.5) / (dfv + 0.5) + 1.0).ln();
            let tfv = *tf.get(q).unwrap_or(&0) as f32;
            if tfv == 0.0 {
                continue;
            }
            score += idf * (tfv * (BM25_K1 + 1.0))
                / (tfv + BM25_K1 * (1.0 - BM25_B + BM25_B * dl / avgdl));
        }

        if score > 0.0 {
            scored.push((chunk.id.clone(), score));
        }
    }

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_k);
    scored
}

// ── Vector track ──────────────────────────────────────────

pub fn rank_vector(chunks: &[KnowledgeChunk], query_emb: &[f32]) -> Vec<(String, f32)> {
    let mut scored: Vec<(String, f32)> = Vec::new();
    for chunk in chunks {
        if let Some(ref emb_bytes) = chunk.embedding {
            let emb = crate::db::knowledge::decode_embedding(emb_bytes);
            let score = crate::db::knowledge::cosine_similarity(query_emb, &emb);
            scored.push((chunk.id.clone(), score));
        }
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored
}

// ── Reciprocal Rank Fusion ────────────────────────────────

pub fn rrf_fuse(
    keyword: &[(String, f32)],
    vector: &[(String, f32)],
    top_k: usize,
) -> Vec<(String, f32)> {
    const K: f32 = 60.0;
    let mut scores: HashMap<String, f32> = HashMap::new();
    for (i, (id, _)) in keyword.iter().enumerate() {
        *scores.entry(id.clone()).or_insert(0.0) += 1.0 / (K + i as f32 + 1.0);
    }
    for (i, (id, _)) in vector.iter().enumerate() {
        *scores.entry(id.clone()).or_insert(0.0) += 1.0 / (K + i as f32 + 1.0);
    }
    let mut list: Vec<(String, f32)> = scores.into_iter().collect();
    list.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    list.truncate(top_k);
    list
}

// (build_context 已移除:结构化 SearchResult 直接返回前端,由前端拼上下文+来源卡)

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_splits_english_words_and_cjk_bigrams() {
        let toks = tokenize("Hello world 中文分词");
        assert!(toks.contains(&"hello".to_string()));
        assert!(toks.contains(&"world".to_string()));
        assert!(toks.contains(&"中文".to_string()));
        assert!(toks.contains(&"分词".to_string()));
    }

    #[test]
    fn content_hash_is_stable_and_sensitive() {
        assert_eq!(content_hash("同一内容"), content_hash("同一内容"));
        assert_ne!(content_hash("内容A"), content_hash("内容B"));
    }

    #[test]
    fn bm25_scores_relevant_chunk_higher() {
        let chunks = [
            chunk("c1", "苹果 苹果 苹果 苹果 苹果"),
            chunk("c2", "香蕉 橙子 梨子 西瓜 葡萄"),
        ];
        let r = keyword_search(&chunks, "苹果", 2);
        // clippy::manual_assert_eq —— 用 assert_eq! 失败时能打印两侧实际值
        assert_eq!(r[0].0, "c1");
    }

    fn chunk(id: &str, content: &str) -> KnowledgeChunk {
        KnowledgeChunk {
            id: id.into(),
            kb_id: "kb".into(),
            file_id: "f".into(),
            chunk_index: 0,
            content: content.into(),
            embedding: None,
            metadata_json: "{}".into(),
        }
    }
}
