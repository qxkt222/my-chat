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

pub fn chunk_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
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
        start = end.saturating_sub(overlap);
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
