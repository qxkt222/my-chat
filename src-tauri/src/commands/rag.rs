// commands/rag.rs — RAG Tauri commands

use crate::rag;
use crate::rag::embedder::EmbeddingProvider;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct RagQuery {
    pub query: String,
    pub kb_id: Option<String>,
    pub top_k: Option<usize>,
    pub provider: Option<String>, // "keyword" or "openai"
    pub api_key: Option<String>,
    /// 检索模式（双模式检索分流）:bm25 / vector / hybrid（缺省 hybrid）
    #[serde(default)]
    pub mode: Option<String>,
}

/// 结构化检索结果（RAG 引用回链+摘录:前端来源卡用 `chunk_id/kb/file_name` 打开原文）
#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResultDto {
    pub chunk_id: String,
    pub content: String,
    pub score: f32,
    pub kb_name: String,
    pub file_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IndexRequest {
    pub kb_id: String,
    pub file_id: String,
    pub content: String,
    pub chunk_size: Option<usize>,
    pub overlap: Option<usize>,
}

#[tauri::command]
pub async fn rag_search(query: RagQuery) -> Result<Vec<SearchResultDto>, String> {
    let provider = match query.provider.as_deref() {
        Some("openai") => EmbeddingProvider::OpenAI {
            api_key: query.api_key.unwrap_or_default(),
            model: "text-embedding-3-small".to_string(),
        },
        _ => EmbeddingProvider::Keyword,
    };
    let top_k = query.top_k.unwrap_or(3);
    let mode = query.mode.as_deref().unwrap_or("hybrid");

    // 读候选 chunks（sled 读，快）
    let chunks = match query.kb_id.as_deref() {
        Some(kbid) => crate::db::knowledge::list_chunks(kbid)?,
        None => crate::db::knowledge::list_all_chunks_with_embeddings()?,
    };
    if chunks.is_empty() {
        return Ok(Vec::new());
    }

    // embed query 是 async IO（可能调 OpenAI API），留在 async runtime
    let query_emb = crate::rag::embedder::embed(&query.query, &provider).await?;

    // CPU 重活（BM25 线性扫描 + 向量排名 + RRF）放 spawn_blocking，
    // 避免阻塞 Tauri 主线程冻结 UI（大知识库时明显）。
    let q = query.query.clone();
    let m = mode.to_string();
    let results = tauri::async_runtime::spawn_blocking(move || {
        crate::rag::search_with_embedding_sync(&chunks, &q, &query_emb, top_k, &m)
    })
    .await
    .map_err(|e| format!("搜索线程错误: {e}"))?;

    Ok(results
        .into_iter()
        .map(|r| SearchResultDto {
            chunk_id: r.chunk_id,
            content: r.content,
            score: r.score,
            kb_name: r.kb_name,
            file_name: r.file_name,
        })
        .collect())
}

/// LLM rerank（重排）:取候选 top-N,喂给用户配置的模型打分排序。
/// 复用 `OpenAI` 兼容 chat 端点(与对话同链路),prompt 要求模型按相关性打分。
#[tauri::command]
pub async fn rag_rerank(
    query: String,
    candidates: Vec<String>,
    api_url: String,
    api_key: String,
    model: String,
) -> Result<Vec<usize>, String> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    // 拼成打分 prompt:给每个候选段落标注 [1][2]…,要求只输出按相关性降序的编号序列
    let mut doc_block = String::new();
    for (i, c) in candidates.iter().enumerate() {
        let snippet: String = c.chars().take(600).collect();
        doc_block.push('[');
        doc_block.push_str(&i.to_string());
        doc_block.push_str("]\n");
        doc_block.push_str(&snippet);
        doc_block.push_str("\n\n");
    }
    let sys = "你是检索重排器。根据查询的相关性,给下面的候选段落打分并排序。只输出按相关性从高到低的编号序列(如 2,0,3,1),不要任何其他文字。";
    let mut user = String::from("查询: ");
    user.push_str(&query);
    user.push_str("\n\n候选段落:\n");
    user.push_str(&doc_block);

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": sys},
            {"role": "user", "content": user}
        ],
        "temperature": 0.0,
        "max_tokens": 512,
    });
    let mut url = api_url.trim().to_string();
    if !url.ends_with("/chat/completions") {
        if !url.ends_with('/') {
            url.push('/');
        }
        url.push_str("chat/completions");
    }
    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("rerank 请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("rerank API error {}: {}", status.as_u16(), text));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("rerank 解析失败: {e}"))?;
    let content = parsed["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();
    // 解析编号序列
    let mut indices: Vec<usize> = Vec::new();
    for tok in content.split(|c: char| !c.is_ascii_digit()) {
        if let Ok(n) = tok.parse::<usize>() {
            if n < candidates.len() && !indices.contains(&n) {
                indices.push(n);
            }
        }
    }
    Ok(indices)
}

#[tauri::command]
pub async fn rag_index_document(req: IndexRequest) -> Result<usize, String> {
    rag::index_document(
        &req.kb_id,
        &req.file_id,
        &req.content,
        &EmbeddingProvider::Keyword,
        req.chunk_size.unwrap_or(500),
        req.overlap.unwrap_or(50),
    )
    .await
}

#[tauri::command]
pub async fn rag_index_with_openai(req: IndexRequest, api_key: String) -> Result<usize, String> {
    rag::index_document(
        &req.kb_id,
        &req.file_id,
        &req.content,
        &EmbeddingProvider::OpenAI {
            api_key,
            model: "text-embedding-3-small".to_string(),
        },
        req.chunk_size.unwrap_or(500),
        req.overlap.unwrap_or(50),
    )
    .await
}

#[tauri::command]
pub fn delete_kb(id: String) -> Result<(), String> {
    crate::db::knowledge::delete_kb(&id)
}
