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
