// db/settings.rs — Models & settings

use super::{encryption, key, scan_prefix, tree};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelConfig {
    pub name: String,
    pub provider: String,
    pub api_url: String,
    pub api_key_encrypted: String,
    pub model: String,
    pub params_json: String,
}

pub fn save_model(m: &ModelConfig) -> Result<(), String> {
    let t = tree("models")?;
    // 加密失败时**保留原值**，不写入空串 —— 静默丢 key 是旧实现最坏的毛病
    // （失败原因已由 encryption 层落到 chat_errors.log）
    let encrypted = if !m.api_key_encrypted.is_empty() && !m.api_key_encrypted.starts_with("ENC:") {
        encryption::encrypt(&m.api_key_encrypted)
            .map_or_else(|_| m.api_key_encrypted.clone(), |enc| format!("ENC:{enc}"))
    } else {
        m.api_key_encrypted.clone()
    };
    let mc = ModelConfig {
        api_key_encrypted: encrypted,
        ..m.clone()
    };
    t.insert(
        key("m", &m.name),
        serde_json::to_vec(&mc).map_err(|e| format!("Ser: {e}"))?,
    )
    .map_err(|e| format!("Save: {e}"))?;
    Ok(())
}

pub fn list_models() -> Result<Vec<ModelConfig>, String> {
    let t = tree("models")?;
    let mut list = Vec::new();
    for (_, v) in scan_prefix(&t, "m:") {
        if let Ok(m) = serde_json::from_slice::<ModelConfig>(&v) {
            list.push(m);
        }
    }
    Ok(list)
}

/// List models with API keys decrypted (used by the frontend for requests)
pub fn list_models_decrypted() -> Result<Vec<ModelConfig>, String> {
    let t = tree("models")?;
    let mut list = Vec::new();
    for (_, v) in scan_prefix(&t, "m:") {
        if let Ok(mut m) = serde_json::from_slice::<ModelConfig>(&v) {
            if m.api_key_encrypted.starts_with("ENC:") {
                // 解不开就降级为空 key（失败原因已落盘）——
                // 用户除了「认证失败」之外，至少多了 chat_errors.log 这条线索
                m.api_key_encrypted =
                    encryption::decrypt(&m.api_key_encrypted[4..]).unwrap_or_default();
            }
            list.push(m);
        }
    }
    Ok(list)
}

#[allow(dead_code)]
pub fn get_model_decrypted(name: &str) -> Result<ModelConfig, String> {
    let t = tree("models")?;
    let raw = t
        .get(key("m", name))
        .map_err(|e| format!("Get: {e}"))?
        .ok_or("Model not found".to_string())?;
    let mut m: ModelConfig = serde_json::from_slice(&raw).map_err(|e| format!("De: {e}"))?;
    if m.api_key_encrypted.starts_with("ENC:") {
        // 同上：解不开降级为空 key，原因已由 encryption 层落盘
        m.api_key_encrypted = encryption::decrypt(&m.api_key_encrypted[4..]).unwrap_or_default();
    }
    Ok(m)
}

pub fn delete_model(name: &str) -> Result<(), String> {
    tree("models")?
        .remove(key("m", name))
        .map_err(|e| format!("Del: {e}"))?;
    Ok(())
}

pub fn delete_all_models() -> Result<(), String> {
    let t = tree("models")?;
    t.clear().map_err(|e| format!("Clear: {e}"))?;
    Ok(())
}

/// Startup self-heal: drop corrupted model records (e.g. `api_url` accidentally
/// filled with an API key) and remap `active_model` to a valid record.
pub fn sanitize_models() -> Result<(), String> {
    let t = tree("models")?;
    let mut bad: Vec<Vec<u8>> = Vec::new();
    for (k, v) in scan_prefix(&t, "m:") {
        match serde_json::from_slice::<ModelConfig>(&v) {
            Ok(m) => {
                let url = m.api_url.trim().to_lowercase();
                if !url.starts_with("http://") && !url.starts_with("https://") {
                    bad.push(k.clone());
                }
            }
            Err(_) => bad.push(k.clone()),
        }
    }
    for k in &bad {
        t.remove(k.as_slice()).map_err(|e| format!("Clean: {e}"))?;
    }
    if !bad.is_empty() {
        // Remap active_model: "DeepSeek " → "DeepSeek" when a trimmed match exists
        let active = get_setting("active_model").unwrap_or_default();
        if !active.is_empty() {
            let trimmed = active.trim();
            let remap = scan_prefix(&t, "m:").iter().find_map(|(_, v)| {
                serde_json::from_slice::<ModelConfig>(v)
                    .ok()
                    .filter(|m| m.name.trim() == trimmed)
                    .map(|m| m.name)
            });
            save_setting("active_model", remap.as_deref().unwrap_or(""))?;
        }
    }
    Ok(())
}

pub fn get_setting(key_name: &str) -> Result<String, String> {
    let t = tree("settings")?;
    Ok(t.get(key("s", key_name))
        .map_err(|e| format!("Get: {e}"))?
        .map(|v| String::from_utf8_lossy(&v).to_string())
        .unwrap_or_default())
}

pub fn save_setting(key_name: &str, value: &str) -> Result<(), String> {
    tree("settings")?
        .insert(key("s", key_name), value.as_bytes())
        .map_err(|e| format!("Save: {e}"))?;
    Ok(())
}
