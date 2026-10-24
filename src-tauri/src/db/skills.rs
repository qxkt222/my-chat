// db/skills.rs — Skills CRUD

use super::{key, scan_prefix, tree};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub model: String,
    pub temperature: Option<f64>,
    pub category: String,
    pub tags_json: String,
    pub created_at: String,
    pub updated_at: String,
    /// 绑定的 MCP 工具，JSON 数组 ["server/tool", ...]（Agent 能力）
    #[serde(default)]
    pub tools_json: String,
    /// 绑定的记忆标签，JSON 数组 ["tag", ...]（Agent 记忆）
    #[serde(default)]
    pub memory_tags: String,
    /// 对话模式可用：仅 `workSubMode === "chat"` 时生效；工作子模式始终全部可用。
    /// 旧技能没有该字段，升级后默认 false（不在对话模式出现）。
    #[serde(default)]
    pub lite_enabled: bool,
}

pub fn create_skill(s: &Skill) -> Result<(), String> {
    tree("skills")?
        .insert(
            key("sk", &s.id),
            serde_json::to_vec(s).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Save: {e}"))?;
    Ok(())
}

pub fn list_skills() -> Result<Vec<Skill>, String> {
    let t = tree("skills")?;
    let mut list: Vec<Skill> = scan_prefix(&t, "sk:")
        .iter()
        .filter_map(|(_, v)| serde_json::from_slice(v).ok())
        .collect();
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(list)
}

pub fn update_skill(s: &Skill) -> Result<(), String> {
    tree("skills")?
        .insert(
            key("sk", &s.id),
            serde_json::to_vec(s).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Update: {e}"))?;
    Ok(())
}

pub fn delete_skill(id: &str) -> Result<(), String> {
    tree("skills")?
        .remove(key("sk", id))
        .map_err(|e| format!("Del: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 升级前落盘的技能 JSON：没有 `lite_enabled` 字段。
    const LEGACY_JSON: &str = r#"{
        "id": "s-old",
        "name": "Old",
        "description": "legacy",
        "system_prompt": "p",
        "model": "m",
        "temperature": 0.7,
        "category": "c",
        "tags_json": "[]",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "tools_json": "[]",
        "memory_tags": "[]"
    }"#;

    #[test]
    fn legacy_json_defaults_lite_enabled_false() {
        let skill: Skill = serde_json::from_str(LEGACY_JSON).expect("legacy skill should parse");
        assert!(!skill.lite_enabled, "旧技能升级后默认不可在对话模式使用");
    }

    #[test]
    fn roundtrip_preserves_lite_enabled_true() {
        let mut skill: Skill =
            serde_json::from_str(LEGACY_JSON).expect("legacy skill should parse");
        skill.lite_enabled = true;

        let encoded = serde_json::to_vec(&skill).expect("serialize");
        let decoded: Skill = serde_json::from_slice(&encoded).expect("deserialize");
        assert!(decoded.lite_enabled, "往返后 true 必须保持");
    }
}
