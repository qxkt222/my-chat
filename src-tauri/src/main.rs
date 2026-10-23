// release 构建不带控制台窗口 —— 必须是 crate 级内部属性（带 !），且必须出现在
// 任何条目之前。原先写成挂在 fn main 上的外部属性，rustc 报 unused_attributes：
// 它作用于函数而非 crate，实际不生效。这条只在 release 构建时出现，
// clippy --all-targets（dev profile）看不到它 —— 所以只有真跑 release 才暴露。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adapters;
mod commands;
mod db;
mod net;
mod rag;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// ── App data dir ──────────────────────────────────────────
fn app_data_dir() -> PathBuf {
    let base = std::env::var("APPDATA").map_or_else(
        |_| {
            let home = std::env::var("USERPROFILE").unwrap_or_default();
            PathBuf::from(home).join("AppData").join("Roaming")
        },
        PathBuf::from,
    );
    base.join("com.my-chat")
}

/// 守卫：把前端传来的路径限制在应用数据目录内。
///
/// 防的不是外部攻击者（本应用不做公网部署），而是**自己代码把路径拼错**：
/// `delete_item` 走的是 `remove_dir_all`，一次误传就是一棵目录树没了，
/// 而且没有任何二次确认。写文件 / 删文件 / 建目录 / 列目录一律先过它。
///
/// 读类命令走 `resolve_readable_path`：应用数据目录内，或用户刚在原生
/// 文件对话框里选过的路径（10 分钟令牌）。导入仍需读桌面/任意盘的文件，
/// 但不再允许前端凭一段字符串读取任意文件。
pub(crate) fn guard_path(raw: &str) -> Result<PathBuf, String> {
    match guard_path_within(&app_data_dir(), raw) {
        Ok(p) => Ok(p),
        Err(msg) => {
            crate::commands::chat::log_chat_error(&msg);
            Err(msg)
        }
    }
}

/// 守卫的纯函数核心：root 可注入，便于用临时目录单测。
///
/// 关键点（RS-13）：目标**不存在**时不能退回纯词法路径 ——
/// `app_data/link-out/new.txt`（`link-out` 是指向外部的目录联接）整串不存在，
/// 词法检查会放行，写入却落到根外。这里改为 canonicalize「最近存在的祖先」
/// 再拼回不存在的尾部，前缀判断始终基于真实路径。
fn guard_path_within(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("应用数据目录不可用: {e}"))?;
    // ⚠️ Windows 的 canonicalize 返回 `\\?\C:\...` 形式的 verbatim 路径，
    //    与普通路径做前缀比较会**假失败**（实测踩过：根内的合法路径被判成越界，
    //    而只测「越界被拒」的话它会假绿通过）。两侧统一剥掉此前缀。
    let root = strip_verbatim(&root);

    // 词法规范化：消掉 "." 与 ".."。不能只靠 `canonicalize` ——
    // `create_dir` 的目标必然不存在，`canonicalize` 会直接失败。
    let norm = lexical_normalize(Path::new(raw));

    let resolved = resolve_via_existing_ancestor(&norm)
        .ok_or_else(|| format!("无法解析路径: {}", norm.display()))?;
    if !resolved.starts_with(&root) {
        return Err(format!(
            "拒绝越界路径（只允许应用数据目录内）: {}",
            norm.display()
        ));
    }
    Ok(norm)
}

/// 词法规范化：消掉 `.` 与 `..`（不访问文件系统）。
fn lexical_normalize(p: &Path) -> PathBuf {
    let mut norm = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                norm.pop();
            }
            other => norm.push(other.as_os_str()),
        }
    }
    norm
}

/// 把「最近存在的祖先目录」canonicalize（解掉符号链接 / 目录联接），
/// 再把尚不存在的尾部原样拼回去。返回的是**真实**路径。
fn resolve_via_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    loop {
        if let Ok(canonical) = std::fs::canonicalize(&cur) {
            let mut resolved = strip_verbatim(&canonical);
            for seg in tail.iter().rev() {
                resolved.push(seg);
            }
            return Some(resolved);
        }
        let name = cur.file_name()?.to_os_string();
        if !cur.pop() {
            return None;
        }
        tail.push(name);
    }
}

