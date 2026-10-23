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

// ── Key 安全（RS-24）─────────────────────────────────────
//
// 消息键是 `m:{conv_id}:{id}`。若 id 允许 `:`,前缀空间会重叠:
//   conv_id="a",     id="b:c"   → m:a:b:c
//   conv_id="a:b",   id="c"     → m:a:b:c
// 两条消息落到同一个键,后写覆盖先写;`scan_prefix("m:a:")` 还会把
// 属于 conv "a:b" 的消息误算进 conv "a"。写入入口一律只允许
// `[A-Za-z0-9_-]`。读取/删除路径不校验,保证旧键(含 ':')仍可读、可清。

/// 校验新写入的会话/消息 id。只允许 ASCII 字母、数字、`_`、`-`。
fn validate_id(kind: &str, id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err(format!("{kind}不能为空"));
    }
    if id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Ok(());
    }
    Err(format!(
        "非法{kind}「{id}」:只允许 ASCII 字母、数字、下划线、连字符\
         (含 ':' 会与 m:<conv>:<msg> 键前缀冲突)"
    ))
}

// ── Conversations ────────────────────────────────────────

pub fn create_conv(c: &Conversation) -> Result<(), String> {
    validate_id("会话 id", &c.id)?;
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
    validate_id("会话 id", id)?;
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
    validate_id("会话 id", id)?;
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
    // 先校验再碰 DB:非法 id 直接拒绝,不产生歧义键
    validate_id("会话 id", &m.conv_id)?;
    validate_id("消息 id", &m.id)?;
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
    validate_id("会话 id", conv_id)?;
    for m in msgs {
        validate_id("会话 id", &m.conv_id)?;
        validate_id("消息 id", &m.id)?;
    }
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
    validate_id("会话 id", conv_id)?;
    validate_id("消息 id", id)?;
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
    validate_id("会话 id", conv_id)?;
    validate_id("消息 id", id)?;
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
    validate_id("会话 id", conv_id)?;
    validate_id("消息 id", id)?;
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
    validate_id("会话 id", conv_id)?;
    validate_id("消息 id", id)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(conv_id: &str, id: &str) -> Message {
        Message {
            id: id.to_string(),
            conv_id: conv_id.to_string(),
            role: "user".to_string(),
            content: "hi".to_string(),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            token_count: 1,
            model: String::new(),
            reasoning: String::new(),
            seq: 0,
            error: String::new(),
            error_kind: String::new(),
            bookmarked: false,
        }
    }

    // 校验必须发生在 `tree()` 之前,所以这些用例不碰全局 DB。
    #[test]
    fn rejects_colon_in_conv_id() {
        let err = add_msg(&msg("a:b", "m1")).expect_err("conv_id 含 ':' 必须拒绝");
        assert!(err.contains("非法"), "{err}");
    }

    #[test]
    fn rejects_colon_in_msg_id() {
        let err = add_msg(&msg("conv1", "m:1")).expect_err("msg_id 含 ':' 必须拒绝");
        assert!(err.contains("非法"), "{err}");
    }

    #[test]
    fn rejects_colon_in_batch_before_db() {
        let msgs = vec![msg("conv1", "m1"), msg("conv1", "m:2")];
        let err = add_msgs_batch("conv1", &msgs, "t", "2026-01-01T00:00:00Z")
            .expect_err("批量写入中任一 id 非法必须整批拒绝");
        assert!(err.contains("非法"), "{err}");
    }

    #[test]
    fn rejects_colon_in_create_conv() {
        let conv = Conversation {
            id: "a:b".to_string(),
            title: "t".to_string(),
            model_name: "m".to_string(),
            system_prompt: String::new(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            character_id: String::new(),
            persona_id: String::new(),
            summary: String::new(),
            summary_msg_count: 0,
        };
        assert!(create_conv(&conv).is_err(), "会话 id 含 ':' 必须拒绝");
    }

    #[test]
    fn accepts_uuid_and_plain_ids() {
        for id in [
            uuid::Uuid::new_v4().to_string(),
            "2f1c_9a-7B".to_string(),
            "abc123".to_string(),
        ] {
            assert!(validate_id("消息 id", &id).is_ok(), "合法 id 被拒: {id}");
        }
    }

    #[test]
    fn rejects_empty_and_non_ascii_ids() {
        assert!(validate_id("消息 id", "").is_err());
        assert!(validate_id("消息 id", "消息1").is_err());
        assert!(validate_id("消息 id", "a b").is_err());
        assert!(validate_id("消息 id", "a/b").is_err());
    }
}
