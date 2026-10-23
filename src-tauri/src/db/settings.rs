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
    // 加密失败必须显式失败：回落明文会把 DPAPI 加密整个架空，
    // 而且用户以为「保存成功」的 key 其实已落盘为明文。
    // 失败原因已由 encryption 层落到 chat_errors.log。
    let encrypted = if !m.api_key_encrypted.is_empty() && !m.api_key_encrypted.starts_with("ENC:") {
        let enc = encryption::encrypt(&m.api_key_encrypted)?;
        format!("ENC:{enc}")
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

/// 某个设置键是否承载敏感数据（API key / token / 密码等）。
///
/// 规则（大小写不敏感）：
/// - 精确匹配 `connection_profiles`（内含各连接的 `api_key`）
/// - 后缀匹配 `_key` / `_secret` / `_token` / `_password`
#[must_use]
pub fn is_sensitive_key(key_name: &str) -> bool {
    let k = key_name.trim().to_ascii_lowercase();
    k == "connection_profiles"
        || ["_key", "_secret", "_token", "_password"]
            .iter()
            .any(|suffix| k.ends_with(suffix))
}

/// 旧版本把敏感键当普通 KV 明文存；读到时就地重写为密文（best-effort，
/// 失败不影响本次返回——数据仍在，只是这次没迁移成功）。
fn migrate_plaintext_sensitive(t: &sled::Tree, key_name: &str, stored: &str) {
    if !is_sensitive_key(key_name) || stored.is_empty() {
        return;
    }
    if let Ok(enc) = encryption::encrypt(stored) {
        let _ = t.insert(key("s", key_name), format!("ENC:{enc}").as_bytes());
    }
}

/// 读取并在必要时解密。敏感键的旧明文会被惰性迁移为密文（best-effort）。
fn get_setting_in(t: &sled::Tree, key_name: &str) -> Result<String, String> {
    let Some(bytes) = t.get(key("s", key_name)).map_err(|e| format!("Get: {e}"))? else {
        return Ok(String::new());
    };
    let stored = String::from_utf8_lossy(&bytes).to_string();

    if let Some(encoded) = stored.strip_prefix("ENC:") {
        // 解不开就返回 Err：静默返回空串会让「key 丢了」无从发现
        return encryption::decrypt(encoded);
    }

    migrate_plaintext_sensitive(t, key_name, &stored);
    Ok(stored)
}

/// 敏感键必须经 DPAPI 加密后落库；加密失败返回 `Err`，绝不回落明文。
fn save_setting_in(t: &sled::Tree, key_name: &str, value: &str) -> Result<(), String> {
    let stored = if is_sensitive_key(key_name) && !value.is_empty() {
        let enc = encryption::encrypt(value)?;
        format!("ENC:{enc}")
    } else {
        value.to_string()
    };
    t.insert(key("s", key_name), stored.as_bytes())
        .map_err(|e| format!("Save: {e}"))?;
    Ok(())
}

pub fn get_setting(key_name: &str) -> Result<String, String> {
    let t = tree("settings")?;
    get_setting_in(&t, key_name)
}

pub fn save_setting(key_name: &str, value: &str) -> Result<(), String> {
    let t = tree("settings")?;
    save_setting_in(&t, key_name, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 隔离的临时 sled 库；`Drop` 时先关库再删目录，绝不碰用户 `%APPDATA%`。
    struct TempDb {
        dir: PathBuf,
        db: Option<sled::Db>,
    }

    impl TempDb {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("mychat-settings-test-{}", uuid::Uuid::new_v4()));
            let db = sled::open(&dir).expect("打开临时 sled 库");
            Self { dir, db: Some(db) }
        }

        fn settings_tree(&self) -> sled::Tree {
            self.db
                .as_ref()
                .expect("库未关闭")
                .open_tree("settings")
                .expect("打开 settings tree")
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            // 先释放 sled 句柄——Windows 上文件仍被占用时删不掉目录
            self.db.take();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn raw_value(t: &sled::Tree, key_name: &str) -> Vec<u8> {
        t.get(key("s", key_name))
            .expect("读 sled 失败")
            .expect("键应存在")
            .to_vec()
    }

    #[test]
    fn is_sensitive_key_matches_secrets() {
        for k in [
            "deepl_key",
            "openai_api_key",
            "connection_profiles",
            "some_password",
            "auth_token",
            "DEEPL_KEY",
            "Connection_Profiles",
        ] {
            assert!(is_sensitive_key(k), "{k} 应判为敏感键");
        }
    }

    #[test]
    fn is_sensitive_key_ignores_plain_settings() {
        for k in ["theme", "font_size", "last_conv"] {
            assert!(!is_sensitive_key(k), "{k} 不应判为敏感键");
        }
    }

    #[test]
    fn sensitive_setting_stored_encrypted_and_roundtrips() {
        let tmp = TempDb::new();
        let t = tmp.settings_tree();

        save_setting_in(&t, "deepl_key", "sk-secret-123").expect("保存应成功");

        let raw = String::from_utf8(raw_value(&t, "deepl_key")).expect("落库值是 UTF-8");
        assert!(
            raw.starts_with("ENC:"),
            "敏感键在 sled 中必须以 ENC: 开头，实际: {raw}"
        );
        assert!(!raw.contains("sk-secret-123"), "落库值不应包含明文");
        assert_eq!(
            get_setting_in(&t, "deepl_key").expect("读取应成功"),
            "sk-secret-123",
            "get_setting 应返回明文"
        );
    }

    #[test]
    fn non_sensitive_setting_stays_plaintext() {
        let tmp = TempDb::new();
        let t = tmp.settings_tree();

        save_setting_in(&t, "theme", "dark").expect("保存应成功");

        assert_eq!(raw_value(&t, "theme"), b"dark", "非敏感键不应被加密");
        assert_eq!(get_setting_in(&t, "theme").expect("读取应成功"), "dark");
    }

    #[test]
    fn empty_sensitive_setting_is_not_wrapped() {
        let tmp = TempDb::new();
        let t = tmp.settings_tree();

        save_setting_in(&t, "deepl_key", "").expect("保存应成功");

        assert!(raw_value(&t, "deepl_key").is_empty(), "空值应原样存空串");
        assert_eq!(get_setting_in(&t, "deepl_key").expect("读取应成功"), "");
    }

    #[test]
    fn legacy_plaintext_sensitive_setting_reads_and_migrates() {
        let tmp = TempDb::new();
        let t = tmp.settings_tree();
        let legacy = r#"[{"name":"x","api_key":"sk-old"}]"#;

        // 模拟旧版本直接写入的明文（绕过 save_setting_in）
        t.insert(key("s", "connection_profiles"), legacy.as_bytes())
            .expect("写入旧明文");

        assert_eq!(
            get_setting_in(&t, "connection_profiles").expect("旧明文应可读"),
            legacy,
            "旧明文必须原样返回，不能丢数据"
        );

        let raw = String::from_utf8(raw_value(&t, "connection_profiles")).expect("落库值是 UTF-8");
        assert!(
            raw.starts_with("ENC:"),
            "读取旧明文时应惰性迁移为密文，实际: {raw}"
        );

        assert_eq!(
            get_setting_in(&t, "connection_profiles").expect("迁移后应可读"),
            legacy,
            "迁移后仍应读回同一明文"
        );
    }
}