/// 写入后复核：写入目标 canonicalize 后再与根比一次，越界就删掉。
///
/// 守卫 + 写入之间仍有 TOCTOU 窗口（祖先目录被换成联接），这一步兜底。
pub(crate) fn verify_write_inside_app_dir(p: &Path) -> Result<(), String> {
    let root =
        std::fs::canonicalize(app_data_dir()).map_err(|e| format!("应用数据目录不可用: {e}"))?;
    let root = strip_verbatim(&root);
    let actual = std::fs::canonicalize(p).map_err(|e| format!("写入后复核失败: {e}"))?;
    let actual = strip_verbatim(&actual);
    if actual.starts_with(&root) {
        return Ok(());
    }
    // 越界：先删真实目标（万一 p 是链接），再删 p 本身。
    let _ = std::fs::remove_file(&actual);
    let _ = std::fs::remove_file(p);
    let msg = format!("写入目标越界，已删除: {}", p.display());
    crate::commands::chat::log_chat_error(&msg);
    Err(msg)
}

/// 剥掉 Windows `canonicalize` 产生的 `\\?\` verbatim 前缀。
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\")
        .map_or_else(|| p.to_path_buf(), PathBuf::from)
}

// ── 读令牌（RS-05）───────────────────────────────────────
//
// 读类命令不再接受任意路径：只认「应用数据目录内」或「用户刚在原生文件
// 对话框里选过、10 分钟内有效」的路径。令牌放在进程内，重启即失效。

/// 对话框选中后的可读窗口。
const READ_TOKEN_TTL: Duration = Duration::from_mins(10);
/// 单文件读取上限。
pub(crate) const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;

static READ_TOKENS: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();

fn read_tokens() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    READ_TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 令牌键：能 canonicalize 就用真实路径（同一文件的不同写法归一）。
fn token_key(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).map_or_else(|_| p.to_path_buf(), |c| strip_verbatim(&c))
}

/// 登记一个用户通过文件对话框选中的路径。
pub(crate) fn register_read_token(path: &Path) {
    let key = token_key(path);
    let mut map = read_tokens()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let now = Instant::now();
    map.retain(|_, at| now.saturating_duration_since(*at) < READ_TOKEN_TTL);
    map.insert(key, now);
}

fn read_token_valid_at(path: &Path, now: Instant) -> bool {
    let key = token_key(path);
    // ⚠️ 只读不清理：清理动作放进 `register_read_token`。这里若按传入的
    //    `now` 做 retain，单测用「未来时刻」验证过期时会顺手删掉并发的有效令牌
    //    （实测过：并行跑测试时互相踩）。
    let map = read_tokens()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    map.get(&key)
        .is_some_and(|at| now.saturating_duration_since(*at) < READ_TOKEN_TTL)
}

/// 读侧准入：应用数据目录内，或持有未过期的对话框令牌。
pub(crate) fn resolve_readable_path(raw: &str) -> Result<PathBuf, String> {
    if guard_path_within(&app_data_dir(), raw).is_ok() {
        return Ok(lexical_normalize(Path::new(raw)));
    }
    let p = PathBuf::from(raw);
    if read_token_valid_at(&p, Instant::now()) {
        return Ok(p);
    }
    Err(format!(
        "拒绝读取未授权路径（需经文件对话框选择，或在应用数据目录内）: {}",
        p.display()
    ))
}

/// 读前体积检查（防止一次 IPC 读进超大文件把内存打满）。
pub(crate) fn check_read_size(path: &Path, limit: u64) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Read error: {e}"))?;
    if !meta.is_file() {
        return Err(format!("不是普通文件: {}", path.display()));
    }
    if meta.len() > limit {
        return Err(format!(
            "文件过大: {} 字节（上限 {} MB）",
            meta.len(),
            limit / (1024 * 1024)
        ));
    }
    Ok(())
}

