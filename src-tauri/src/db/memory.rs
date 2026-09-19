// db/memory.rs — 白盒记忆（结构化、可编辑、用户完全掌控）

use super::{key, scan_prefix, tree};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Memory {
    pub id: String,
    /// 记忆内容（长期事实/偏好/未决问题等）
    pub content: String,
    /// 标签 JSON 数组（如 ["工作", "用户偏好"]），用于按标签筛选注入
    pub tags_json: String,
    /// 启用开关（false 的记忆不注入对话）
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    /// 向量记忆(27):本地 `keyword_embed` 256 维嵌入(f32 LE bytes)。
    /// 缺失/旧数据 → None(入库时补写)。
    #[serde(default)]
    pub embedding: Option<Vec<u8>>,
    /// 收藏优先(28):被收藏/点赞的消息入库时高权重 → 向量召回加权。
    #[serde(default)]
    pub weight: f32,
}

pub fn list_memories() -> Result<Vec<Memory>, String> {
    let t = tree("memories")?;
    let mut list: Vec<Memory> = scan_prefix(&t, "mem:")
        .iter()
        .filter_map(|(_, v)| serde_json::from_slice(v).ok())
        .collect();
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(list)
}

/// 向量记忆检索(41:相关性 + 新鲜度 + 重要性三维打分):
/// 与 query 的余弦相似度(相关性) × 位置新鲜度(新插入更近 1.0) × 权重(重要性)。
/// 返回按最终分排序的记忆列表。
pub fn search_memories(query_emb: &[f32], top_k: usize) -> Result<Vec<(Memory, f32)>, String> {
    let memories = list_memories()?;
    let total = memories.len().max(1) as f32;
    let mut scored: Vec<(Memory, f32)> = Vec::new();
    for (idx, m) in memories.into_iter().enumerate() {
        if !m.enabled {
            continue;
        }
        let emb = match &m.embedding {
            Some(bytes) if bytes.len() >= 4 => decode_embedding(bytes),
            _ => {
                // 旧数据无嵌入:即时补算并写回(自愈)
                let v = crate::rag::embedder::keyword_embed(&m.content);
                let _ = save_memory_with_emb(&m, &v);
                v
            }
        };
        let sim = cosine(query_emb, &emb);
        if sim <= 0.0 {
            continue;
        }
        // 新鲜度:按列表位置(updated_at 已降序,越靠前越新)→ 新记忆近 1.0
        let freshness = 0.5 + 0.5 * (1.0 - idx as f32 / total);
        // 重要性:收藏/点赞的记忆 weight>1 → 加权
        let importance = if m.weight > 1.0 { 1.2 } else { 1.0 };
        scored.push((m, sim * freshness * importance));
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_k);
    Ok(scored)
}

fn decode_embedding(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na <= 0.0 || nb <= 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// `保存记忆并写嵌入(向量记忆;keyword_embed` 本地零依赖)
fn save_memory_with_emb(m: &Memory, emb: &[f32]) -> Result<(), String> {
    let mut updated = m.clone();
    updated.embedding = Some(encode_embedding(emb));
    save_memory(&updated)
}

pub fn encode_embedding(emb: &[f32]) -> Vec<u8> {
    emb.iter().flat_map(|f| f.to_le_bytes().to_vec()).collect()
}

pub fn save_memory(m: &Memory) -> Result<(), String> {
    tree("memories")?
        .insert(
            key("mem", &m.id),
            serde_json::to_vec(m).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Save: {e}"))?;
    Ok(())
}

pub fn delete_memory(id: &str) -> Result<(), String> {
    tree("memories")?
        .remove(key("mem", id))
        .map_err(|e| format!("Del: {e}"))?;
    Ok(())
}
