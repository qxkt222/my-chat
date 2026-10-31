// commands/memory.rs — 白盒记忆 Tauri 命令

use crate::db::memory::Memory;
use serde::Serialize;

/// `mem_list` 的 IPC DTO（T-077）：绝不把 256 维 embedding 当数字数组发给前端。
/// 前端列表只需要展示/编辑字段，向量只在 db 层检索时使用。
#[derive(Debug, Serialize)]
pub struct MemoryDto {
    pub id: String,
    pub content: String,
    pub tags_json: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    /// T-077：收藏加权（>1 时检索加权），前端展示与“收藏”开关都用它。
    pub weight: f32,
}

impl From<Memory> for MemoryDto {
    fn from(memory: Memory) -> Self {
        Self {
            id: memory.id,
            content: memory.content,
            tags_json: memory.tags_json,
            enabled: memory.enabled,
            created_at: memory.created_at,
            updated_at: memory.updated_at,
            weight: memory.weight,
        }
    }
}

/// 缺失/非法权重统一回落到 1.0（旧数据 serde default 是 0.0）。
fn normalize_weight(weight: f32) -> f32 {
    if weight.is_finite() && weight > 0.0 {
        weight
    } else {
        1.0
    }
}

#[tauri::command]
pub fn mem_list() -> Result<Vec<MemoryDto>, String> {
    Ok(crate::db::memory::list_memories()?
        .into_iter()
        .map(MemoryDto::from)
        .collect())
}

#[tauri::command]
pub fn mem_save(memory: Memory) -> Result<(), String> {
    // 向量记忆(27):保存时自动写本地 keyword_embed 嵌入(零依赖)
    let emb = crate::rag::embedder::keyword_embed(&memory.content);
    let mut m = memory;
    m.embedding = Some(crate::db::memory::encode_embedding(&emb));
    // T-077：weight 生产方（前端 save/create/toggleFavorite 传入）；旧调用不传则补 1.0。
    m.weight = normalize_weight(m.weight);
    crate::db::memory::save_memory(&m)
}

#[tauri::command]
pub fn mem_delete(id: String) -> Result<(), String> {
    crate::db::memory::delete_memory(&id)
}

/// 向量记忆检索(41:相关性+新鲜度+重要性三维打分):返回带分数的记忆列表
#[tauri::command]
pub fn mem_search(query: String, top_k: usize) -> Result<Vec<serde_json::Value>, String> {
    let qemb = crate::rag::embedder::keyword_embed(&query);
    let results = crate::db::memory::search_memories(&qemb, top_k)?;
    Ok(results
        .into_iter()
        .map(|(m, score)| {
            serde_json::json!({
                "id": m.id,
                "content": m.content,
                "tags_json": m.tags_json,
                "enabled": m.enabled,
                "created_at": m.created_at,
                "updated_at": m.updated_at,
                "score": score,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{normalize_weight, MemoryDto};
    use crate::db::memory::Memory;

    fn memory_with_embedding() -> Memory {
        Memory {
            id: "m1".to_string(),
            content: "用户偏好中文".to_string(),
            tags_json: r#"["偏好"]"#.to_string(),
            enabled: true,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-02T00:00:00Z".to_string(),
            embedding: Some(vec![1, 2, 3, 4]),
            weight: 2.0,
        }
    }

    /// T-077 验收：IPC 载荷里没有 embedding，weight 正常透出。
    #[test]
    fn memory_dto_excludes_embedding_and_keeps_weight() {
        let dto = MemoryDto::from(memory_with_embedding());
        let value = serde_json::to_value(&dto).expect("DTO 必须可序列化");
        assert!(
            value.get("embedding").is_none(),
            "mem_list 不得携带 embedding：{value}"
        );
        assert_eq!(value["weight"], serde_json::json!(2.0));
        assert_eq!(value["content"], serde_json::json!("用户偏好中文"));
    }

    /// 旧数据/旧调用未传 weight（serde default 0.0）时补成 1.0。
    #[test]
    fn normalize_weight_defaults_invalid_values_to_one() {
        assert!((normalize_weight(0.0) - 1.0).abs() < f32::EPSILON);
        assert!((normalize_weight(-3.0) - 1.0).abs() < f32::EPSILON);
        assert!((normalize_weight(f32::NAN) - 1.0).abs() < f32::EPSILON);
        assert!((normalize_weight(2.0) - 2.0).abs() < f32::EPSILON);
    }
}
