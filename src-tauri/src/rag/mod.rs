// rag/mod.rs — RAG engine: embedding + indexing + hybrid retrieval (BM25 + vector, RRF)

pub mod embedder;
pub mod search;

use crate::db::knowledge::{self, KnowledgeChunk};
use embedder::EmbeddingProvider;
use search::SearchResult;
use uuid::Uuid;

/// 先把整篇文档切块并**全部**算好 embedding，返回内存中的待写入分块。
///
/// 与写库分离是 RS-09 的关键：任何一块 embedding 失败（网络中断、限流、
/// key 失效）都在这一阶段返回 `Err`，此时旧索引还一个字节都没动。
async fn prepare_chunks(
    kb_id: &str,
    file_id: &str,
    content: &str,
    provider: &EmbeddingProvider,
    chunk_size: usize,
    overlap: usize,
) -> Result<Vec<KnowledgeChunk>, String> {
    // RS-06：入口再兜一次，保证任何调用方（命令层/内部）都不会把 0 或
    // overlap>=chunk_size 传进 chunk_text。
    let (chunk_size, overlap) = knowledge::clamp_chunk_params(chunk_size, overlap);
    let chunks = knowledge::chunk_text(content, chunk_size, overlap);
    let mut prepared = Vec::with_capacity(chunks.len());
    for (i, text) in chunks.into_iter().enumerate() {
        // Always store an embedding so the vector track works for any provider
        let emb = embedder::embed(&text, provider).await?;
        prepared.push(KnowledgeChunk {
            id: Uuid::new_v4().to_string(),
            kb_id: kb_id.to_string(),
            file_id: file_id.to_string(),
            chunk_index: i as i64,
            content: text,
            embedding: Some(knowledge::encode_embedding(&emb)),
            metadata_json: "{}".to_string(),
        });
    }
    Ok(prepared)
}

pub async fn index_document(
    kb_id: &str,
    file_id: &str,
    content: &str,
    provider: &EmbeddingProvider,
    chunk_size: usize,
    overlap: usize,
) -> Result<usize, String> {
    // RS-09 索引原子性：全部 embedding 成功后才删除旧分块。
    let prepared = prepare_chunks(kb_id, file_id, content, provider, chunk_size, overlap).await?;
    let count = prepared.len();

    knowledge::delete_chunks_by_file(kb_id, file_id)?;
    for chunk in &prepared {
        knowledge::save_chunk(chunk)?;
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

#[cfg(test)]
mod index_tests {
    use super::*;

    /// RS-09：embedding 阶段只产出内存分块，绝不碰数据库；返回后每一块都已带
    /// embedding。写库顺序（先 build 成功、再 delete、再 save）由
    /// `index_document` 的结构保证。
    #[tokio::test]
    async fn prepare_chunks_embeds_every_chunk_in_memory() {
        let provider = EmbeddingProvider::Keyword;
        let prepared = prepare_chunks("kb1", "file1", "abcdefghij", &provider, 4, 1)
            .await
            .expect("keyword embedding 不会失败");
        assert_eq!(prepared.len(), 3);
        for (i, c) in prepared.iter().enumerate() {
            assert_eq!(c.chunk_index, i as i64);
            assert_eq!(c.kb_id, "kb1");
            assert_eq!(c.file_id, "file1");
            let emb = c.embedding.as_ref().expect("每块都必须带 embedding");
            assert_eq!(
                knowledge::decode_embedding(emb).len(),
                256,
                "Keyword embedding 固定 256 维"
            );
        }
        assert_eq!(prepared[0].content, "abcd");
    }

    /// RS-06 + RS-09：非法分块参数在 prepare 阶段被 clamp，不会死循环。
    #[tokio::test]
    async fn prepare_chunks_survives_zero_chunk_size() {
        let provider = EmbeddingProvider::Keyword;
        let prepared = prepare_chunks("kb", "f", "abc", &provider, 0, 0)
            .await
            .expect("chunk_size=0 应被 clamp 到 1");
        assert_eq!(prepared.len(), 3);
        assert_eq!(prepared[2].content, "c");
    }
}
