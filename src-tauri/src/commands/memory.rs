// commands/memory.rs — 白盒记忆 Tauri 命令

use crate::db::memory::Memory;

#[tauri::command]
pub fn mem_list() -> Result<Vec<Memory>, String> {
    crate::db::memory::list_memories()
}

#[tauri::command]
pub fn mem_save(memory: Memory) -> Result<(), String> {
    // 向量记忆(27):保存时自动写本地 keyword_embed 嵌入(零依赖)
    let emb = crate::rag::embedder::keyword_embed(&memory.content);
    let mut m = memory;
    m.embedding = Some(crate::db::memory::encode_embedding(&emb));
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
