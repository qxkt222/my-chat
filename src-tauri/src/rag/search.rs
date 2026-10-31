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
    matches!(c as u32,
        0x3400..=0x4DBF     // CJK Extension A
        | 0x4E00..=0x9FFF   // CJK Unified Ideographs
        | 0xF900..=0xFAFF   // CJK Compatibility Ideographs
        | 0x20000..=0x2A6DF // CJK Extension B
        | 0x2A700..=0x2EBEF // CJK Extensions C–F
        | 0x30000..=0x323AF // CJK Extensions G–H
    )
}

/// CJK 连续段 → 相邻双字 bigram（不足两字时保留单字）。
fn push_cjk_bigrams(run: &mut Vec<char>, tokens: &mut Vec<String>) {
    let mut i = 0;
    while i < run.len() {
        if i + 1 < run.len() {
            tokens.push(run[i..i + 2].iter().collect());
            i += 2;
        } else {
            tokens.push(run[i].to_string());
            i += 1;
        }
    }
    run.clear();
}

/// 按 Unicode 脚本切段后分词：
/// - CJK 连续段 → bigram；
/// - 其他字母数字连续段（ASCII 及非 CJK 文字）→ 小写整段一个 token；
/// - 标点/空白只作分隔符，不产出 token。
///
/// 旧实现先按非字母数字切分、再丢弃「含 CJK 的整词」。由于
/// `'中'.is_alphanumeric()` 为真，`使用OpenAI接口` 会整串成为一个词并被丢弃，
/// 其中的 `openai` 永远不入索引。按脚本切段后，ASCII 段与 CJK 段各自产出
/// token，中英粘连不再互相吞掉。
fn tokenize(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut tokens: Vec<String> = Vec::new();
    let mut cjk_run: Vec<char> = Vec::new();
    let mut word = String::new();

    for c in lower.chars() {
        if is_cjk(c) {
            if !word.is_empty() {
                tokens.push(std::mem::take(&mut word));
            }
            cjk_run.push(c);
        } else if c.is_alphanumeric() {
            push_cjk_bigrams(&mut cjk_run, &mut tokens);
            word.push(c);
        } else {
            push_cjk_bigrams(&mut cjk_run, &mut tokens);
            if !word.is_empty() {
                tokens.push(std::mem::take(&mut word));
            }
        }
    }
    push_cjk_bigrams(&mut cjk_run, &mut tokens);
    if !word.is_empty() {
        tokens.push(word);
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
    if query_emb.is_empty() {
        return scored;
    }
    for chunk in chunks {
        let Some(ref emb_bytes) = chunk.embedding else {
            continue;
        };
        // 元数据声明的维度与查询不同：它属于另一个向量空间，连解码都不必，
        // 直接跳过（该块仍可走 BM25 关键词轨）。旧数据缺 metadata 时按
        // keyword/256 处理，仍会在下面用解码长度做二次校验。
        if chunk
            .effective_embedding_dim()
            .is_some_and(|dim| dim != query_emb.len())
        {
            continue;
        }
        let emb = crate::db::knowledge::decode_embedding(emb_bytes);
        // 旧数据没有维度元数据时，解码后的实际长度就是判据：
        // `cosine_similarity` 维度不一致返回 `None`，这里直接丢弃，
        // 不再以 0 分把整库按 sled 键序混进 RRF。
        let Some(score) = crate::db::knowledge::cosine_similarity(query_emb, &emb) else {
            continue;
        };
        if score > 0.0 {
            scored.push((chunk.id.clone(), score));
        }
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored
}

// ── Reciprocal Rank Fusion ────────────────────────────────

/// RRF 常数（与 `rrf_fuse` 内部一致）。
const RRF_K: f32 = 60.0;
/// RRF 单条命中的理论上限：BM25 轨第 1 + 向量轨第 1 = 2/(K+1)。
/// 用它把融合分映射到 0..=1，完美命中即 100%。
const RRF_PERFECT: f32 = 2.0 / (RRF_K + 1.0);

pub fn rrf_fuse(
    keyword: &[(String, f32)],
    vector: &[(String, f32)],
    top_k: usize,
) -> Vec<(String, f32)> {
    let mut scores: HashMap<String, f32> = HashMap::new();
    for (i, (id, _)) in keyword.iter().enumerate() {
        *scores.entry(id.clone()).or_insert(0.0) += 1.0 / (RRF_K + i as f32 + 1.0);
    }
    for (i, (id, _)) in vector.iter().enumerate() {
        *scores.entry(id.clone()).or_insert(0.0) += 1.0 / (RRF_K + i as f32 + 1.0);
    }
    let mut list: Vec<(String, f32)> = scores.into_iter().collect();
    list.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    list.truncate(top_k);
    list
}

// ── Score normalization (T-068) ───────────────────────────
//
// 三种模式的原始分互不同量纲：BM25 无上界、cosine ∈ [-1,1]、RRF ≈1/61。
// UI 若一律按 `score*100` 显示，hybrid 的完美命中只有 2%。这里统一映射到
// 0..=1 的「相对相关度」，并配合 `score_kind` 标注分数来源：
// - bm25：按本次结果最高分归一（最佳命中 = 1.0）；
// - vector：cosine 直接 clamp 到 0..=1；
// - hybrid：RRF 分除以理论上限 2/(K+1)（双轨第 1 = 1.0），其余按比例。

pub fn normalize_scores(mode: &str, results: &mut [(String, f32)]) {
    if results.is_empty() {
        return;
    }
    match mode {
        "bm25" => {
            let max = results.iter().map(|(_, score)| *score).fold(0.0, f32::max);
            if max > 0.0 {
                for (_, score) in results.iter_mut() {
                    *score = (*score / max).clamp(0.0, 1.0);
                }
            }
        }
        "vector" => {
            for (_, score) in results.iter_mut() {
                *score = score.clamp(0.0, 1.0);
            }
        }
        _ => {
            for (_, score) in results.iter_mut() {
                *score = (*score / RRF_PERFECT).clamp(0.0, 1.0);
            }
        }
    }
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

    /// T-013：中英粘连时 ASCII 段必须独立成词，不能因整串含 CJK 被丢弃。
    #[test]
    fn tokenize_keeps_ascii_inside_cjk_text() {
        let toks = tokenize("使用OpenAI接口");
        assert!(
            toks.contains(&"openai".to_string()),
            "『使用OpenAI接口』应产出 openai，实际 {toks:?}"
        );
        assert!(toks.contains(&"使用".to_string()), "实际 {toks:?}");
        assert!(toks.contains(&"接口".to_string()), "实际 {toks:?}");
        assert!(
            !toks.iter().any(|t| t.contains("使用openai")),
            "英文不应再粘进 CJK 词：{toks:?}"
        );
    }

    #[test]
    fn tokenize_handles_mixed_pure_cjk_and_pure_ascii() {
        // 中英混排：两侧 CJK 段各自 bigram，ASCII 段独立
        let mixed = tokenize("使用 GPT-4 模型");
        for expected in ["使用", "gpt", "4", "模型"] {
            assert!(
                mixed.contains(&expected.to_string()),
                "混排缺少 {expected}：{mixed:?}"
            );
        }

        // 纯 CJK：只有 bigram/单字，没有 ASCII token
        let cjk = tokenize("中文分词");
        assert_eq!(cjk, vec!["中文", "分词"]);

        // 纯 ASCII：小写整词，标点只作分隔
        let ascii = tokenize("Hello WORLD 42");
        assert_eq!(ascii, vec!["hello", "world", "42"]);
    }

    /// T-013 验收：含中英粘连词的文档能被 ASCII 查询命中。
    #[test]
    fn keyword_search_finds_ascii_inside_cjk_document() {
        let chunks = [
            chunk("c1", "使用OpenAI接口"),
            chunk("c2", "完全无关的另一段文本"),
        ];
        let r = keyword_search(&chunks, "openai", 5);
        assert_eq!(r.first().map(|x| x.0.as_str()), Some("c1"), "实际 {r:?}");
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

    /// T-014：维度不一致的分块不得进入向量轨（更不得以 0 分参与 RRF）。
    #[test]
    fn rank_vector_skips_chunks_with_mismatched_dimensions() {
        let query = vec![0.25f32; 256];
        let chunks = [
            // 旧数据：无元数据，256 维向量，应参与
            chunk_with_embedding("matches", "旧数据", vec![0.25f32; 256], None),
            // 新数据：显式记录 8 维，与 256 维查询不匹配，应跳过
            chunk_with_embedding("mismatch", "另一个空间", vec![0.5f32; 8], Some(8)),
        ];
        let ranked = rank_vector(&chunks, &query);
        assert_eq!(
            ranked.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["matches"],
            "维度不一致的块不得进入向量排名：{ranked:?}"
        );
        assert!(ranked.iter().all(|(_, score)| *score > 0.0));
    }

    /// T-014：旧数据缺 metadata 按 keyword/256 处理。
    #[test]
    fn legacy_chunk_without_metadata_is_treated_as_keyword_256() {
        let legacy = chunk_with_embedding("legacy", "旧索引", vec![0.1f32; 256], None);
        assert_eq!(legacy.effective_embedding_dim(), Some(256));
        assert_eq!(legacy.embedding_provider_name(), "keyword");

        let ranked = rank_vector(std::slice::from_ref(&legacy), &[0.1f32; 256]);
        assert_eq!(ranked.len(), 1, "旧 256 维数据仍应参与 256 维查询");
        assert_eq!(ranked[0].0, "legacy");
    }

    /// T-014：hybrid 融合时，维度不匹配的块不能借向量轨混进结果。
    #[test]
    fn rrf_never_receives_zero_score_mismatched_chunks() {
        let query = vec![0.3f32; 256];
        let chunks = [chunk_with_embedding(
            "wrong",
            "和查询毫无关系",
            vec![0.7f32; 8],
            Some(8),
        )];
        let vector = rank_vector(&chunks, &query);
        assert!(vector.is_empty(), "向量轨应为空：{vector:?}");
        let fused = rrf_fuse(&[], &vector, 3);
        assert!(fused.is_empty(), "RRF 不应出现噪声条目：{fused:?}");
    }

    /// T-068：hybrid 完美命中（双轨第一）归一化后必须是 100%，而不是 2%。
    #[test]
    fn normalize_scores_hybrid_perfect_hit_is_full_scale() {
        let mut list = vec![
            ("c1".to_string(), RRF_PERFECT),
            ("c2".to_string(), RRF_PERFECT / 2.0),
        ];
        normalize_scores("hybrid", &mut list);
        assert!((list[0].1 - 1.0).abs() < 1e-6, "实际 {}", list[0].1);
        assert!((list[1].1 - 0.5).abs() < 1e-6, "实际 {}", list[1].1);
    }

    /// T-068：BM25 无理论上界，按本次最高分归一 → 最佳命中 100%。
    #[test]
    fn normalize_scores_bm25_scales_to_top_hit() {
        let mut list = vec![("c1".to_string(), 12.5), ("c2".to_string(), 5.0)];
        normalize_scores("bm25", &mut list);
        assert!((list[0].1 - 1.0).abs() < 1e-6, "实际 {}", list[0].1);
        assert!((list[1].1 - 0.4).abs() < 1e-6, "实际 {}", list[1].1);
    }

    /// T-068：向量轨 cosine 本身可解释，只需防止越界。
    #[test]
    fn normalize_scores_vector_clamps_cosine() {
        let mut list = vec![("c1".to_string(), 1.0), ("c2".to_string(), 0.42)];
        normalize_scores("vector", &mut list);
        assert!((list[0].1 - 1.0).abs() < 1e-6);
        assert!((list[1].1 - 0.42).abs() < 1e-6);

        let mut negative = vec![("c1".to_string(), -0.3), ("c2".to_string(), 1.7)];
        normalize_scores("vector", &mut negative);
        assert!((negative[0].1 - 0.0).abs() < 1e-6);
        assert!((negative[1].1 - 1.0).abs() < 1e-6);
    }

    #[test]
    fn normalize_scores_handles_empty_results() {
        let mut empty: Vec<(String, f32)> = Vec::new();
        normalize_scores("bm25", &mut empty);
        assert!(empty.is_empty());
    }

    fn chunk(id: &str, content: &str) -> KnowledgeChunk {
        chunk_with_embedding(id, content, vec![], None)
    }

    fn chunk_with_embedding(
        id: &str,
        content: &str,
        embedding: Vec<f32>,
        embedding_dim: Option<usize>,
    ) -> KnowledgeChunk {
        KnowledgeChunk {
            id: id.into(),
            kb_id: "kb".into(),
            file_id: "f".into(),
            chunk_index: 0,
            content: content.into(),
            embedding: if embedding.is_empty() {
                None
            } else {
                Some(crate::db::knowledge::encode_embedding(&embedding))
            },
            embedding_provider: embedding_dim.map(|_| "keyword".to_string()),
            embedding_dim,
            metadata_json: "{}".into(),
        }
    }
}
