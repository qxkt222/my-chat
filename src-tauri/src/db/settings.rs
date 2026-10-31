// db/settings.rs — Models & settings

use super::{encryption, key, log_corrupt_record, tree, try_scan_prefix};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelConfig {
    pub name: String,
    pub provider: String,
    pub api_url: String,
    pub api_key_encrypted: String,
    pub model: String,
    pub params_json: String,
    /// T-040：`list_models_decrypted` 解不开密文时置 true —— 这是「key 存在但
    /// 本次不可用」的专用标记，与「本来就没有 key」区分开，前端据此禁止回写。
    /// 不落库（false 时不序列化），旧数据缺该字段 → false。
    #[serde(default, skip_serializing_if = "is_false")]
    pub api_key_locked: bool,
}

#[allow(clippy::trivially_copy_pass_by_ref)] // serde(skip_serializing_if) 要求 &bool
fn is_false(v: &bool) -> bool {
    !*v
}

pub fn save_model(m: &ModelConfig) -> Result<(), String> {
    let t = tree("models")?;
    save_model_in(&t, m)
}

/// [`save_model`] 的可测核心（`tree` 注入）。
///
/// T-040：空 key 的语义是「本次没有可用明文」（新增模型，或 DPAPI 解密失败
/// 后前端拿到的是空串），**不能**把库里已有的密文覆盖成空串 —— 旧实现直接
/// 写入空值，用户只是改个 `api_url` 就把 key 永久丢了。空 key 时保留原密文。
fn save_model_in(t: &sled::Tree, m: &ModelConfig) -> Result<(), String> {
    // 加密失败必须显式失败：回落明文会把 DPAPI 加密整个架空，
    // 而且用户以为「保存成功」的 key 其实已落盘为明文。
    // 失败原因已由 encryption 层落到 chat_errors.log。
    let existing = t
        .get(key("m", &m.name))
        .map_err(|e| format!("读取已有模型失败: {e}"))?
        .and_then(|raw| serde_json::from_slice::<ModelConfig>(&raw).ok());
    let stored_key = existing
        .as_ref()
        .map_or("", |e| e.api_key_encrypted.as_str());
    let incoming = m.api_key_encrypted.as_str();
    let encrypted = if !incoming.is_empty() && !incoming.starts_with("ENC:") {
        format!("ENC:{}", encryption::encrypt(incoming)?)
    } else if incoming.is_empty() && !stored_key.is_empty() {
        // T-040：空值不覆盖已有密文
        stored_key.to_string()
    } else {
        incoming.to_string()
    };
    let mc = ModelConfig {
        api_key_encrypted: encrypted,
        // 标记只用于「本次读取」语义，绝不落库
        api_key_locked: false,
        ..m.clone()
    };
    t.insert(
        key("m", &m.name),
        serde_json::to_vec(&mc).map_err(|e| format!("Ser: {e}"))?,
    )
    .map_err(|e| format!("Save: {e}"))?;
    Ok(())
}

fn list_models_in(t: &sled::Tree) -> Result<Vec<ModelConfig>, String> {
    let mut list = Vec::new();
    for (k, v) in try_scan_prefix(t, "m:")? {
        match serde_json::from_slice::<ModelConfig>(&v) {
            Ok(m) => list.push(m),
            Err(e) => log_corrupt_record("list_models", &k, &e.to_string()),
        }
    }
    Ok(list)
}

pub fn list_models() -> Result<Vec<ModelConfig>, String> {
    list_models_in(&tree("models")?)
}

/// List models with API keys decrypted (used by the frontend for requests)
pub fn list_models_decrypted() -> Result<Vec<ModelConfig>, String> {
    list_models_decrypted_in(&tree("models")?)
}

