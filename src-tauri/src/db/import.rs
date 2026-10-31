// db/import.rs — JSON → Sled migration

use crate::db::{conversations, encryption, settings, skills};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportResult {
    pub conversations: usize,
    pub skills: usize,
    pub models: usize,
    pub templates: usize,
    pub knowledge_bases: usize,
    /// T-041：逐项失败原因（旧实现从不写入，坏项完全静默）
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
    /// 旧 JSON 没有这个字段：默认 false（升级后不在对话模式出现）
    #[serde(default)]
    lite_enabled: bool,
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

/// 导入落点：生产实现写 sled；单测用假实现验证「计数只算成功项、失败进 errors」。
trait ImportTarget {
    fn create_conv(&self, c: &conversations::Conversation) -> Result<(), String>;
    fn add_msg(&self, m: &conversations::Message) -> Result<(), String>;
    fn create_skill(&self, s: &skills::Skill) -> Result<(), String>;
    fn save_model(&self, m: &settings::ModelConfig) -> Result<(), String>;
    fn save_setting(&self, key: &str, value: &str) -> Result<(), String>;
}

struct SledTarget;

impl ImportTarget for SledTarget {
    fn create_conv(&self, c: &conversations::Conversation) -> Result<(), String> {
        conversations::create_conv(c)
    }
    fn add_msg(&self, m: &conversations::Message) -> Result<(), String> {
        conversations::add_msg(m)
    }
    fn create_skill(&self, s: &skills::Skill) -> Result<(), String> {
        skills::create_skill(s)
    }
    fn save_model(&self, m: &settings::ModelConfig) -> Result<(), String> {
        settings::save_model(m)
    }
    fn save_setting(&self, key: &str, value: &str) -> Result<(), String> {
        settings::save_setting(key, value)
    }
}

#[allow(clippy::unnecessary_wraps)] // 调用方预期 Result 接口
pub fn import_all_from_json() -> Result<ImportResult, String> {
    import_all_from_json_at(&app_data_dir(), &SledTarget)
}

/// [`import_all_from_json`] 的可测核心。
///
/// T-041：旧实现先 `+= 1` 再看 `.ok()`，失败项照样计数、`errors` 永远是空。
/// 现在每一项失败都带文件/记录标识进 `errors`，计数只在写入成功后增加。
#[allow(clippy::unnecessary_wraps)] // 与公开入口保持同一 Result 形状
fn import_all_from_json_at(dir: &Path, target: &dyn ImportTarget) -> Result<ImportResult, String> {
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
        match std::fs::read_dir(&cd) {
            Ok(entries) => {
                for e in entries {
                    let entry = match e {
                        Ok(e) => e,
                        Err(err) => {
                            r.errors
                                .push(format!("读取会话目录项失败（{}）: {err}", cd.display()));
                            continue;
                        }
                    };
                    let p = entry.path();
                    if p.extension().is_none_or(|x| x != "json") {
                        continue;
                    }
                    let raw = match std::fs::read_to_string(&p) {
                        Ok(s) => s,
                        Err(err) => {
                            r.errors.push(format!("读取失败（{}）: {err}", p.display()));
                            continue;
                        }
                    };
                    let jc = match serde_json::from_str::<JsonConv>(&raw) {
                        Ok(j) => j,
                        Err(err) => {
                            r.errors.push(format!("解析失败（{}）: {err}", p.display()));
                            continue;
                        }
                    };
                    let JsonConv {
                        id,
                        title,
                        created_at,
                        updated_at,
                        messages,
                    } = jc;
                    let up = if updated_at.is_empty() {
                        created_at.clone()
                    } else {
                        updated_at
                    };
                    let c = conversations::Conversation {
                        id: id.clone(),
                        title,
                        model_name: String::new(),
                        system_prompt: String::new(),
                        created_at,
                        updated_at: up,
                        character_id: String::new(),
                        persona_id: String::new(),
                        summary: String::new(),
                        summary_msg_count: 0,
                        // 旧 JSON 没有子模式概念 → 归到工作列表（不消失、不改变行为）
                        work_mode: conversations::default_work_mode(),
                    };
                    if let Err(err) = target.create_conv(&c) {
                        // 典型：旧 JSON 的会话 id 含 ':'，被键安全校验拒绝
                        r.errors
                            .push(format!("导入会话「{id}」失败（{}）: {err}", p.display()));
                        continue;
                    }
                    for (mi, m) in messages.into_iter().enumerate() {
                        let mid = if m.id.is_empty() {
                            uuid::Uuid::new_v4().to_string()
                        } else {
                            m.id
                        };
                        let msg = conversations::Message {
                            id: mid.clone(),
                            conv_id: id.clone(),
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
                        };
                        if let Err(err) = target.add_msg(&msg) {
                            r.errors
                                .push(format!("导入会话「{id}」的消息「{mid}」失败: {err}"));
                        }
                    }
                    r.conversations += 1;
                }
            }
            Err(err) => r
                .errors
                .push(format!("读取会话目录失败（{}）: {err}", cd.display())),
        }
    }

    let sd = dir.join("skills");
    if sd.exists() {
        match std::fs::read_dir(&sd) {
            Ok(entries) => {
                for e in entries {
                    let entry = match e {
                        Ok(e) => e,
                        Err(err) => {
                            r.errors
                                .push(format!("读取技能目录项失败（{}）: {err}", sd.display()));
                            continue;
                        }
                    };
                    let p = entry.path();
                    if p.extension().is_none_or(|x| x != "json") {
                        continue;
                    }
                    let raw = match std::fs::read_to_string(&p) {
                        Ok(s) => s,
                        Err(err) => {
                            r.errors.push(format!("读取失败（{}）: {err}", p.display()));
                            continue;
                        }
                    };
                    let js = match serde_json::from_str::<JsonSkill>(&raw) {
                        Ok(j) => j,
                        Err(err) => {
                            r.errors.push(format!("解析失败（{}）: {err}", p.display()));
                            continue;
                        }
                    };
                    let id = js.id.clone();
                    let skill = skills::Skill {
                        id,
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
                        lite_enabled: js.lite_enabled,
                    };
                    match target.create_skill(&skill) {
                        Ok(()) => r.skills += 1,
                        Err(err) => r.errors.push(format!(
                            "导入技能「{}」失败（{}）: {err}",
                            skill.id,
                            p.display()
                        )),
                    }
                }
            }
            Err(err) => r
                .errors
                .push(format!("读取技能目录失败（{}）: {err}", sd.display())),
        }
    }

    let sp = dir.join("settings.json");
    if sp.exists() {
        let parsed = std::fs::read_to_string(&sp)
            .map_err(|err| format!("读取失败（{}）: {err}", sp.display()))
            .and_then(|raw| {
                serde_json::from_str::<JsonSettings>(&raw)
                    .map_err(|err| format!("解析失败（{}）: {err}", sp.display()))
            });
        match parsed {
            Ok(s) => {
                for m in s.models {
                    let name = m.name.clone();
                    let mc = settings::ModelConfig {
                        name,
                        provider: String::new(),
                        api_url: m.api_url,
                        // 加密失败留空 key（该模型需重新填），失败原因已由 encryption 层落盘
                        api_key_encrypted: encryption::encrypt(&m.api_key)
                            .map_or_else(|_| String::new(), |e| format!("ENC:{e}")),
                        model: m.model,
                        params_json: String::new(),
                        api_key_locked: false,
                    };
                    match target.save_model(&mc) {
                        Ok(()) => r.models += 1,
                        Err(err) => r.errors.push(format!("导入模型「{}」失败: {err}", mc.name)),
                    }
                }
                if let Err(err) = target.save_setting("active_model", &s.active_model) {
                    r.errors.push(format!("保存 active_model 失败: {err}"));
                }
            }
            Err(err) => r.errors.push(err),
        }
    }

    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("mychat-import-{tag}-{}", uuid::Uuid::new_v4()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("创建临时目录");
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 假落点：id 命中 `reject` 时失败，并记录成功写入的条目。
    #[derive(Default)]
    struct FakeTarget {
        reject: Vec<String>,
        written: RefCell<Vec<String>>,
    }

    impl FakeTarget {
        fn check(&self, kind: &str, id: &str) -> Result<(), String> {
            if self.reject.iter().any(|r| r == id) {
                return Err(format!("注入的{kind}写入失败"));
            }
            self.written.borrow_mut().push(id.to_string());
            Ok(())
        }
    }

    impl ImportTarget for FakeTarget {
        fn create_conv(&self, c: &conversations::Conversation) -> Result<(), String> {
            self.check("会话", &c.id)
        }
        fn add_msg(&self, m: &conversations::Message) -> Result<(), String> {
            self.check("消息", &m.id)
        }
        fn create_skill(&self, s: &skills::Skill) -> Result<(), String> {
            self.check("技能", &s.id)
        }
        fn save_model(&self, m: &settings::ModelConfig) -> Result<(), String> {
            self.check("模型", &m.name)
        }
        fn save_setting(&self, _key: &str, _value: &str) -> Result<(), String> {
            Ok(())
        }
    }

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).expect("建目录");
        std::fs::write(path, content).expect("写文件");
    }

    /// T-041 核心契约：计数只算成功项，坏项（解析失败/写入失败）进 errors。
    #[test]
    fn counts_only_successes_and_reports_each_failure() {
        let tmp = TempDir::new("mixed");
        let dir = &tmp.0;

        write(
            &dir.join("conversations/good.json"),
            r#"{"id":"c1","title":"t","created_at":"2026-01-01","messages":[
                {"id":"m1","role":"user","content":"hi","timestamp":"2026-01-01"}]}"#,
        );
        write(
            &dir.join("conversations/rejected.json"),
            r#"{"id":"bad","title":"t","created_at":"2026-01-01","messages":[]}"#,
        );
        write(&dir.join("conversations/broken.json"), "{not json");

        write(
            &dir.join("skills/good-skill.json"),
            r#"{"id":"s1","name":"n","description":"d","systemPrompt":"p","model":"m",
                "temperature":null,"category":"c","created_at":"2026-01-01","updated_at":"2026-01-01"}"#,
        );
        write(
            &dir.join("skills/rejected-skill.json"),
            r#"{"id":"s-bad","name":"n","description":"d","systemPrompt":"p","model":"m",
                "temperature":null,"category":"c","created_at":"2026-01-01","updated_at":"2026-01-01"}"#,
        );

        write(
            &dir.join("settings.json"),
            r#"{"active_model":"g1","models":[
                {"name":"g1","api_url":"https://x.invalid/v1","api_key":"","model":"m"},
                {"name":"m-bad","api_url":"https://x.invalid/v1","api_key":"","model":"m"}]}"#,
        );

        let target = FakeTarget {
            reject: vec!["bad".to_string(), "s-bad".to_string(), "m-bad".to_string()],
            written: RefCell::new(Vec::new()),
        };
        let r = import_all_from_json_at(dir, &target).expect("导入接口本身不应整体失败");

        assert_eq!(r.conversations, 1, "被拒/损坏的会话不得计数");
        assert_eq!(r.skills, 1, "被拒的技能不得计数");
        assert_eq!(r.models, 1, "被拒的模型不得计数");
        assert_eq!(
            r.errors.len(),
            4,
            "坏 JSON + 被拒会话 + 被拒技能 + 被拒模型 = 4 条: {:?}",
            r.errors
        );
        for needle in [
            "broken.json",
            "会话「bad」",
            "技能「s-bad」",
            "模型「m-bad」",
        ] {
            assert!(
                r.errors.iter().any(|e| e.contains(needle)),
                "errors 应包含 {needle}: {:?}",
                r.errors
            );
        }
    }

    /// 目录不存在/为空：返回零计数与空 errors，不 panic。
    #[test]
    fn empty_dir_yields_zero_counts() {
        let tmp = TempDir::new("empty");
        let target = FakeTarget::default();
        let r = import_all_from_json_at(&tmp.0, &target).expect("空目录应正常返回");
        assert_eq!((r.conversations, r.skills, r.models), (0, 0, 0));
        assert!(r.errors.is_empty(), "{:?}", r.errors);
    }
}
