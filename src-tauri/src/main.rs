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
    if let Some(parent) = PathBuf::from(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Create dir error: {e}"))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("Write error: {e}"))
}

#[tauri::command]
fn delete_item(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("Delete dir error: {e}"))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("Delete file error: {e}"))
    }
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("List dir error: {e}"))?;
    let mut result = Vec::new();
    for e in entries.flatten() {
        result.push(e.file_name().to_string_lossy().to_string());
    }
    Ok(result)
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("Create dir error: {e}"))
}

// ── Entry point ──────────────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