// ── File system commands ──────────────────────────────────
#[tauri::command]
fn get_app_dir() -> String {
    app_data_dir().to_string_lossy().to_string()
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let p = resolve_readable_path(&path)?;
    check_read_size(&p, MAX_READ_BYTES)?;
    std::fs::read_to_string(&p).map_err(|e| format!("Read error: {e}"))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let p = guard_path(&path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Create dir error: {e}"))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("Write error: {e}"))?;
    verify_write_inside_app_dir(&p)
}

#[tauri::command]
fn delete_item(path: String) -> Result<(), String> {
    let p = guard_path(&path)?;
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("Delete dir error: {e}"))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("Delete file error: {e}"))
    }
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<String>, String> {
    let p = guard_path(&path)?;
    let entries = std::fs::read_dir(&p).map_err(|e| format!("List dir error: {e}"))?;
    let mut result = Vec::new();
    for e in entries.flatten() {
        result.push(e.file_name().to_string_lossy().to_string());
    }
    Ok(result)
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    let p = guard_path(&path)?;
    std::fs::create_dir_all(&p).map_err(|e| format!("Create dir error: {e}"))
}

// ── Entry point ──────────────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // opener：markdown 里的外链改由**系统浏览器**打开。
        // 此前注册的是 shell 插件——前端零引用、capabilities 也没授权，
        // 等于白背一个「能起子进程」的插件，已随本次一并移除。
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            let dir = app_data_dir();
            let _ = std::fs::create_dir_all(dir.join("conversations"));
            let _ = std::fs::create_dir_all(dir.join("skills"));
            let _ = std::fs::create_dir_all(dir.join("knowledge"));
            let _ = std::fs::create_dir_all(dir.join("adapters"));
            // Character cards (角色扮演): card JSON + avatar PNGs
            let _ = std::fs::create_dir_all(dir.join("characters"));
            let _ = std::fs::create_dir_all(dir.join("characters").join("avatars"));
            // Custom RP prompt presets
            let _ = std::fs::create_dir_all(dir.join("presets"));
            // Tavern (酒馆模式) RP conversations — completely separate from the
            // work-mode sled storage, so the two modes never mix.
            let _ = std::fs::create_dir_all(dir.join("tavern"));
            // Simulation (酒馆推演子模式) conversations — separate from tavern RP.
            let _ = std::fs::create_dir_all(dir.join("simulation"));
            // Pending backup restore: MUST run before sled is opened — copying
            // over an open sled (Windows file locks) would corrupt it. On
            // failure keep the marker so the next launch retries, and log why.
            if let Err(e) = commands::backup::run_pending_restore() {
                let _ = std::fs::write(dir.join("restore_error.log"), format!("{e}\n"));
            }
            // Migration rollback: if a previous schema migration failed, restore
            // the pre-migration snapshot (also before sled is opened). Restore
            // runs first so an explicit user restore wins over migration rollback.
            if let Err(e) = db::migration::run_pending_migration_rollback() {
                let _ = std::fs::write(dir.join("migration_error.log"), format!("{e}\n"));
            }
            // Migration preflight: if the schema version is stale, snapshot the
            // sled_db BEFORE it is opened — once open, Windows locks the db files
            // and copying them fails with os error 33. Failure is non-fatal: the
            // migrations themselves are idempotent and can retry next launch.
            if let Err(e) = db::migration::preflight_snapshot() {
                let _ = std::fs::write(dir.join("migration_error.log"), format!("{e}\n"));
            }
            // Open the sled database (embedded KV store); runs schema migrations
            db::init_db()?;
            // Startup self-heal: drop corrupted model records, remap active_model
            let _ = db::settings::sanitize_models();
            // Startup marker: proves this build actually launched (diagnostics)
            let _ = std::fs::write(
                dir.join("startup.marker"),
                format!("started={}\n", chrono_now_secs()),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_dir,
            read_file,
            write_file,
            delete_item,
            list_dir,
            create_dir,
            commands::chat::stream_chat,
            commands::chat::cancel_chat,
            commands::chat::log_diag,
            commands::db::create_conv,
            commands::db::list_convs,
            commands::db::delete_conv,
            commands::db::load_all,
            commands::db::rename_conv,
            commands::db::update_conv_summary,
            commands::db::batch_delete_convs,
            commands::db::set_msg_bookmark,
            commands::db::add_msg,
            commands::db::batch_add_messages,
            commands::db::list_msgs,
            commands::db::update_msg_content,
            commands::db::update_msg_reasoning,
            commands::db::update_msg_error,
            commands::db::delete_last_asm_msg,
            commands::db::clear_messages,
            commands::db::save_model,
            commands::db::list_models,
            commands::db::list_models_decrypted,
            commands::db::delete_model,
            commands::db::delete_all_models,
            commands::db::get_setting,
            commands::db::save_setting,
            commands::db::create_skill,
            commands::db::list_skills,
            commands::db::update_skill,
            commands::db::delete_skill_cmd,
            commands::rag::rag_search,
            commands::rag::rag_rerank,
            commands::rag::rag_index_document,
            commands::rag::rag_index_with_openai,
            commands::rag::delete_kb,
            import_json_data,
            get_db_status,
            commands::backup::create_backup,
            commands::backup::list_backups,
            commands::backup::restore_backup,
            commands::backup::delete_backup,
            commands::backup::webdav_upload,
            commands::mcp::mcp_list_servers,
            commands::mcp::mcp_save_server,
            commands::mcp::mcp_delete_server,
            commands::mcp::mcp_list_tools,
            commands::mcp::mcp_call_tool,
            commands::mcp::mcp_set_permission,
            commands::mcp::mcp_list_permissions,
            commands::mcp::mcp_grant_tool,
            commands::mcp::mcp_revoke_tool,
            commands::mcp::mcp_list_grants,
            commands::mcp::mcp_audit,
            commands::mcp::mcp_resolve_permission,
            commands::docs::pick_file,
            commands::docs::extract_document_text,
            commands::docs::ocr_image,
            commands::memory::mem_list,
            commands::memory::mem_save,
            commands::memory::mem_delete,
            commands::memory::mem_search,
            commands::draw::generate_image,
            commands::card_io::read_file_bytes,
            commands::card_io::write_file_bytes,
            commands::translate::translate_text,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // RS-19: 退出时显式把 sled 内存表刷到磁盘。失败只记日志、不 panic ——
    // 退出路径上的 panic 会给用户弹崩溃窗,而这里最坏只是丢掉最后几秒写入。
    // setup 里 `db::init_db()?` 成功才会走到 `run()`,因此 DB 必已初始化;
    // `db::db()` 不会在这里触发一次新的打开。
    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            match db::db() {
                Ok(db) => {
                    if let Err(e) = db.flush() {
                        crate::commands::chat::log_chat_error(&format!("EXIT_FLUSH: {e}"));
                    }
                }
                Err(e) => {
                    crate::commands::chat::log_chat_error(&format!(
                        "EXIT_FLUSH: 数据库不可用: {e}"
                    ));
                }
            }
        }
    });
}

