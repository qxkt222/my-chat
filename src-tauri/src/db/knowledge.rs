// db/knowledge.rs — Knowledge bases, files, chunks & embeddings
//
// NOTE: create_kb/list_kbs/save_file/list_files/delete_file are the KB/file
// management half of this subsystem. The UI drives them indirectly through
// rag_index_document / delete_kb / the file-based KnowledgeManager; they are
// kept as the complete storage API for future expansion.

use super::{key, scan_prefix, tree};
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
    pub metadata_json: String,
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
    Ok(scan_prefix(&tree("knowledge_bases")?, "kb:")
        .iter()
        .filter_map(|(_, v)| serde_json::from_slice(v).ok())
        .collect())
}

#[allow(dead_code)]
pub fn delete_kb(id: &str) -> Result<(), String> {
    let tkb = tree("knowledge_bases")?;
    tkb.remove(key("kb", id)).ok();
    let tf = tree("knowledge_files")?;
    for (k, _) in scan_prefix(&tf, &format!("kf:{id}:")) {
        tf.remove(k).ok();
    }
    let tc = tree("knowledge_chunks")?;
    for (k, _) in scan_prefix(&tc, &format!("kc:{id}:")) {
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
    Ok(
        scan_prefix(&tree("knowledge_files")?, &format!("kf:{kb_id}:"))
            .iter()
            .filter_map(|(_, v)| serde_json::from_slice(v).ok())
            .collect(),
    )
}

#[allow(dead_code)]
pub fn delete_file(kb_id: &str, filename: &str) -> Result<(), String> {
    let tf = tree("knowledge_files")?;
    tf.remove(key("kf", &format!("{kb_id}:{filename}"))).ok();
    let tc = tree("knowledge_chunks")?;
    for (k, _) in scan_prefix(&tc, &format!("kc:{kb_id}:{filename}:")) {
        tc.remove(k).ok();
    }
    Ok(())
}

// ── Chunks ───────────────────────────────────────────────

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
    let mut list: Vec<KnowledgeChunk> =
        scan_prefix(&tree("knowledge_chunks")?, &format!("kc:{kb_id}:"))
            .iter()
            .filter_map(|(_, v)| serde_json::from_slice(v).ok())
            .collect();
    list.sort_by_key(|c| c.chunk_index);
    Ok(list)
}

pub fn list_all_chunks_with_embeddings() -> Result<Vec<KnowledgeChunk>, String> {
    Ok(scan_prefix(&tree("knowledge_chunks")?, "kc:")
        .iter()
        .filter_map(|(_, v)| serde_json::from_slice::<KnowledgeChunk>(v).ok())
        .filter(|c| c.embedding.is_some())
        .collect())
}

/// Remove all chunks of one file. Chunk keys are `kc:{kb_id}:{file_id}:{idx`},
/// so this is a direct prefix delete — no full-table scan (the old version
/// scanned every chunk and did a `contains()` substring match).
pub fn delete_chunks_by_file(kb_id: &str, file_id: &str) -> Result<(), String> {
    let t = tree("knowledge_chunks")?;
    let prefix = format!("kc:{kb_id}:{file_id}:");
    for (k, _) in scan_prefix(&t, &prefix) {
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

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (dot, na, nb) = a
        .iter()
        .zip(b.iter())
        .fold((0.0, 0.0, 0.0), |(d, na, nb), (&x, &y)| {
            (d + x * y, na + x * x, nb + y * y)
        });
    let denom = (na * nb).sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}

#[cfg(test)]
mod chunk_tests {
    use super::chunk_text;

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
}
