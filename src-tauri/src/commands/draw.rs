// commands/draw.rs — 图片生成（OpenAI 兼容 /images/generations 端点）

use base64::Engine;
use std::path::PathBuf;

/// 调用图片生成接口，把图片写到临时目录（%APPDATA%\com.my-chat\generated），
/// 返回文件路径。P2-2：前端用 convertFileSrc 加载，避免大 Base64 走 IPC
/// （Tauri IPC 是 JSON 序列化，传大图会卡 UI）。
#[tauri::command]
pub async fn generate_image(
    url: String,
    api_key: String,
    prompt: String,
    model: String,
    size: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": size,
    });
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("图片接口错误 {status}: {text}"));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))?;
    // OpenAI 返回 data[0].url 或 data[0].b64_json
    let data = json["data"].get(0).ok_or("响应缺少 data[0]")?;

    let dir = app_generated_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let out_path = dir.join(format!("gen-{}-{}.png", ts, std::process::id()));

    if let Some(u) = data["url"].as_str() {
        // 远程 URL：直接下载到本地（避免外链失效 + 前端直连外网）
        let bytes = client
            .get(u)
            .send()
            .await
            .map_err(|e| format!("下载图片失败: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("读取图片失败: {e}"))?;
        std::fs::write(&out_path, &bytes).map_err(|e| format!("写入图片失败: {e}"))?;
        return Ok(out_path.to_string_lossy().to_string());
    }
    if let Some(b64) = data["b64_json"].as_str() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("Base64 解码失败: {e}"))?;
        std::fs::write(&out_path, &bytes).map_err(|e| format!("写入图片失败: {e}"))?;
        return Ok(out_path.to_string_lossy().to_string());
    }
    Err("响应既无 url 也无 b64_json".to_string())
}

fn app_generated_dir() -> PathBuf {
    let base = std::env::var("APPDATA").map_or_else(
        |_| {
            PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
                .join("AppData")
                .join("Roaming")
        },
        PathBuf::from,
    );
    base.join("com.my-chat").join("generated")
}
