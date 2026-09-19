// rag/mod.rs — RAG engine: embedding + indexing + hybrid retrieval (BM25 + vector, RRF)

pub mod embedder;
pub mod search;

use crate::db::knowledge::{self, KnowledgeChunk};
use embedder::EmbeddingProvider;
use search::SearchResult;
use uuid::Uuid;

pub async fn index_document(
    kb_id: &str,
    file_id: &str,
    content: &str,
    provider: &EmbeddingProvider,
    chunk_size: usize,
    overlap: usize,
) -> Result<usize, String> {
    knowledge::delete_chunks_by_file(kb_id, file_id)?;
    let chunks = knowledge::chunk_text(content, chunk_size, overlap);
    let count = chunks.len();
    for (i, text) in chunks.into_iter().enumerate() {
        // Always store an embedding so the vector track works for any provider
        let emb = embedder::embed(&text, provider).await?;
        let chunk = KnowledgeChunk {
            id: Uuid::new_v4().to_string(),
            kb_id: kb_id.to_string(),
            file_id: file_id.to_string(),
            chunk_index: i as i64,
            content: text,
            embedding: Some(knowledge::encode_embedding(&emb)),
            metadata_json: "{}".to_string(),
        };
        knowledge::save_chunk(&chunk)?;
    }
    Ok(count)
}

/// 同步搜索（在 `spawn_blocking` 中调用）：BM25 + 向量排名 + RRF 融合。
/// `query_emb` 由调用方预先算好（embed 是 async IO，不能在阻塞线程里等）。
/// `mode` 控制检索轨道（bm25/vector/hybrid）——双模式检索分流：找文档走单轨更快。
/// 返回按分数排序的 `SearchResult` 列表（command 层再拼上下文）。
pub fn search_with_embedding_sync(
    chunks: &[KnowledgeChunk],
    query: &str,
    query_emb: &[f32],
    top_k: usize,
    mode: &str,
) -> Vec<SearchResult> {
    if chunks.is_empty() {
        return Vec::new();
    }
    let by_id: std::collections::HashMap<String, &KnowledgeChunk> =
        chunks.iter().map(|c| (c.id.clone(), c)).collect();
    let to_results = |ids: Vec<(String, f32)>| {
        ids.into_iter()
            .filter_map(|(id, score)| {
                by_id.get(&id).map(|c| SearchResult {
                    chunk_id: c.id.clone(),
                    content: c.content.clone(),
                    score,
                    kb_name: c.kb_id.clone(),
                    file_name: c.file_id.clone(),
                })
            })
            .collect()
    };
    match mode {
        "bm25" => {
            let kw = search::keyword_search(chunks, query, top_k);
            to_results(kw)
        }
        "vector" => {
            let vec = search::rank_vector(chunks, query_emb);
            to_results(vec.into_iter().take(top_k).collect())
        }
        _ => {
            // Track 1: BM25 keyword search
            let kw = search::keyword_search(chunks, query, top_k * 2);
            // Track 2: vector similarity
            let vec = search::rank_vector(chunks, query_emb);
            // Fuse both with Reciprocal Rank Fusion
            let fused = search::rrf_fuse(&kw, &vec, top_k);
            // Map chunk ids back to full results
            to_results(fused)
        }
    }
}