/// [`list_models_decrypted`] 的可测核心。
///
/// T-040：解密失败不再「降级为空串」了事 —— 空串与「本来没有 key」不可区分，
/// 前端下一次 save 会把空值回写、永久覆盖原密文。这里置 `api_key_locked`
/// 标记（专用错误通道），并有 [`save_model_in`] 的空值保留兜底。
fn list_models_decrypted_in(t: &sled::Tree) -> Result<Vec<ModelConfig>, String> {
    let mut list = Vec::new();
    for (k, v) in try_scan_prefix(t, "m:")? {
        let Ok(mut m) = serde_json::from_slice::<ModelConfig>(&v) else {
            log_corrupt_record("list_models_decrypted", &k, "JSON 解析失败");
            continue;
        };
        if m.api_key_encrypted.starts_with("ENC:") {
            if let Ok(plain) = encryption::decrypt(&m.api_key_encrypted[4..]) {
                m.api_key_encrypted = plain;
            } else {
                // 失败原因已由 encryption 层落盘；这里只标记「密文仍在、本次不可用」
                m.api_key_encrypted.clear();
                m.api_key_locked = true;
            }
        }
        list.push(m);
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
        if let Ok(plain) = encryption::decrypt(&m.api_key_encrypted[4..]) {
            m.api_key_encrypted = plain;
        } else {
            // T-040：解不开时返回专用标记，不伪装成「空 key」
            m.api_key_encrypted.clear();
            m.api_key_locked = true;
        }
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

/// 一次模型自愈的明细；由调用方据此落日志（自愈本身不得静默）。
#[derive(Debug, Default)]
struct SanitizeReport {
    /// (模型名, 补全后的 `api_url`)
    repaired: Vec<(String, String)>,
    /// 无法修复的模型名 / 损坏记录的键
    unusable: Vec<String>,
    /// `active_model` 因只是首尾空格不同而被重映射时的 (原值, 新值)
    remapped_active: Option<(String, String)>,
    /// `active_model` 因指向不可用模型而被清空时的原值
    cleared_active: Option<String>,
}

/// `api_url` 归一化结果。
enum ModelUrlCheck {
    /// 已是 http(s)，值可能被去掉首尾空白/尾斜杠
    Valid(String),
    /// 缺 scheme，已补 `http://`
    Repaired(String),
    /// 非 http(s) 或格式不可识别
    Unusable,
}

/// 去掉首尾空白与尾斜杠；不改变其余部分。
fn strip_url_tail(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// 取 `scheme://authority...` 中的 authority；空 authority 视为无效。
fn url_authority(url: &str) -> Option<&str> {
    let idx = url.find("://")?;
    let rest = &url[idx + 3..];
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    if host_port.is_empty() || host_port.starts_with(':') {
        return None;
    }
    Some(authority)
}

/// 无 scheme 的输入是否「像主机名」——避免把误贴的 API key（如 `sk-xxx`）
/// 补成 `http://sk-xxx` 后当成可用地址。
fn looks_like_host(authority: &str) -> bool {
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    if let Some(rest) = host_port.strip_prefix('[') {
        // IPv6 字面量：[::1] / [::1]:11434
        return rest.find(']').is_some_and(|end| end > 0);
    }
    let (host, has_port) = host_port
        .rsplit_once(':')
        .map_or((host_port, false), |(h, p)| {
            (h, !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        });
    !host.is_empty() && (has_port || host.contains('.') || host.eq_ignore_ascii_case("localhost"))
}

/// 把用户输入归一化为可用的 http(s) 地址。
fn normalize_api_url(raw: &str) -> ModelUrlCheck {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return ModelUrlCheck::Unusable;
    }
    if let Some(idx) = trimmed.find("://") {
        let scheme = &trimmed[..idx];
        if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
            return ModelUrlCheck::Unusable;
        }
        if url_authority(trimmed).is_none() {
            return ModelUrlCheck::Unusable;
        }
        return ModelUrlCheck::Valid(strip_url_tail(trimmed));
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return ModelUrlCheck::Unusable;
    }
    let candidate = format!("http://{trimmed}");
    match url_authority(&candidate) {
        Some(authority) if looks_like_host(authority) => {
            ModelUrlCheck::Repaired(strip_url_tail(&candidate))
        }
        _ => ModelUrlCheck::Unusable,
    }
}

/// 可测试的核心：`models` / `settings` 由调用方传入（生产环境是全局 sled tree）。
fn sanitize_models_in(
    models: &sled::Tree,
    settings: &sled::Tree,
) -> Result<SanitizeReport, String> {
    let mut report = SanitizeReport::default();
    let mut usable: Vec<String> = Vec::new();
    // T-037：扫描 IO 错误向上传播，不能拿半份模型列表做自愈
    for (k, v) in try_scan_prefix(models, "m:")? {
        let Ok(mut m) = serde_json::from_slice::<ModelConfig>(&v) else {
            // 解析失败的记录也保留：删除等于静默销毁用户可能还能手工抢救的数据
            report
                .unusable
                .push(String::from_utf8_lossy(&k).into_owned());
            continue;
        };
        match normalize_api_url(&m.api_url) {
            ModelUrlCheck::Valid(url) => {
                if url != m.api_url {
                    m.api_url = url;
                    let bytes = serde_json::to_vec(&m).map_err(|e| format!("Ser: {e}"))?;
                    models.insert(k, bytes).map_err(|e| format!("Heal: {e}"))?;
                }
                usable.push(m.name);
            }
            ModelUrlCheck::Repaired(url) => {
                m.api_url.clone_from(&url);
                let bytes = serde_json::to_vec(&m).map_err(|e| format!("Ser: {e}"))?;
                models.insert(k, bytes).map_err(|e| format!("Heal: {e}"))?;
                report.repaired.push((m.name.clone(), url));
                usable.push(m.name);
            }
            ModelUrlCheck::Unusable => report.unusable.push(m.name),
        }
    }
    // active_model 只指向可用模型；指向不可用/不存在的记录时清空，
    // 并把原值带回报告 —— 调用方必须落日志，不能静默清空。
    let active = get_setting_in(settings, "active_model").unwrap_or_default();
    if !active.is_empty() && !usable.iter().any(|n| n == &active) {
        if let Some(found) = usable.iter().find(|n| n.as_str() == active.trim()) {
            save_setting_in(settings, "active_model", found)?;
            report.remapped_active = Some((active.clone(), found.clone()));
        } else {
            save_setting_in(settings, "active_model", "")?;
            report.cleared_active = Some(active.clone());
        }
    }
    Ok(report)
}

/// 启动自愈：修复 / 保留模型记录，**绝不静默整条删除**。
///
/// - 缺 scheme（`localhost:11434/v1`）→ 补 `http://` 并写回，落
///   `chat_errors.log`（与 `log_diag` 同一出口）；
/// - 非 http(s) / JSON 损坏 → 记录保留但跳过，不参与 `active_model` 校验；
/// - `active_model` 指向不可用记录 → 清空，并在日志里写明原值与原因。
pub fn sanitize_models() -> Result<(), String> {
    let models = tree("models")?;
    let settings = tree("settings")?;
    let report = sanitize_models_in(&models, &settings)?;
    for (name, url) in &report.repaired {
        crate::commands::chat::log_chat_error(&format!(
            "MODEL_URL_HEAL: 模型「{name}」缺少 http(s) scheme，已自动补全为 {url}（记录已保留）"
        ));
    }
    for name in &report.unusable {
        crate::commands::chat::log_chat_error(&format!(
            "MODEL_URL_HEAL: 模型「{name}」的 api_url 不是 http(s) 或记录损坏，记录已保留但不可用"
        ));
    }
    if let Some((from, to)) = &report.remapped_active {
        crate::commands::chat::log_chat_error(&format!(
            "MODEL_URL_HEAL: active_model「{from}」已修正为「{to}」"
        ));
    }
    if let Some(name) = &report.cleared_active {
        crate::commands::chat::log_chat_error(&format!(
            "MODEL_URL_HEAL: active_model「{name}」指向不可用模型，已清空 active_model；模型记录保留，请在设置中重新选择"
        ));
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

        fn models_tree(&self) -> sled::Tree {
            self.db
                .as_ref()
                .expect("库未关闭")
                .open_tree("models")
                .expect("打开 models tree")
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

    // ── T-033: 模型 api_url 启动自愈 ─────────────────────────────
    //
    // 旧行为把 api_url 非 http(s) 的记录整条删除（含已加密 key），且用户
    // 全程无提示。新契约：能补 scheme 的补全并写回；补不了的保留记录、
    // 只清 active_model 且必须把原因带回给调用方落日志。

    fn mk_model(name: &str, api_url: &str) -> ModelConfig {
        ModelConfig {
            name: name.to_string(),
            provider: "custom".to_string(),
            api_url: api_url.to_string(),
            api_key_encrypted: "ENC:secret".to_string(),
            model: "m".to_string(),
            params_json: "{}".to_string(),
            api_key_locked: false,
        }
    }

    fn insert_model(t: &sled::Tree, m: &ModelConfig) {
        t.insert(
            key("m", &m.name),
            serde_json::to_vec(m).expect("序列化模型"),
        )
        .expect("写入模型");
    }

    fn read_model(t: &sled::Tree, name: &str) -> ModelConfig {
        let raw = t
            .get(key("m", name))
            .expect("读模型失败")
            .expect("模型记录应存在");
        serde_json::from_slice(&raw).expect("解析模型")
    }

    #[test]
    fn sanitize_models_fixes_missing_scheme_and_keeps_record() {
        let tmp = TempDb::new();
        let models = tmp.models_tree();
        let settings = tmp.settings_tree();
        insert_model(&models, &mk_model("Local", " localhost:11434/v1/ "));

        let report = sanitize_models_in(&models, &settings).expect("自愈应成功");

        let healed = read_model(&models, "Local");
        assert_eq!(
            healed.api_url, "http://localhost:11434/v1",
            "缺 scheme 的记录应补全并去掉首尾空白/尾斜杠后写回"
        );
        assert_eq!(
            healed.api_key_encrypted, "ENC:secret",
            "写回时不得丢失已加密的 key"
        );
        assert!(
            report
                .repaired
                .iter()
                .any(|(n, u)| n == "Local" && u == "http://localhost:11434/v1"),
            "报告应包含修复记录，供调用方落日志: {:?}",
            report.repaired
        );
        assert!(report.unusable.is_empty());
    }

    #[test]
    fn sanitize_models_keeps_non_http_record_but_clears_active_model() {
        let tmp = TempDb::new();
        let models = tmp.models_tree();
        let settings = tmp.settings_tree();
        insert_model(&models, &mk_model("Cloud", "https://api.example.com/v1"));
        insert_model(&models, &mk_model("Ftp", "ftp://example.com/v1"));
        save_setting_in(&settings, "active_model", "Ftp").expect("写入 active_model");

        let report = sanitize_models_in(&models, &settings).expect("自愈应成功");

        assert!(
            models.get(key("m", "Ftp")).expect("读库").is_some(),
            "非 http(s) 的模型记录必须保留，不能整条删除"
        );
        assert_eq!(
            read_model(&models, "Ftp").api_url,
            "ftp://example.com/v1",
            "无法修复的地址原样保留"
        );
        assert!(report.unusable.contains(&"Ftp".to_string()));
        assert_eq!(
            get_setting_in(&settings, "active_model").expect("读 active_model"),
            "",
            "不可用模型不应继续作为 active_model"
        );
        assert_eq!(
            report.cleared_active.as_deref(),
            Some("Ftp"),
            "清空 active_model 必须带回原因供调用方落日志"
        );
        assert!(models.get(key("m", "Cloud")).expect("读库").is_some());
    }

    #[test]
    fn sanitize_models_remaps_trimmed_active_model() {
        let tmp = TempDb::new();
        let models = tmp.models_tree();
        let settings = tmp.settings_tree();
        insert_model(
            &models,
            &mk_model("DeepSeek", "https://api.deepseek.com/v1"),
        );
        save_setting_in(&settings, "active_model", "DeepSeek ").expect("写入 active_model");

        let report = sanitize_models_in(&models, &settings).expect("自愈应成功");

        assert_eq!(
            get_setting_in(&settings, "active_model").expect("读 active_model"),
            "DeepSeek"
        );
        assert_eq!(
            report.remapped_active,
            Some(("DeepSeek ".to_string(), "DeepSeek".to_string()))
        );
    }

    #[test]
    fn sanitize_models_keeps_unparseable_record() {
        let tmp = TempDb::new();
        let models = tmp.models_tree();
        let settings = tmp.settings_tree();
        models
            .insert(key("m", "Broken"), b"{not json".as_slice())
            .expect("写入损坏记录");

        let report = sanitize_models_in(&models, &settings).expect("自愈应成功");

        assert!(
            models.get(key("m", "Broken")).expect("读库").is_some(),
            "解析失败的记录也应保留，交由用户/日志处理"
        );
        assert!(report.unusable.iter().any(|n| n.contains("Broken")));
    }

    // ── T-040：解密失败/空 key 不得覆盖已存密文 ────────────────
    //
    // 旧行为：list_models_decrypted 解不开就返回空 key（与「本来没 key」不可区分），
    // 前端下次 save 把空值写回 → 原密文永久丢失。新契约：
    // 1. 解密失败 → api_key_locked 标记（专用错误通道）；
    // 2. save_model 收到空 key → 保留库里已有密文。

    /// 模拟 DPAPI 解不开（非法 base64 在所有平台都会失败）：标记为 locked，
    /// 且随后用空 key 回写不会覆盖原密文。
    #[test]
    fn decrypt_failure_is_marked_and_empty_save_keeps_ciphertext() {
        let tmp = TempDb::new();
        let models = tmp.models_tree();
        let mut original = mk_model("BrokenKey", "https://api.example.com/v1");
        original.api_key_encrypted = "ENC:!!!!not-base64!!!!".to_string();
        insert_model(&models, &original);

        let list = list_models_decrypted_in(&models).expect("列表读取应成功");
        assert_eq!(list.len(), 1);
        assert!(
            list[0].api_key_locked,
            "解密失败必须带 api_key_locked 标记（与本来没 key 区分）"
        );
        assert_eq!(list[0].api_key_encrypted, "", "本次不返回不可用明文");

        // 模拟前端改了 api_url 后把空 key 回写
        let mut edited = list[0].clone();
        edited.api_url = "https://api.example.com/v2".to_string();
        save_model_in(&models, &edited).expect("空 key 保存应成功");

        let after = read_model(&models, "BrokenKey");
        assert_eq!(
            after.api_key_encrypted, "ENC:!!!!not-base64!!!!",
            "空 key 不得覆盖原密文"
        );
        assert_eq!(
            after.api_url, "https://api.example.com/v2",
            "其他字段照常更新"
        );
        assert!(!after.api_key_locked, "locked 标记不得落库");
    }

    /// 新增模型（库里没有记录）时，空 key 原样存空 —— 不能凭空造出密文。
    #[test]
    fn empty_key_on_new_model_stays_empty() {
        let tmp = TempDb::new();
        let models = tmp.models_tree();
        let mut m = mk_model("Fresh", "https://api.example.com/v1");
        m.api_key_encrypted = String::new();

        save_model_in(&models, &m).expect("保存应成功");
        assert_eq!(read_model(&models, "Fresh").api_key_encrypted, "");
    }

    /// 显式传入的密文（ENC: 前缀）原样保留，不重复加密。
    #[test]
    fn already_encrypted_key_is_not_reencrypted() {
        let tmp = TempDb::new();
        let models = tmp.models_tree();
        let m = mk_model("Keep", "https://api.example.com/v1");

        save_model_in(&models, &m).expect("保存应成功");
        assert_eq!(
            read_model(&models, "Keep").api_key_encrypted,
            "ENC:secret",
            "ENC: 前缀的密文应原样保留"
        );
    }
}
