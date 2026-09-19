// db/conversations.rs — Conversations & messages (sled key-value)

use super::{key, scan_prefix, tree};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub model_name: String,
    pub system_prompt: String,
    pub created_at: String,
    pub updated_at: String,
    /// Bound character card id (角色扮演). Empty for normal chats.
    #[serde(default)]
    pub character_id: String,
    /// Bound persona id (用户扮演). Empty = use the global active persona.
    #[serde(default)]
    pub persona_id: String,
    /// Auto memory summary (工作/酒馆自动记忆). Missing in old data → "".
    #[serde(default)]
    pub summary: String,
    /// Message count at last auto-summary (记账:距上次总结新增消息数).
    /// Missing in old data → 0 (首次触发总结).
    #[serde(default)]
    pub summary_msg_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Message {
    pub id: String,
    pub conv_id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
    pub token_count: i64,
    /// Model that produced this message (empty for user/system). Missing in old data → ""
    #[serde(default)]
    pub model: String,
    /// Thinking/reasoning text from reasoning models (`DeepSeek` v4 etc.)
    #[serde(default)]
    pub reasoning: String,
    /// Monotonic per-conversation insertion order. Timestamps alone are not
    /// enough: the N assistant messages of a 一问多答 turn are created within
    /// the same millisecond, so (timestamp) sorting jumbles their order after
    /// restart. Missing in old data → 0 (falls back to timestamp ordering).
    #[serde(default)]
    pub seq: i64,
    /// Stream/request error text for failed assistant messages. Kept separate
    /// from `content` so a failure banner can be rendered without polluting
    /// the message body. Missing in old data → "".
    #[serde(default)]
    pub error: String,
    /// Error classification (错误命名化): `rate_limit` / timeout / auth /
    /// overload / rejected / unknown. Missing in old data → "".
    #[serde(default)]
    pub error_kind: String,
    /// Message bookmark (消息书签): 长会话标记关键消息. Missing in old data → false.
    #[serde(default)]
    pub bookmarked: bool,
}

// ── Conversations ────────────────────────────────────────

pub fn create_conv(c: &Conversation) -> Result<(), String> {
    let t = tree("conversations")?;
    t.insert(
        key("c", &c.id),
        serde_json::to_vec(c).map_err(|e| format!("Ser: {e}"))?,
    )
    .map_err(|e| format!("Insert: {e}"))?;
    Ok(())
}

pub fn list_convs() -> Result<Vec<Conversation>, String> {
    let t = tree("conversations")?;
    let mut list = Vec::new();
    for (_, v) in scan_prefix(&t, "c:") {
        if let Ok(c) = serde_json::from_slice::<Conversation>(&v) {
            list.push(c);
        }
    }
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(list)
}

