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
            // T-014：记录 provider/维度，检索时可据此拒绝跨向量空间的块。
            embedding_provider: Some(provider.name().to_string()),
            embedding_dim: Some(emb.len()),
            metadata_json: "{}".to_string(),
        });
    }
    Ok(prepared)
}

/// sled 键与 `db::knowledge::save_chunk` 保持一致（`kc:{kb}:{file}:{idx}`）。
fn chunk_key(chunk: &KnowledgeChunk) -> Vec<u8> {
    crate::db::key(
        "kc",
        &format!("{}:{}:{}", chunk.kb_id, chunk.file_id, chunk.chunk_index),
    )
}

/// 原子替换某文档的全部分块（T-070）。
///
/// 旧实现「先 delete 再逐块 save」：任何一次 save 失败都会丢掉旧索引、
/// 留下半套新索引。sled 单树事务把「删旧键 + 写新键」合成一次提交：
/// 任一写入失败整个事务回滚，旧块原样可检索；成功时旧块无残留。
/// `fail_after` 仅供测试注入中途失败（生产传 `None`）。
fn replace_chunks_in(
    tree: &sled::Tree,
    kb_id: &str,
    file_id: &str,
    prepared: &[KnowledgeChunk],
    fail_after: Option<usize>,
) -> Result<(), String> {
    let prefix = format!("kc:{kb_id}:{file_id}:");
    let old_keys = crate::db::try_scan_prefix(tree, &prefix)?
        .into_iter()
        .map(|(k, _)| k)
        .collect::<Vec<_>>();
    tree.transaction(|tx| {
        for key in &old_keys {
            tx.remove(key.clone())?;
        }
        for (i, chunk) in prepared.iter().enumerate() {
            if fail_after == Some(i) {
                return Err(sled::transaction::ConflictableTransactionError::Abort(
                    "injected chunk write failure".to_string(),
                ));
            }
            let value = serde_json::to_vec(chunk).map_err(|e| {
                sled::transaction::ConflictableTransactionError::Abort(format!("Ser: {e}"))
            })?;
            tx.insert(chunk_key(chunk), value)?;
        }
        Ok(())
    })
    .map_err(|e| format!("索引事务失败: {e}"))
}

