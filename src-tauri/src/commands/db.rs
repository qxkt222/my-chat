// commands/db.rs — Database Tauri commands (sled backend)

use crate::db;
use serde::{Deserialize, Serialize};

// ── Conversations ────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ConvDto {
    pub id: String,
    pub title: String,
    pub model_name: String,
    pub system_prompt: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub character_id: String,
    #[serde(default)]
    pub persona_id: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub summary_msg_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MsgDto {
    pub id: String,
    pub conv_id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
    pub token_count: i64,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub reasoning: String,
    #[serde(default)]
    pub seq: i64,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub error_kind: String,
    #[serde(default)]
    pub bookmarked: bool,
}

#[tauri::command]
pub fn create_conv(conv: ConvDto) -> Result<(), String> {
    db::conversations::create_conv(&db::conversations::Conversation {
        id: conv.id,
        title: conv.title,
        model_name: conv.model_name,
        system_prompt: conv.system_prompt,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
        character_id: conv.character_id,
        persona_id: conv.persona_id,
        summary: conv.summary,
        summary_msg_count: conv.summary_msg_count,
    })
}

#[tauri::command]
pub fn list_convs() -> Result<Vec<ConvDto>, String> {
    db::conversations::list_convs().map(|list| {
        list.into_iter()
            .map(|c| ConvDto {
                id: c.id,
                title: c.title,
                model_name: c.model_name,
                system_prompt: c.system_prompt,
                created_at: c.created_at,
                updated_at: c.updated_at,
                character_id: c.character_id,
                persona_id: c.persona_id,
                summary: c.summary,
                summary_msg_count: c.summary_msg_count,
            })
            .collect()
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LoadAllResult {
    pub conversations: Vec<ConvDto>,
    pub messages: std::collections::HashMap<String, Vec<MsgDto>>,
}

/// 启动批量化（P1-3）：一次 IPC 返回全部会话 + 全部消息，
/// 替代前端 N+1 次 dbListMsgs（每次 invoke 都有 JSON 序列化开销）。
#[tauri::command]
pub fn load_all() -> Result<LoadAllResult, String> {
    let convs = db::conversations::list_convs()?;
    let mut messages = std::collections::HashMap::new();
    for c in &convs {
        let msgs = db::conversations::list_msgs(&c.id)?;
        messages.insert(
            c.id.clone(),
            msgs.into_iter()
                .map(|m| MsgDto {
                    id: m.id,
                    conv_id: m.conv_id,
                    role: m.role,
                    content: m.content,
                    timestamp: m.timestamp,
                    token_count: m.token_count,
                    model: m.model,
                    reasoning: m.reasoning,
                    seq: m.seq,
                    error: m.error,
                    error_kind: m.error_kind,
                    bookmarked: m.bookmarked,
                })
                .collect(),
        );
    }
    Ok(LoadAllResult {
        conversations: convs
            .into_iter()
            .map(|c| ConvDto {
                id: c.id,
                title: c.title,
                model_name: c.model_name,
                system_prompt: c.system_prompt,
                created_at: c.created_at,
                updated_at: c.updated_at,
                character_id: c.character_id,
                persona_id: c.persona_id,
                summary: c.summary,
                summary_msg_count: c.summary_msg_count,
            })
            .collect(),
        messages,
    })
}

#[tauri::command]
pub fn delete_conv(id: String) -> Result<(), String> {
    db::conversations::delete_conv(&id)
}

#[tauri::command]
pub fn rename_conv(id: String, title: String, updated_at: String) -> Result<(), String> {
    db::conversations::rename_conv(&id, &title, &updated_at)
}

/// 自动记忆:持久化会话摘要 + 摘要时的消息数记账(不重写其他字段)。
#[tauri::command]
pub fn update_conv_summary(
    id: String,
    summary: String,
    summary_msg_count: i64,
    updated_at: String,
) -> Result<(), String> {
    db::conversations::update_conv_summary(&id, &summary, summary_msg_count, &updated_at)
}

#[tauri::command]
pub fn add_msg(msg: MsgDto) -> Result<(), String> {
    db::conversations::add_msg(&db::conversations::Message {
        id: msg.id,
        conv_id: msg.conv_id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        token_count: msg.token_count,
        model: msg.model,
        reasoning: msg.reasoning,
        seq: msg.seq,
        error: msg.error,
        error_kind: msg.error_kind,
        bookmarked: msg.bookmarked,
    })
}

/// 热路径批量化（P1）：一次 IPC 插入用户消息 + N 条 assistant 占位 +
/// 更新会话标题/时间戳，替代 2+2N 次逐条写库往返。
#[tauri::command]
pub fn batch_add_messages(
    conv_id: String,
    msgs: Vec<MsgDto>,
    title: String,
    updated_at: String,
) -> Result<(), String> {
    let list: Vec<db::conversations::Message> = msgs
        .into_iter()
        .map(|msg| db::conversations::Message {
            id: msg.id,
            conv_id: msg.conv_id,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
            token_count: msg.token_count,
            model: msg.model,
            reasoning: msg.reasoning,
            seq: msg.seq,
            error: msg.error,
            error_kind: msg.error_kind,
            bookmarked: msg.bookmarked,
        })
        .collect();
    db::conversations::add_msgs_batch(&conv_id, &list, &title, &updated_at)
}

#[tauri::command]
pub fn list_msgs(conv_id: String) -> Result<Vec<MsgDto>, String> {
    db::conversations::list_msgs(&conv_id).map(|list| {
        list.into_iter()
            .map(|m| MsgDto {
                id: m.id,
                conv_id: m.conv_id,
                role: m.role,
                content: m.content,
                timestamp: m.timestamp,
                token_count: m.token_count,
                model: m.model,
                reasoning: m.reasoning,
                seq: m.seq,
                error: m.error,
                error_kind: m.error_kind,
                bookmarked: m.bookmarked,
            })
            .collect()
    })
}

#[tauri::command]
pub fn update_msg_content(id: String, conv_id: String, content: String) -> Result<(), String> {
    db::conversations::update_msg_content(&id, &conv_id, &content)
}

#[tauri::command]
pub fn update_msg_reasoning(id: String, conv_id: String, reasoning: String) -> Result<(), String> {
    db::conversations::update_msg_reasoning(&id, &conv_id, &reasoning)
}

#[tauri::command]
pub fn update_msg_error(
    id: String,
    conv_id: String,
    error: String,
    error_kind: String,
) -> Result<(), String> {
    db::conversations::update_msg_error(&id, &conv_id, &error, &error_kind)
}

/// 消息书签:切换单条消息的书签状态(长会话快速跳回关键消息)
#[tauri::command]
pub fn set_msg_bookmark(id: String, conv_id: String, bookmarked: bool) -> Result<(), String> {
    db::conversations::set_msg_bookmark(&id, &conv_id, bookmarked)
}

/// 批量删除会话:一次 IPC 删除多个会话及其消息(替代 N 次 `delete_conv` 往返)
#[tauri::command]
pub fn batch_delete_convs(ids: Vec<String>) -> Result<(), String> {
    for id in ids {
        db::conversations::delete_conv(&id)?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_last_asm_msg(conv_id: String) -> Result<(), String> {
    db::conversations::delete_last_asm_msg(&conv_id)
}

#[tauri::command]
pub fn clear_messages(conv_id: String) -> Result<(), String> {
    db::conversations::clear_messages(&conv_id)
}

// ── Models / Settings ────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelDto {
    pub name: String,
    pub provider: String,
    pub api_url: String,
    pub api_key_encrypted: String,
    pub model: String,
    pub params_json: String,
}

#[tauri::command]
pub fn save_model(model: ModelDto) -> Result<(), String> {
    db::settings::save_model(&db::settings::ModelConfig {
        name: model.name,
        provider: model.provider,
        api_url: model.api_url,
        api_key_encrypted: model.api_key_encrypted,
        model: model.model,
        params_json: model.params_json,
    })
}

#[tauri::command]
pub fn list_models() -> Result<Vec<ModelDto>, String> {
    db::settings::list_models().map(|list| {
        list.into_iter()
            .map(|m| ModelDto {
                name: m.name,
                provider: m.provider,
                api_url: m.api_url,
                api_key_encrypted: m.api_key_encrypted,
                model: m.model,
                params_json: m.params_json,
            })
            .collect()
    })
}

#[tauri::command]
pub fn list_models_decrypted() -> Result<Vec<ModelDto>, String> {
    db::settings::list_models_decrypted().map(|list| {
        list.into_iter()
            .map(|m| ModelDto {
                name: m.name,
                provider: m.provider,
                api_url: m.api_url,
                api_key_encrypted: m.api_key_encrypted,
                model: m.model,
                params_json: m.params_json,
            })
            .collect()
    })
}

#[tauri::command]
pub fn delete_model(name: String) -> Result<(), String> {
    db::settings::delete_model(&name)
}

#[tauri::command]
pub fn delete_all_models() -> Result<(), String> {
    db::settings::delete_all_models()
}

#[tauri::command]
pub fn get_setting(key: String) -> Result<String, String> {
    db::settings::get_setting(&key)
}

#[tauri::command]
pub fn save_setting(key: String, value: String) -> Result<(), String> {
    db::settings::save_setting(&key, &value)
}

// ── Skills ───────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct SkillDto {
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
    #[serde(default)]
    pub tools_json: String,
    #[serde(default)]
    pub memory_tags: String,
}

#[tauri::command]
pub fn create_skill(skill: SkillDto) -> Result<(), String> {
    db::skills::create_skill(&db::skills::Skill {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        system_prompt: skill.system_prompt,
        model: skill.model,
        temperature: skill.temperature,
        category: skill.category,
        tags_json: skill.tags_json,
        created_at: skill.created_at,
        updated_at: skill.updated_at,
        tools_json: skill.tools_json,
        memory_tags: skill.memory_tags,
    })
}

#[tauri::command]
pub fn list_skills() -> Result<Vec<SkillDto>, String> {
    db::skills::list_skills().map(|list| {
        list.into_iter()
            .map(|s| SkillDto {
                id: s.id,
                name: s.name,
                description: s.description,
                system_prompt: s.system_prompt,
                model: s.model,
                temperature: s.temperature,
                category: s.category,
                tags_json: s.tags_json,
                created_at: s.created_at,
                updated_at: s.updated_at,
                tools_json: s.tools_json,
                memory_tags: s.memory_tags,
            })
            .collect()
    })
}

#[tauri::command]
pub fn update_skill(skill: SkillDto) -> Result<(), String> {
    db::skills::update_skill(&db::skills::Skill {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        system_prompt: skill.system_prompt,
        model: skill.model,
        temperature: skill.temperature,
        category: skill.category,
        tags_json: skill.tags_json,
        created_at: skill.created_at,
        updated_at: skill.updated_at,
        tools_json: skill.tools_json,
        memory_tags: skill.memory_tags,
    })
}

#[tauri::command]
pub fn delete_skill_cmd(id: String) -> Result<(), String> {
    db::skills::delete_skill(&id)
}