// ── Database commands ────────────────────────────────────

#[tauri::command]
fn import_json_data() -> Result<db::import::ImportResult, String> {
    db::import::import_all_from_json()
}

#[tauri::command]
#[allow(clippy::unnecessary_wraps)] // Tauri 命令签名强制 Result
fn get_db_status() -> Result<String, String> {
    let path = db::app_db_path();
    let exists = path.exists();
    let file_count = if exists {
        std::fs::read_dir(&path).map_or(0, std::iter::Iterator::count)
    } else {
        0
    };
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "exists": exists,
        "files": file_count,
        "engine": "sled",
        "initialized": true
    })
    .to_string())
}

fn main() {
    run();
}

fn chrono_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod guard_tests {
    use super::*;

    /// 保证根目录存在 —— 否则 `guard_path` 会因 `canonicalize` 失败而报错，
    /// 让「越界被拒」的用例**因为错误的原因**通过（假绿）。
    fn ensure_root() {
        std::fs::create_dir_all(app_data_dir()).expect("创建应用数据目录");
    }

    /// 越界路径必须被拒。
    #[test]
    fn guard_rejects_paths_outside_app_dir() {
        ensure_root();

        let outside = if cfg!(windows) {
            "C:/Windows/System32"
        } else {
            "/etc"
        };
        assert!(
            guard_path(outside).is_err(),
            "应用数据目录之外的绝对路径应被拒绝"
        );

        // 用 .. 从根目录爬出去（app_data_dir/../../.. 落到用户目录）
        let climb = format!("{}/../../..", app_data_dir().to_string_lossy());
        assert!(
            guard_path(&climb).is_err(),
            "含 .. 爬出根目录的路径应被拒绝"
        );
    }

    /// 根目录内的路径必须放行 —— 否则守卫会把正常功能一起挡掉。
    #[test]
    fn guard_allows_paths_inside_app_dir() {
        ensure_root();

        let inside = app_data_dir().join("characters").join("guard-test.json");
        assert!(
            guard_path(inside.to_string_lossy().as_ref()).is_ok(),
            "根目录内的路径应放行"
        );

        // 目标不存在也应放行（create_dir / write_file 的常态）
        let not_yet = app_data_dir().join("nonexistent-dir").join("x.json");
        assert!(
            guard_path(not_yet.to_string_lossy().as_ref()).is_ok(),
            "根目录内尚不存在的路径也应放行"
        );
    }

    // ── 以下用例一律用临时目录，不碰用户数据 ──────────────

    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let p =
            std::env::temp_dir().join(format!("my-chat-test-{tag}-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&p).expect("创建临时目录");
        p
    }

    /// 目标不存在时，越界仍必须被拒（不能退回纯词法路径）。
    #[test]
    fn guard_rejects_nonexistent_target_outside_root() {
        let root = temp_dir("root-a");
        let outside = temp_dir("outside-a");
        let target = outside.join("nope.txt");
        let result = guard_path_within(&root, target.to_string_lossy().as_ref());
        assert!(result.is_err(), "根外不存在的目标应被拒绝");

        // 根内不存在的目标应放行
        let inside = root.join("sub").join("nope.txt");
        assert!(
            guard_path_within(&root, inside.to_string_lossy().as_ref()).is_ok(),
            "根内不存在的目标应放行"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// 目录联接（junction）指向根外时，即使叶子不存在也必须拒绝（RS-13）。
    #[cfg(windows)]
    #[test]
    fn guard_rejects_junction_escape() {
        let root = temp_dir("root-j");
        let outside = temp_dir("outside-j");
        let link = root.join("link-out");

        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .status();
        let created = matches!(&status, Ok(s) if s.success()) && link.exists();
        if !created {
            // 某些环境禁用了 junction：跳过而不是假绿/假红
            eprintln!("跳过：无法创建目录联接");
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }

        let target = link.join("sub").join("new.txt");
        let result = guard_path_within(&root, target.to_string_lossy().as_ref());
        assert!(result.is_err(), "经目录联接逃出根外的路径必须被拒绝");

        // 先删联接本身（remove_dir 只删 reparse point，不递归目标），再清临时目录
        let _ = std::fs::remove_dir(&link);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// 对话框令牌：登记后可用，过期后失效。只碰临时文件。
    #[test]
    fn read_token_expires() {
        let dir = temp_dir("token");
        let file = dir.join("picked.txt");
        std::fs::write(&file, b"x").expect("写临时文件");

        register_read_token(&file);
        let now = Instant::now();
        assert!(read_token_valid_at(&file, now), "刚登记应有效");

        let later = now
            .checked_add(READ_TOKEN_TTL + Duration::from_secs(1))
            .expect("时间加法");
        assert!(!read_token_valid_at(&file, later), "过期后应失效");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 未登记的根外路径读不到；登记后可读。
    #[test]
    fn resolve_readable_path_requires_token_or_app_dir() {
        let dir = temp_dir("read-gate");
        let file = dir.join("secret.txt");
        std::fs::write(&file, b"secret").expect("写临时文件");

        assert!(
            resolve_readable_path(file.to_string_lossy().as_ref()).is_err(),
            "未登记的根外路径应拒绝"
        );

        register_read_token(&file);
        assert!(
            resolve_readable_path(file.to_string_lossy().as_ref()).is_ok(),
            "登记后应放行"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 50 MB 上限的判定逻辑（用极小阈值测，不生成大文件）。
    #[test]
    fn read_size_limit_is_enforced() {
        let dir = temp_dir("size");
        let file = dir.join("small.txt");
        std::fs::write(&file, b"0123456789").expect("写临时文件");

        assert!(check_read_size(&file, 5).is_err(), "超过上限应拒绝");
        assert!(check_read_size(&file, 100).is_ok(), "未超上限应放行");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