pub async fn index_document(
    kb_id: &str,
    file_id: &str,
    content: &str,
    provider: &EmbeddingProvider,
    chunk_size: usize,
    overlap: usize,
) -> Result<usize, String> {
    // RS-09：全部 embedding 成功后才动数据库；T-070：换库本身也是原子的。
    let prepared = prepare_chunks(kb_id, file_id, content, provider, chunk_size, overlap).await?;
    let count = prepared.len();
    let tree = crate::db::tree("knowledge_chunks")?;
    replace_chunks_in(&tree, kb_id, file_id, &prepared, None)?;
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
    // T-068：各模式原始分不同量纲，统一归一化到 0..=1 再交给 UI，
    // 避免 hybrid 完美命中被显示成 2%。
    let mut ranked = match mode {
        "bm25" => search::keyword_search(chunks, query, top_k),
        "vector" => {
            let vec = search::rank_vector(chunks, query_emb);
            vec.into_iter().take(top_k).collect()
        }
        _ => {
            // Track 1: BM25 keyword search
            let kw = search::keyword_search(chunks, query, top_k * 2);
            // Track 2: vector similarity
            let vec = search::rank_vector(chunks, query_emb);
            // Fuse both with Reciprocal Rank Fusion
            search::rrf_fuse(&kw, &vec, top_k)
        }
    };
    search::normalize_scores(mode, &mut ranked);
    to_results(ranked)
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
            // T-014：索引时必须记录 provider/dim，供检索侧拒绝跨空间混排。
            assert_eq!(c.embedding_provider.as_deref(), Some("keyword"));
            assert_eq!(c.embedding_dim, Some(256));
        }
        assert_eq!(prepared[0].content, "abcd");
    }

    /// T-014 验收：维度不一致的块不能以 0 分进入 vector/hybrid 结果。
    #[test]
    fn hybrid_and_vector_modes_skip_dimension_mismatched_chunks() {
        let chunks = vec![embedding_chunk("wrong", "和查询毫无关系", 8, Some(8))];
        let query = vec![0.3f32; 256];
        let hybrid = search_with_embedding_sync(&chunks, "也无关", &query, 5, "hybrid");
        assert!(
            hybrid.is_empty(),
            "hybrid 不应返回维度不匹配的 0 分噪声：{:?}",
            hybrid
                .iter()
                .map(|r| (&r.chunk_id, r.score))
                .collect::<Vec<_>>()
        );
        let vector = search_with_embedding_sync(&chunks, "", &query, 5, "vector");
        assert!(vector.is_empty(), "vector 轨应跳过维度不匹配的块");
    }

    /// T-014：维度一致的块仍应通过向量轨命中（修复不能误伤正常检索）。
    #[test]
    fn hybrid_vector_track_still_uses_matching_dimension_chunks() {
        let chunks = vec![embedding_chunk("ok", "无关文本", 256, Some(256))];
        let query = vec![0.5f32; 256];
        let results = search_with_embedding_sync(&chunks, "找不到的词", &query, 5, "hybrid");
        assert_eq!(results.len(), 1, "实际 {results:?}");
        assert_eq!(results[0].chunk_id, "ok");
        assert!(results[0].score > 0.0);
    }

    fn embedding_chunk(
        id: &str,
        content: &str,
        dim: usize,
        recorded_dim: Option<usize>,
    ) -> KnowledgeChunk {
        KnowledgeChunk {
            id: id.into(),
            kb_id: "kb".into(),
            file_id: "f".into(),
            chunk_index: 0,
            content: content.into(),
            embedding: Some(knowledge::encode_embedding(&vec![0.5f32; dim])),
            embedding_provider: recorded_dim.map(|_| "keyword".to_string()),
            embedding_dim: recorded_dim,
            metadata_json: "{}".into(),
        }
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

    /// T-068 验收：hybrid 完美命中显示 100%，不再是 RRF 原始分 ≈2%。
    #[test]
    fn hybrid_perfect_hit_reports_full_relevance() {
        let chunks = vec![embedding_chunk("perfect", "苹果", 256, Some(256))];
        let query = vec![0.5f32; 256];
        let results = search_with_embedding_sync(&chunks, "苹果", &query, 5, "hybrid");
        assert_eq!(results.len(), 1);
        assert!(
            (results[0].score - 1.0).abs() < 1e-5,
            "完美命中应为 1.0，实际 {}",
            results[0].score
        );
    }

    /// T-068：单轨模式同样返回可解释的全量程分数。
    #[test]
    fn bm25_and_vector_modes_report_full_relevance_for_exact_match() {
        let chunks = vec![embedding_chunk("perfect", "苹果", 256, Some(256))];
        let query = vec![0.5f32; 256];
        for mode in ["bm25", "vector"] {
            let results = search_with_embedding_sync(&chunks, "苹果", &query, 5, mode);
            assert_eq!(results.len(), 1, "{mode}");
            assert!(
                (results[0].score - 1.0).abs() < 1e-5,
                "{mode} 完美命中应为 1.0，实际 {}",
                results[0].score
            );
        }
    }

    // ── T-070：索引写库原子性 ─────────────────────────────

    fn temp_chunk(content: &str, index: i64) -> KnowledgeChunk {
        KnowledgeChunk {
            id: format!("id-{content}"),
            kb_id: "kb".into(),
            file_id: "file".into(),
            chunk_index: index,
            content: content.into(),
            embedding: None,
            embedding_provider: None,
            embedding_dim: None,
            metadata_json: "{}".into(),
        }
    }

    fn stored_chunks(tree: &sled::Tree) -> Vec<KnowledgeChunk> {
        tree.scan_prefix(b"kc:kb:file:")
            .filter_map(std::result::Result::ok)
            .filter_map(|(_, value)| serde_json::from_slice(&value).ok())
            .collect()
    }

    /// T-070 验收：注入写失败时事务回滚，旧索引仍可检索。
    #[test]
    fn index_transaction_keeps_old_chunks_when_write_fails() {
        let db = sled::Config::new().temporary(true).open().expect("临时库");
        let tree = db.open_tree("knowledge_chunks").expect("tree");
        replace_chunks_in(&tree, "kb", "file", &[temp_chunk("old", 0)], None).expect("预置旧索引");

        let new_chunks = [temp_chunk("new-0", 0), temp_chunk("new-1", 1)];
        let err = replace_chunks_in(&tree, "kb", "file", &new_chunks, Some(1))
            .expect_err("注入失败必须返回错误");
        assert!(err.contains("injected"), "{err}");

        let remaining = stored_chunks(&tree);
        assert_eq!(remaining.len(), 1, "旧索引必须原样保留：{remaining:?}");
        assert_eq!(remaining[0].content, "old");
    }

    /// T-070 验收：重建成功后没有旧块残留。
    #[test]
    fn index_transaction_replaces_all_old_chunks() {
        let db = sled::Config::new().temporary(true).open().expect("临时库");
        let tree = db.open_tree("knowledge_chunks").expect("tree");
        replace_chunks_in(
            &tree,
            "kb",
            "file",
            &[temp_chunk("old-0", 0), temp_chunk("old-1", 1)],
            None,
        )
        .expect("预置旧索引");

        replace_chunks_in(&tree, "kb", "file", &[temp_chunk("new", 0)], None).expect("重建应成功");

        let remaining = stored_chunks(&tree);
        assert_eq!(remaining.len(), 1, "旧块必须清空：{remaining:?}");
        assert_eq!(remaining[0].content, "new");
    }
}