pub fn update_conv(id: &str, title: &str, updated_at: &str) -> Result<(), String> {
    let t = tree("conversations")?;
    if let Some(raw) = t.get(key("c", id)).map_err(|e| format!("Get: {e}"))? {
        let mut c: Conversation = serde_json::from_slice(&raw).map_err(|e| format!("De: {e}"))?;
        c.title = title.to_string();
        c.updated_at = updated_at.to_string();
        t.insert(
            key("c", id),
            serde_json::to_vec(&c).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Update: {e}"))?;
    }
    Ok(())
}

pub fn delete_conv(id: &str) -> Result<(), String> {
    let t = tree("conversations")?;
    t.remove(key("c", id)).map_err(|e| format!("Del: {e}"))?;
    // Delete associated messages
    let tm = tree("messages")?;
    for (k, _) in scan_prefix(&tm, &format!("m:{id}:")) {
        tm.remove(k).ok();
    }
    Ok(())
}

pub fn rename_conv(id: &str, title: &str, updated_at: &str) -> Result<(), String> {
    update_conv(id, title, updated_at)
}

/// Persist the auto-memory summary + the message count it was computed from.
/// Read-modify-write (like `update_conv`), so it never clobbers other fields.
pub fn update_conv_summary(
    id: &str,
    summary: &str,
    summary_msg_count: i64,
    updated_at: &str,
) -> Result<(), String> {
    let t = tree("conversations")?;
    if let Some(raw) = t.get(key("c", id)).map_err(|e| format!("Get: {e}"))? {
        let mut c: Conversation = serde_json::from_slice(&raw).map_err(|e| format!("De: {e}"))?;
        c.summary = summary.to_string();
        c.summary_msg_count = summary_msg_count;
        c.updated_at = updated_at.to_string();
        t.insert(
            key("c", id),
            serde_json::to_vec(&c).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Update: {e}"))?;
    }
    Ok(())
}

// ── Messages ─────────────────────────────────────────────

pub fn add_msg(m: &Message) -> Result<(), String> {
    let t = tree("messages")?;
    let k = format!("m:{}:{}", m.conv_id, m.id);
    t.insert(
        k.as_bytes(),
        serde_json::to_vec(m).map_err(|e| format!("Ser: {e}"))?,
    )
    .map_err(|e| format!("Insert: {e}"))?;
    Ok(())
}

/// Insert many messages of one conversation in a single call, then update the
/// conversation's title (first user message seeds it, like the frontend's
/// per-message path) and `updated_at`. This is the hot path for sending a
/// message (user msg + N assistant placeholders = 1 IPC instead of 2+2N).
pub fn add_msgs_batch(
    conv_id: &str,
    msgs: &[Message],
    title: &str,
    updated_at: &str,
) -> Result<(), String> {
    let t = tree("messages")?;
    // Same auto-title rule as the frontend single-add path: only seed the
    // title when this conversation had NO messages before this batch.
    let was_empty = t
        .scan_prefix(format!("m:{conv_id}:").as_bytes())
        .next()
        .is_none();
    for m in msgs {
        let k = format!("m:{}:{}", m.conv_id, m.id);
        t.insert(
            k.as_bytes(),
            serde_json::to_vec(m).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Insert: {e}"))?;
    }
    // Update the conversation record (title + updated_at) so the sidebar order
    // and auto-title stay in sync — same semantics as the single-add path.
    let tc = tree("conversations")?;
    if let Some(raw) = tc.get(key("c", conv_id)).map_err(|e| format!("Get: {e}"))? {
        let mut c: Conversation = serde_json::from_slice(&raw).map_err(|e| format!("De: {e}"))?;
        if was_empty {
            let seed = msgs
                .iter()
                .find(|m| m.role == "user")
                .map_or("", |m| m.content.as_str());
            let trimmed = seed.trim();
            if !trimmed.is_empty() {
                let mut s = trimmed.chars().take(50).collect::<String>();
                if trimmed.chars().count() > 50 {
                    s.push('…');
                }
                c.title = s;
            }
        } else {
            c.title = title.to_string();
        }
        c.updated_at = updated_at.to_string();
        tc.insert(
            key("c", conv_id),
            serde_json::to_vec(&c).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Update: {e}"))?;
    }
    Ok(())
}

pub fn list_msgs(conv_id: &str) -> Result<Vec<Message>, String> {
    let t = tree("messages")?;
    let mut list = Vec::new();
    for (_, v) in scan_prefix(&t, &format!("m:{conv_id}:")) {
        if let Ok(m) = serde_json::from_slice::<Message>(&v) {
            list.push(m);
        }
    }
    list.sort_by(|a, b| a.timestamp.cmp(&b.timestamp).then(a.seq.cmp(&b.seq)));
    Ok(list)
}

pub fn update_msg_content(id: &str, conv_id: &str, content: &str) -> Result<(), String> {
    let t = tree("messages")?;
    let k = format!("m:{conv_id}:{id}");
    if let Some(raw) = t.get(k.as_bytes()).map_err(|e| format!("Get: {e}"))? {
        let mut m: Message = serde_json::from_slice(&raw).map_err(|e| format!("De: {e}"))?;
        m.content = content.to_string();
        t.insert(
            k.as_bytes(),
            serde_json::to_vec(&m).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Update: {e}"))?;
    }
    Ok(())
}

pub fn update_msg_reasoning(id: &str, conv_id: &str, reasoning: &str) -> Result<(), String> {
    let t = tree("messages")?;
    let k = format!("m:{conv_id}:{id}");
    if let Some(raw) = t.get(k.as_bytes()).map_err(|e| format!("Get: {e}"))? {
        let mut m: Message = serde_json::from_slice(&raw).map_err(|e| format!("De: {e}"))?;
        m.reasoning = reasoning.to_string();
        t.insert(
            k.as_bytes(),
            serde_json::to_vec(&m).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Update: {e}"))?;
    }
    Ok(())
}

/// Persist the stream/request error of an assistant message (separate from
/// content, so a failure banner survives restart without polluting the body).
/// `error_kind` classifies the failure (`rate_limit/timeout/auth`/…).
pub fn update_msg_error(
    id: &str,
    conv_id: &str,
    error: &str,
    error_kind: &str,
) -> Result<(), String> {
    let t = tree("messages")?;
    let k = format!("m:{conv_id}:{id}");
    if let Some(raw) = t.get(k.as_bytes()).map_err(|e| format!("Get: {e}"))? {
        let mut m: Message = serde_json::from_slice(&raw).map_err(|e| format!("De: {e}"))?;
        m.error = error.to_string();
        m.error_kind = error_kind.to_string();
        t.insert(
            k.as_bytes(),
            serde_json::to_vec(&m).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Update: {e}"))?;
    }
    Ok(())
}

/// Toggle a message bookmark (消息书签): mark key messages for quick jumps.
pub fn set_msg_bookmark(id: &str, conv_id: &str, bookmarked: bool) -> Result<(), String> {
    let t = tree("messages")?;
    let k = format!("m:{conv_id}:{id}");
    if let Some(raw) = t.get(k.as_bytes()).map_err(|e| format!("Get: {e}"))? {
        let mut m: Message = serde_json::from_slice(&raw).map_err(|e| format!("De: {e}"))?;
        m.bookmarked = bookmarked;
        t.insert(
            k.as_bytes(),
            serde_json::to_vec(&m).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("Update: {e}"))?;
    }
    Ok(())
}

pub fn delete_last_asm_msg(conv_id: &str) -> Result<(), String> {
    let msgs = list_msgs(conv_id)?;
    if let Some(last) = msgs.iter().rev().find(|m| m.role == "assistant") {
        let t = tree("messages")?;
        let k = format!("m:{}:{}", conv_id, last.id);
        t.remove(k.as_bytes()).map_err(|e| format!("Del: {e}"))?;
    }
    Ok(())
}

/// Remove all messages of a conversation (context compression keeps only a summary)
pub fn clear_messages(conv_id: &str) -> Result<(), String> {
    let t = tree("messages")?;
    for (k, _) in scan_prefix(&t, &format!("m:{conv_id}:")) {
        t.remove(k).map_err(|e| format!("Del: {e}"))?;
    }
    Ok(())
}
