// db/knowledge.rs — Knowledge bases, files, chunks & embeddings
//
// NOTE: create_kb/list_kbs/save_file/list_files/delete_file are the KB/file
// management half of this subsystem. The UI drives them indirectly through
// rag_index_document / delete_kb / the file-based KnowledgeManager; they are
// kept as the complete storage API for future expansion.

use super::{key, log_corrupt_record, tree, try_scan_prefix};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KnowledgeBase {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KnowledgeFile {
    pub id: String,
    pub kb_id: String,
    pub filename: String,
    pub content: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KnowledgeChunk {
    pub id: String,
    pub kb_id: String,
    pub file_id: String,
    pub chunk_index: i64,
    pub content: String,
    pub embedding: Option<Vec<u8>>,
    /// 生成该分块 embedding 的 provider（`keyword` / `openai`）。
    /// 旧数据没有该字段 → `None` → 按 `keyword` 处理，不需要迁移。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_provider: Option<String>,
    /// 该分块 embedding 的维度。旧数据没有该字段 → `None` →
    /// 由 `effective_embedding_dim` 按 keyword 缺省维度 256 处理。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_dim: Option<usize>,
    pub metadata_json: String,
}

/// keyword embedder 的输出维度，也是旧数据缺 metadata 时的缺省维度。
pub const KEYWORD_EMBEDDING_DIM: usize = 256;

impl KnowledgeChunk {
    /// 生成该分块 embedding 的 provider；旧数据缺 metadata 时视为 `keyword`。
    /// 当前检索只按维度过滤，provider 名保留给诊断/测试读取。
    #[allow(dead_code)]
    #[must_use]
    pub fn embedding_provider_name(&self) -> &str {
        self.embedding_provider.as_deref().unwrap_or("keyword")
    }

    /// 该分块 embedding 的有效维度。
    ///
    /// 新数据直接读写入时记录的 `embedding_dim`；旧数据缺字段时按
    /// keyword 缺省维度 256 处理（无需迁移）。没有 embedding 时为 `None`。
    /// 旧数据若实际存了别的维度（例如修复前 `OpenAI` 重建的 1536 维），
    /// `rank_vector` 还会用解码后的真实长度再校验一次，不会误入向量轨。
    #[must_use]
    pub fn effective_embedding_dim(&self) -> Option<usize> {
        self.embedding
            .as_ref()
            .map(|_| self.embedding_dim.unwrap_or(KEYWORD_EMBEDDING_DIM))
    }
}

// ── KBs ─────────────────────────────────────────────────

#[allow(dead_code)]
pub fn create_kb(kb: &KnowledgeBase) -> Result<(), String> {
    tree("knowledge_bases")?
        .insert(
            key("kb", &kb.id),
            serde_json::to_vec(kb).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Save: {e}"))?;
    Ok(())
}

#[allow(dead_code)]
pub fn list_kbs() -> Result<Vec<KnowledgeBase>, String> {
    let mut list = Vec::new();
    // T-037：扫描 IO 错误向上传播；坏记录记日志后跳过
    for (k, v) in try_scan_prefix(&tree("knowledge_bases")?, "kb:")? {
        match serde_json::from_slice::<KnowledgeBase>(&v) {
            Ok(kb) => list.push(kb),
            Err(e) => log_corrupt_record("list_kbs", &k, &e.to_string()),
        }
    }
    Ok(list)
}

#[allow(dead_code)]
pub fn delete_kb(id: &str) -> Result<(), String> {
    let tkb = tree("knowledge_bases")?;
    tkb.remove(key("kb", id)).ok();
    let tf = tree("knowledge_files")?;
    // T-037：先扫描再删，扫描失败时不留下「删了一半」的知识库
    let file_keys: Vec<Vec<u8>> = try_scan_prefix(&tf, &format!("kf:{id}:"))?
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    let tc = tree("knowledge_chunks")?;
    let chunk_keys: Vec<Vec<u8>> = try_scan_prefix(&tc, &format!("kc:{id}:"))?
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    for k in file_keys {
        tf.remove(k).ok();
    }
    for k in chunk_keys {
        tc.remove(k).ok();
    }
    Ok(())
}

// ── Files ────────────────────────────────────────────────

#[allow(dead_code)]
pub fn save_file(f: &KnowledgeFile) -> Result<(), String> {
    tree("knowledge_files")?
        .insert(
            key("kf", &format!("{}:{}", f.kb_id, f.filename)),
            serde_json::to_vec(f).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Save: {e}"))?;
    Ok(())
}

#[allow(dead_code)]
pub fn list_files(kb_id: &str) -> Result<Vec<KnowledgeFile>, String> {
    let mut list = Vec::new();
    for (k, v) in try_scan_prefix(&tree("knowledge_files")?, &format!("kf:{kb_id}:"))? {
        match serde_json::from_slice::<KnowledgeFile>(&v) {
            Ok(f) => list.push(f),
            Err(e) => log_corrupt_record("list_files", &k, &e.to_string()),
        }
    }
    Ok(list)
}

#[allow(dead_code)]
pub fn delete_file(kb_id: &str, filename: &str) -> Result<(), String> {
    let tf = tree("knowledge_files")?;
    tf.remove(key("kf", &format!("{kb_id}:{filename}"))).ok();
    let tc = tree("knowledge_chunks")?;
    // T-037：先扫描（失败即返回），再逐条删
    let keys: Vec<Vec<u8>> = try_scan_prefix(&tc, &format!("kc:{kb_id}:{filename}:"))?
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    for k in keys {
        tc.remove(k).ok();
    }
    Ok(())
}

/// 删除一个文档在 sled 中的全部索引数据，返回删除的 chunk 数（T-016）。
///
/// 键布局有两代：
/// - 新：`kc:{kb_id}:{file_id}:{idx}` —— 直接按 `file_id` 前缀删；
/// - 旧：键里放的是 filename，而 chunk 载荷的 `file_id` 可能是生成 id ——
///   先按 `file_id` 删，再通过 `knowledge_files` 记录解析出 filename 补删。
///
/// 最后再扫一遍本库残留 chunk，按载荷 `file_id` 兜底。
///
/// 同时删除该文档的 `knowledge_files` 记录，避免「文件记录还在、块已没了」
/// 或反过来的半删除状态。
pub fn delete_document(kb_id: &str, file_id: &str) -> Result<usize, String> {
    delete_document_in(
        &tree("knowledge_chunks")?,
        &tree("knowledge_files")?,
        kb_id,
        file_id,
    )
}

fn delete_document_in(
    tc: &sled::Tree,
    tf: &sled::Tree,
    kb_id: &str,
    file_id: &str,
) -> Result<usize, String> {
    let mut prefixes = vec![format!("kc:{kb_id}:{file_id}:")];
    // 旧数据：file_id 是生成 id，键里用的是 filename，查文件记录补上 filename 前缀。
    // T-037：扫描错误向上传播；坏文件记录记日志（不静默跳过）
    for (k, v) in try_scan_prefix(tf, &format!("kf:{kb_id}:"))? {
        let Ok(f) = serde_json::from_slice::<KnowledgeFile>(&v) else {
            log_corrupt_record("delete_document/files", &k, "JSON 解析失败");
            continue;
        };
        if f.id == file_id || f.filename == file_id {
            let legacy = format!("kc:{kb_id}:{}:", f.filename);
            if !prefixes.contains(&legacy) {
                prefixes.push(legacy);
            }
            tf.remove(k).map_err(|e| format!("Del file: {e}"))?;
        }
    }

    let mut deleted = 0usize;
    for prefix in &prefixes {
        for (k, _) in try_scan_prefix(tc, prefix)? {
            tc.remove(k).map_err(|e| format!("Del chunk: {e}"))?;
            deleted += 1;
        }
    }
    // 兜底：键布局再不同，只要 chunk 载荷里的 file_id 匹配也删掉。
    for (k, v) in try_scan_prefix(tc, &format!("kc:{kb_id}:"))? {
        let Ok(c) = serde_json::from_slice::<KnowledgeChunk>(&v) else {
            log_corrupt_record("delete_document/chunks", &k, "JSON 解析失败");
            continue;
        };
        if c.file_id == file_id {
            tc.remove(k).map_err(|e| format!("Del chunk: {e}"))?;
            deleted += 1;
        }
    }
    Ok(deleted)
}

// ── Chunks ───────────────────────────────────────────────

// T-070 起索引改用 sled 事务直写（rag/mod.rs），这两个逐条 API 保留给
// 外部调用/后续维护；当前 bin target 无调用点，显式豁免 dead_code。
#[allow(dead_code)]
pub fn save_chunk(c: &KnowledgeChunk) -> Result<(), String> {
    tree("knowledge_chunks")?
        .insert(
            key(
                "kc",
                &format!("{}:{}:{}", c.kb_id, c.file_id, c.chunk_index),
            ),
            serde_json::to_vec(c).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Save: {e}"))?;
    Ok(())
}

pub fn list_chunks(kb_id: &str) -> Result<Vec<KnowledgeChunk>, String> {
    let mut list = Vec::new();
    // T-037：扫描 IO 错误向上传播（半份 chunk 列表会让检索结果失真）
    for (k, v) in try_scan_prefix(&tree("knowledge_chunks")?, &format!("kc:{kb_id}:"))? {
        match serde_json::from_slice::<KnowledgeChunk>(&v) {
            Ok(c) => list.push(c),
            Err(e) => log_corrupt_record("list_chunks", &k, &e.to_string()),
        }
    }
    list.sort_by_key(|c| c.chunk_index);
    Ok(list)
}

pub fn list_all_chunks_with_embeddings() -> Result<Vec<KnowledgeChunk>, String> {
    let mut list = Vec::new();
    for (k, v) in try_scan_prefix(&tree("knowledge_chunks")?, "kc:")? {
        match serde_json::from_slice::<KnowledgeChunk>(&v) {
            Ok(c) if c.embedding.is_some() => list.push(c),
            Ok(_) => {}
            Err(e) => log_corrupt_record("list_all_chunks", &k, &e.to_string()),
        }
    }
    Ok(list)
}

/// Remove all chunks of one file. Chunk keys are `kc:{kb_id}:{file_id}:{idx`},
/// so this is a direct prefix delete — no full-table scan (the old version
/// scanned every chunk and did a `contains()` substring match).
#[allow(dead_code)] // T-070：索引改事务内按前缀删，保留 API 供外部/测试使用。
pub fn delete_chunks_by_file(kb_id: &str, file_id: &str) -> Result<(), String> {
    let t = tree("knowledge_chunks")?;
    let prefix = format!("kc:{kb_id}:{file_id}:");
    // T-037：先扫描再删，扫描失败时一条都不删
    let keys: Vec<Vec<u8>> = try_scan_prefix(&t, &prefix)?
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    for k in keys {
        t.remove(k).map_err(|e| format!("Del: {e}"))?;
    }
    Ok(())
}

// ── Chunking ─────────────────────────────────────────────

/// 单个分块的字数上限。`20000` 字已远超 embedding 模型输入窗口的常见上限，
/// 再大只会把整篇文档塞进一次请求；封顶是为了给前端/外部调用一个可预期边界。
pub const MAX_CHUNK_SIZE: usize = 20_000;

/// 把外部传入的分块参数收敛到安全区间（RS-06）。
///
/// 旧实现的 `start = end.saturating_sub(overlap)` 在 `chunk_size == 0` 或
/// `overlap >= chunk_size` 时算出 `next_start <= start`，循环永不前进：
/// 每轮都向 `Vec` 压一块，直到内存耗尽。这里保证：
/// - `chunk_size ∈ [1, MAX_CHUNK_SIZE]`（0 抬到 1）
/// - `overlap ≤ chunk_size - 1`（`usize` 无负值，`max(0)` 天然成立）
///
/// 于是步长 `chunk_size - overlap ≥ 1`，循环必然在有限步内结束。
#[must_use]
pub fn clamp_chunk_params(chunk_size: usize, overlap: usize) -> (usize, usize) {
    let chunk_size = chunk_size.clamp(1, MAX_CHUNK_SIZE);
    let overlap = overlap.min(chunk_size - 1);
    (chunk_size, overlap)
}

pub fn chunk_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    let (chunk_size, overlap) = clamp_chunk_params(chunk_size, overlap);
    let text = text.trim();
    if text.is_empty() {
        return vec![];
    }
    if text.len() <= chunk_size {
        return vec![text.to_string()];
    }
    let chars: Vec<char> = text.chars().collect();
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + chunk_size).min(chars.len());
        chunks.push(chars[start..end].iter().collect());
        if end >= chars.len() {
            break;
        }
        let next_start = end.saturating_sub(overlap);
        // 兜底：即便将来的 clamp 逻辑被改坏，也不允许在这里死循环吃内存。
        if next_start <= start {
            break;
        }
        start = next_start;
    }
    chunks
}

// ── Embedding ────────────────────────────────────────────

pub fn encode_embedding(vec: &[f32]) -> Vec<u8> {
    vec.iter().flat_map(|f| f.to_le_bytes()).collect()
}

pub fn decode_embedding(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .filter_map(|b| b.try_into().ok().map(f32::from_le_bytes))
        .collect()
}

/// 余弦相似度。维度不一致或为空时返回 `None`，调用方必须显式跳过 ——
/// 旧实现返回 0.0，被 `rank_vector` 当成真实相似度混进 RRF。
#[must_use]
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> Option<f32> {
    if a.len() != b.len() || a.is_empty() {
        return None;
    }
    let (dot, na, nb) = a
        .iter()
        .zip(b.iter())
        .fold((0.0, 0.0, 0.0), |(d, na, nb), (&x, &y)| {
            (d + x * y, na + x * x, nb + y * y)
        });
    let denom = (na * nb).sqrt();
    if denom == 0.0 {
        Some(0.0)
    } else {
        Some(dot / denom)
    }
}

#[cfg(test)]
mod chunk_tests {
    use super::{
        chunk_text, cosine_similarity, encode_embedding, KnowledgeChunk, KEYWORD_EMBEDDING_DIM,
    };

    /// 拼接后按原顺序「子序列匹配」：保证每个字符都出现过且没有乱序。
    fn assert_covers_in_order(text: &str, chunks: &[String]) {
        let joined: String = chunks.concat();
        let mut it = joined.chars();
        for ch in text.chars() {
            assert!(
                it.any(|c| c == ch),
                "字符 {ch:?} 在分块结果中丢失或顺序被打乱"
            );
        }
    }

    #[test]
    fn chunk_size_zero_terminates_without_panic() {
        // 修复前：end = start + 0，start 永不前进 → 无限循环 + Vec 无限增长。
        let chunks = chunk_text("abcdef", 0, 0);
        assert_eq!(
            chunks,
            vec![
                "a".to_string(),
                "b".to_string(),
                "c".to_string(),
                "d".to_string(),
                "e".to_string(),
                "f".to_string()
            ],
            "chunk_size=0 应被抬到 1（每字符一块），而不是死循环"
        );
    }

    #[test]
    fn overlap_equal_to_chunk_size_terminates_and_keeps_content() {
        // 修复前：start = end - overlap = start → 死循环。
        let text = "abcdefghij";
        let chunks = chunk_text(text, 4, 4);
        assert!(!chunks.is_empty());
        assert!(
            chunks.len() <= text.chars().count(),
            "overlap>=chunk_size 时步长被收敛到 1，块数不应超过字符数（实际 {}）",
            chunks.len()
        );
        assert_covers_in_order(text, &chunks);
    }

    #[test]
    fn overlap_larger_than_chunk_size_terminates_and_keeps_content() {
        // 修复前：saturating_sub(overlap) 恒为 0 → 死循环。
        let text = "abcdefghij";
        let chunks = chunk_text(text, 4, 99);
        assert!(!chunks.is_empty());
        assert!(chunks.len() <= text.chars().count());
        assert_covers_in_order(text, &chunks);
    }

    #[test]
    fn normal_parameters_still_produce_overlapping_chunks() {
        let chunks = chunk_text("abcdefghij", 4, 1);
        assert_eq!(
            chunks,
            vec!["abcd".to_string(), "defg".to_string(), "ghij".to_string()]
        );
    }

    #[test]
    fn empty_and_short_text_are_unchanged() {
        assert!(chunk_text("   ", 10, 2).is_empty());
        assert_eq!(chunk_text(" hello ", 10, 2), vec!["hello".to_string()]);
    }

    #[test]
    fn clamp_bounds_chunk_size_and_overlap() {
        use super::{clamp_chunk_params, MAX_CHUNK_SIZE};
        assert_eq!(clamp_chunk_params(0, 0), (1, 0));
        assert_eq!(clamp_chunk_params(0, 50), (1, 0));
        assert_eq!(clamp_chunk_params(10, 10), (10, 9));
        assert_eq!(clamp_chunk_params(10, 99), (10, 9));
        assert_eq!(clamp_chunk_params(10, 3), (10, 3));
        assert_eq!(
            clamp_chunk_params(usize::MAX, usize::MAX),
            (MAX_CHUNK_SIZE, MAX_CHUNK_SIZE - 1)
        );
    }

    /// T-014：维度不等时 cosine 必须返回 None，而不是伪装成 0 分。
    #[test]
    fn cosine_similarity_rejects_dimension_mismatch() {
        assert_eq!(cosine_similarity(&[1.0, 0.0], &[1.0, 0.0, 0.0]), None);
        assert_eq!(cosine_similarity(&[], &[]), None);
        let same = cosine_similarity(&[1.0, 0.0], &[1.0, 0.0]).expect("同维应返回分数");
        assert!((same - 1.0).abs() < 1e-6, "相同向量余弦应为 1，实际 {same}");
    }

    /// T-014：旧数据缺 metadata → 按 keyword/256 处理，可被 256 维查询命中。
    #[test]
    fn legacy_chunk_without_metadata_defaults_to_keyword_256() {
        let chunk = KnowledgeChunk {
            id: "legacy".into(),
            kb_id: "kb".into(),
            file_id: "f".into(),
            chunk_index: 0,
            content: "旧索引".into(),
            embedding: Some(encode_embedding(&[0.1f32; KEYWORD_EMBEDDING_DIM])),
            embedding_provider: None,
            embedding_dim: None,
            metadata_json: "{}".into(),
        };
        assert_eq!(chunk.effective_embedding_dim(), Some(KEYWORD_EMBEDDING_DIM));
        assert_eq!(chunk.embedding_provider_name(), "keyword");
    }

    /// T-014：旧 sled value 没有新字段时仍能反序列化，不需要迁移。
    #[test]
    fn legacy_chunk_json_without_embedding_metadata_deserializes() {
        let json = r#"{"id":"c","kb_id":"kb","file_id":"f","chunk_index":0,
            "content":"旧数据","embedding":null,"metadata_json":"{}"}"#;
        let chunk: KnowledgeChunk = serde_json::from_str(json).expect("旧数据必须能读");
        assert!(chunk.embedding_provider.is_none());
        assert!(chunk.embedding_dim.is_none());
        assert_eq!(chunk.effective_embedding_dim(), None);
    }

    /// T-014：新数据写下的 provider/dim 能原样往返。
    #[test]
    fn chunk_embedding_metadata_round_trips() {
        let chunk = KnowledgeChunk {
            id: "c".into(),
            kb_id: "kb".into(),
            file_id: "f".into(),
            chunk_index: 0,
            content: "x".into(),
            embedding: Some(encode_embedding(&[0.1f32; 8])),
            embedding_provider: Some("openai".into()),
            embedding_dim: Some(8),
            metadata_json: "{}".into(),
        };
        let json = serde_json::to_string(&chunk).unwrap();
        let back: KnowledgeChunk = serde_json::from_str(&json).unwrap();
        assert_eq!(back.embedding_provider_name(), "openai");
        assert_eq!(back.effective_embedding_dim(), Some(8));
    }
}

/// T-016：删除文档必须同时清掉 sled 里的 chunks（含旧版按 filename 建键的数据）。
#[cfg(test)]
mod delete_tests {
    use super::{delete_document_in, KnowledgeChunk, KnowledgeFile};
    use crate::db::{key, scan_prefix};
    use sled::{Db, Tree};
    use std::path::PathBuf;

    /// 临时 sled 库；`Drop` 里先关库再删目录（Windows 上库开着时删目录会静默失败）。
    struct TempDb {
        dir: PathBuf,
        db: Option<Db>,
    }

    impl TempDb {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("mychat-kb-delete-{tag}-{}", uuid::Uuid::new_v4()));
            let _ = std::fs::remove_dir_all(&dir);
            let db = sled::open(&dir).expect("打开临时 sled");
            Self { dir, db: Some(db) }
        }

        fn trees(&self) -> (Tree, Tree) {
            let db = self.db.as_ref().expect("db 存活");
            (
                db.open_tree("knowledge_chunks").expect("建 chunks 树"),
                db.open_tree("knowledge_files").expect("建 files 树"),
            )
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            drop(self.db.take());
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn chunk(kb_id: &str, file_id: &str, idx: i64) -> KnowledgeChunk {
        KnowledgeChunk {
            id: format!("{file_id}-{idx}"),
            kb_id: kb_id.into(),
            file_id: file_id.into(),
            chunk_index: idx,
            content: format!("chunk {file_id} {idx}"),
            embedding: None,
            embedding_provider: None,
            embedding_dim: None,
            metadata_json: "{}".into(),
        }
    }

    /// 按 `save_chunk` 的键布局写入：`kc:{kb}:{file_id}:{idx}`。
    fn put_chunk(tc: &Tree, c: &KnowledgeChunk, key_file_segment: &str) {
        tc.insert(
            key(
                "kc",
                &format!("{}:{}:{}", c.kb_id, key_file_segment, c.chunk_index),
            ),
            serde_json::to_vec(c).expect("序列化 chunk"),
        )
        .expect("写 chunk");
    }

    fn put_file(tf: &Tree, f: &KnowledgeFile) {
        tf.insert(
            key("kf", &format!("{}:{}", f.kb_id, f.filename)),
            serde_json::to_vec(f).expect("序列化 file"),
        )
        .expect("写 file");
    }

    /// 按 `file_id` 前缀删除：目标文件的块全删，其他文件不动，返回值是删除块数。
    #[test]
    fn delete_document_removes_chunks_by_file_id() {
        let tmp = TempDb::new("by-file-id");
        let (tc, tf) = tmp.trees();
        put_chunk(&tc, &chunk("kb1", "doc-a", 0), "doc-a");
        put_chunk(&tc, &chunk("kb1", "doc-a", 1), "doc-a");
        put_chunk(&tc, &chunk("kb1", "doc-b", 0), "doc-b");
        put_chunk(&tc, &chunk("kb2", "doc-a", 0), "doc-a");

        let removed = delete_document_in(&tc, &tf, "kb1", "doc-a").expect("删除应成功");

        assert_eq!(removed, 2, "应只统计目标文档删掉的块");
        assert!(scan_prefix(&tc, "kc:kb1:doc-a:").is_empty());
        assert_eq!(
            scan_prefix(&tc, "kc:kb1:doc-b:").len(),
            1,
            "其他文件不得误删"
        );
        assert_eq!(
            scan_prefix(&tc, "kc:kb2:doc-a:").len(),
            1,
            "其他知识库不得误删"
        );
    }

    /// 旧数据：键用 `filename`，`chunk.file_id` 是生成 id。按 id 删除时须经文件记录
    /// 解析出 `filename`，再按 `filename` 前缀删。
    #[test]
    fn delete_document_removes_legacy_filename_keyed_chunks() {
        let tmp = TempDb::new("legacy");
        let (tc, tf) = tmp.trees();
        let legacy = chunk("kb1", "uuid-1", 0);
        put_chunk(&tc, &legacy, "report.pdf");
        put_file(
            &tf,
            &KnowledgeFile {
                id: "uuid-1".into(),
                kb_id: "kb1".into(),
                filename: "report.pdf".into(),
                content: "legacy".into(),
            },
        );

        let removed = delete_document_in(&tc, &tf, "kb1", "uuid-1").expect("删除应成功");

        assert_eq!(removed, 1);
        assert!(scan_prefix(&tc, "kc:kb1:").is_empty(), "旧键的块必须删掉");
        assert!(
            scan_prefix(&tf, "kf:kb1:").is_empty(),
            "文件记录也应一并删除"
        );
    }

    /// 兜底：键布局再不同，只要 chunk 载荷里的 `file_id` 匹配也要删掉。
    #[test]
    fn delete_document_falls_back_to_chunk_payload_file_id() {
        let tmp = TempDb::new("payload");
        let (tc, tf) = tmp.trees();
        put_chunk(&tc, &chunk("kb1", "target", 0), "some-other-key");

        let removed = delete_document_in(&tc, &tf, "kb1", "target").expect("删除应成功");

        assert_eq!(removed, 1);
        assert!(scan_prefix(&tc, "kc:kb1:").is_empty());
    }
}
