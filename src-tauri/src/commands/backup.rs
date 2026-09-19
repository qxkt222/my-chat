// commands/backup.rs — Local backup snapshots + WebDAV upload (Cherry data protection)

use std::path::{Path, PathBuf};

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

/// Recursively copy a directory tree (source of truth files, no symlink chasing)
pub fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Err(format!("Not a dir: {}", src.display()));
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("Create: {e}"))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("Read: {e}"))? {
        let entry = entry.map_err(|e| format!("Entry: {e}"))?;
        let ty = entry.file_type().map_err(|e| format!("Type: {e}"))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("Copy {}: {}", from.display(), e))?;
        }
    }
    Ok(())
}

fn unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Create a full snapshot of the app data dir into `dest_dir\my-chat-backup-<unix>`
#[tauri::command]
pub fn create_backup(dest_dir: String) -> Result<String, String> {
    let dest = PathBuf::from(&dest_dir).join(format!("my-chat-backup-{}", unix_secs()));
    copy_dir_all(&app_data_dir(), &dest)?;
    Ok(dest.to_string_lossy().to_string())
}

/// List existing backups under `dest_dir` (name, unix seconds, size in MB)
#[tauri::command]
#[allow(clippy::unnecessary_wraps)] // Tauri 命令签名强制 Result
pub fn list_backups(dest_dir: String) -> Result<Vec<serde_json::Value>, String> {
    let root = PathBuf::from(&dest_dir);
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("my-chat-backup-") || !e.path().is_dir() {
                continue;
            }
            let ts: u64 = name
                .trim_start_matches("my-chat-backup-")
                .parse()
                .unwrap_or(0);
            let size = dir_size(&e.path());
            out.push(serde_json::json!({
                "name": name,
                "path": e.path().to_string_lossy().to_string(),
                "ts": ts,
                "size_mb": (size as f64 / 1_048_576.0 * 100.0).round() / 100.0,
            }));
        }
    }
    out.sort_by(|a, b| {
        let ta = a["ts"].as_u64().unwrap_or(0);
        let tb = b["ts"].as_u64().unwrap_or(0);
        tb.cmp(&ta)
    });
    Ok(out)
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(md) = std::fs::metadata(&p) {
                total += md.len();
            }
        }
    }
    total
}

/// Restore a backup snapshot back into the app data dir (overwrites current data).
///
/// We cannot copy over the sled database while it is open — Windows locks the
/// open tree files and a half-copied sled is corrupt. So this command only
/// writes a pending marker (the backup path) and flushes the db; the actual
/// copy happens on the NEXT startup, in main.rs setup, BEFORE sled is opened.
#[tauri::command]
pub fn restore_backup(backup_dir: String) -> Result<String, String> {
    let src = PathBuf::from(&backup_dir);
    if !src.is_dir() {
        return Err("备份目录不存在".to_string());
    }
    // Best-effort flush so in-memory state is persisted before restart
    if let Ok(db) = crate::db::db() {
        let _ = db.flush();
    }
    let marker = app_data_dir().join(RESTORE_MARKER);
    std::fs::write(&marker, backup_dir).map_err(|e| format!("写入恢复标记失败: {e}"))?;
    Ok("恢复已安排，重启应用后自动完成（当前数据将在重启后覆盖）".to_string())
}

const RESTORE_MARKER: &str = "restore_pending.txt";

/// Executed during startup BEFORE the sled database is opened: if a restore
/// marker exists, copy the marked backup over the app data dir, then remove
/// the marker. Safe here because no db handle is open yet.
pub fn run_pending_restore() -> Result<(), String> {
    let marker = app_data_dir().join(RESTORE_MARKER);
    if !marker.exists() {
        return Ok(());
    }
    let src = PathBuf::from(std::fs::read_to_string(&marker).unwrap_or_default());
    if !src.is_dir() {
        // Broken marker — drop it so we don't retry forever
        let _ = std::fs::remove_file(&marker);
        return Err(format!("待恢复目录不存在，已取消恢复: {}", src.display()));
    }
    copy_dir_all(&src, &app_data_dir())?;
    let _ = std::fs::remove_file(&marker);
    Ok(())
}

/// Upload a backup (directory) to a `WebDAV` server: each file inside is PUT to
/// `url/<relative-path>` with basic auth. Files in a folder root are put at the
/// URL root; subdirectories are created implicitly by many servers, but if the
/// server requires them we create them via MKCOL first (best-effort).
#[tauri::command]
pub async fn webdav_upload(
    url: String,
    username: String,
    password: String,
    file_path: String,
) -> Result<(), String> {
    let root = PathBuf::from(&file_path);
    if !root.is_dir() {
        return Err("备份目录不存在".to_string());
    }
    let base = url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();

    let mut files: Vec<(PathBuf, String)> = Vec::new();
    collect_files(&root, &root, &mut files);
    if files.is_empty() {
        return Err("备份目录为空".to_string());
    }

    // Ensure the base directory exists (MKCOL is idempotent-ish; ignore 405/existing)
    let _ = client
        .request(
            reqwest::Method::from_bytes(b"MKCOL").map_err(|e| e.to_string())?,
            &base,
        )
        .basic_auth(&username, Some(&password))
        .send()
        .await;

    for (abs, rel) in files {
        let data = std::fs::read(&abs).map_err(|e| format!("读取 {}: {}", abs.display(), e))?;
        let target = format!("{}/{}", base, rel.replace('\\', "/"));
        let resp = client
            .put(&target)
            .basic_auth(&username, Some(&password))
            .header("Content-Type", "application/octet-stream")
            .body(data)
            .send()
            .await
            .map_err(|e| format!("上传 {rel} 失败: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("上传 {rel} 失败 HTTP {status}: {text}"));
        }
    }
    Ok(())
}

fn collect_files(dir: &Path, root: &Path, out: &mut Vec<(PathBuf, String)>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            let rel = p
                .strip_prefix(root)
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or_default();
            if p.is_dir() {
                collect_files(&p, root, out);
            } else {
                out.push((p, rel));
            }
        }
    }
}
