mod adapters;
mod commands;
mod db;
mod plugin;
mod rag;

use std::path::PathBuf;

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
/// 读类命令（`read_file` / `read_file_bytes`）**故意不设限** —— 角色卡、世界书、
/// 预设的导入都要读用户在文件对话框里选的文件（可能在桌面或任何盘），
/// 限制它们会直接废掉导入功能；而读不会毁数据。
pub(crate) fn guard_path(raw: &str) -> Result<PathBuf, String> {
    let root =
        std::fs::canonicalize(app_data_dir()).map_err(|e| format!("应用数据目录不可用: {e}"))?;
    // ⚠️ Windows 的 canonicalize 返回 `\\?\C:\...` 形式的 verbatim 路径，
    //    与普通路径做前缀比较会**假失败**（实测踩过：根内的合法路径被判成越界，
    //    而只测「越界被拒」的话它会假绿通过）。两侧统一剥掉此前缀。
    let root = strip_verbatim(&root);
    let p = PathBuf::from(raw);

    // 词法规范化：消掉 "." 与 ".."。不能只靠 `canonicalize` ——
    // `create_dir` 的目标必然不存在，`canonicalize` 会直接失败。
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

    // 已存在的部分再解一次符号链接，防「链接指向外部」绕过前缀检查
    let resolved =
        std::fs::canonicalize(&norm).map_or_else(|_| norm.clone(), |a| strip_verbatim(&a));
    if !resolved.starts_with(&root) {
        let msg = format!("拒绝越界路径（只允许应用数据目录内）: {}", p.display());
        crate::commands::chat::log_chat_error(&msg);
        return Err(msg);
    }
    Ok(norm)
}

/// 剥掉 Windows `canonicalize` 产生的 `\\?\` verbatim 前缀。
fn strip_verbatim(p: &std::path::Path) -> PathBuf {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\")
        .map_or_else(|| p.to_path_buf(), PathBuf::from)
}

// ── File system commands ──────────────────────────────────
#[tauri::command]
fn get_app_dir() -> String {
    app_data_dir().to_string_lossy().to_string()
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Read error: {e}"))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let p = guard_path(&path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Create dir error: {e}"))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("Write error: {e}"))
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
    tauri::Builder::default()
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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

#[cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
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

        let outside = if cfg!(windows) { "C:/Windows/System32" } else { "/etc" };
        assert!(guard_path(outside).is_err(), "应用数据目录之外的绝对路径应被拒绝");

        // 用 .. 从根目录爬出去（app_data_dir/../../.. 落到用户目录）
        let climb = format!("{}/../../..", app_data_dir().to_string_lossy());
        assert!(guard_path(&climb).is_err(), "含 .. 爬出根目录的路径应被拒绝");
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
}
