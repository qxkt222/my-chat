// db/import.rs — JSON → Sled migration

use crate::db::{conversations, encryption, settings, skills};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportResult {
    pub conversations: usize,
    pub skills: usize,
    pub models: usize,
    pub templates: usize,
    pub knowledge_bases: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct JsonConv {
    id: String,
    title: String,
    created_at: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    messages: Vec<JsonMsg>,
}
#[derive(Debug, Deserialize)]
struct JsonMsg {
    #[serde(default)]
    id: String,
    role: String,
    content: String,
    timestamp: String,
}
#[derive(Debug, Deserialize)]
struct JsonSkill {
    id: String,
    name: String,
    description: String,
    #[serde(rename = "systemPrompt")]
    system_prompt: String,
    model: String,
    temperature: Option<f64>,
    category: String,
    #[serde(default)]
    tags: Vec<String>,
    created_at: String,
    updated_at: String,
}
#[derive(Debug, Deserialize)]
struct JsonModel {
    name: String,
    api_url: String,
    api_key: String,
    model: String,
}
#[derive(Debug, Deserialize)]
struct JsonSettings {
    models: Vec<JsonModel>,
    #[serde(default)]
    active_model: String,
}

fn app_data_dir() -> PathBuf {
    let base = std::env::var("APPDATA").map_or_else(
        |_| {
            PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
                .join("AppData")
                .join("Roaming")
        },
        PathBuf::from,
    );
    base.join("com.my-chat")
}

#[allow(clippy::unnecessary_wraps)] // 调用方预期 Result 接口
pub fn import_all_from_json() -> Result<ImportResult, String> {
    let dir = app_data_dir();
    let mut r = ImportResult {
        conversations: 0,
        skills: 0,
        models: 0,
        templates: 0,
        knowledge_bases: 0,
        errors: vec![],
    };

    let cd = dir.join("conversations");
    if cd.exists() {
        if let Ok(entries) = std::fs::read_dir(&cd) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().is_none_or(|x| x != "json") {
                    continue;
                }
                let raw = std::fs::read_to_string(&p).unwrap_or_default();
                if let Ok(jc) = serde_json::from_str::<JsonConv>(&raw) {
                    let up = if jc.updated_at.is_empty() {
                        jc.created_at.clone()
                    } else {
                        jc.updated_at.clone()
                    };
                    let c = conversations::Conversation {
                        id: jc.id.clone(),
                        title: jc.title,
                        model_name: String::new(),
                        system_prompt: String::new(),
                        created_at: jc.created_at,
                        updated_at: up,
                        character_id: String::new(),
                        persona_id: String::new(),
                        summary: String::new(),
                        summary_msg_count: 0,
                    };
                    if conversations::create_conv(&c).is_ok() {
                        for (mi, m) in jc.messages.into_iter().enumerate() {
                            let mid = if m.id.is_empty() {
                                uuid::Uuid::new_v4().to_string()
                            } else {
                                m.id
                            };
                            conversations::add_msg(&conversations::Message {
                                id: mid,
                                conv_id: jc.id.clone(),
                                role: m.role,
                                content: m.content,
                                timestamp: m.timestamp,
                                token_count: 0,
                                model: String::new(),
                                reasoning: String::new(),
                                seq: mi as i64 + 1,
                                error: String::new(),
                                error_kind: String::new(),
                                bookmarked: false,
                            })
                            .ok();
                        }
                        r.conversations += 1;
                    }
                }
            }
        }
    }

    let sd = dir.join("skills");
    if sd.exists() {
        if let Ok(entries) = std::fs::read_dir(&sd) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().is_none_or(|x| x != "json") {
                    continue;
                }
                let raw = std::fs::read_to_string(&p).unwrap_or_default();
                if let Ok(js) = serde_json::from_str::<JsonSkill>(&raw) {
                    skills::create_skill(&skills::Skill {
                        id: js.id,
                        name: js.name,
                        description: js.description,
                        system_prompt: js.system_prompt,
                        model: js.model,
                        temperature: js.temperature,
                        category: js.category,
                        tags_json: serde_json::to_string(&js.tags).unwrap_or_default(),
                        created_at: js.created_at,
                        updated_at: js.updated_at,
                        tools_json: String::new(),
                        memory_tags: String::new(),
                    })
                    .ok();
                    r.skills += 1;
                }
            }
        }
    }

    let sp = dir.join("settings.json");
    if sp.exists() {
        let raw = std::fs::read_to_string(&sp).unwrap_or_default();
        if let Ok(s) = serde_json::from_str::<JsonSettings>(&raw) {
            for m in s.models {
                settings::save_model(&settings::ModelConfig {
                    name: m.name,
                    provider: String::new(),
                    api_url: m.api_url,
                    api_key_encrypted: format!("ENC:{}", encryption::encrypt(&m.api_key)),
                    model: m.model,
                    params_json: String::new(),
                })
                .ok();
                r.models += 1;
            }
            settings::save_setting("active_model", &s.active_model).ok();
        }
    }

    Ok(r)
}
