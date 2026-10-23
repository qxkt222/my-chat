// commands/backup.rs — Local backup snapshots + WebDAV upload (Cherry data protection)

use std::path::{Path, PathBuf};

/// 本地备份目录的固定前缀（create/list/restore 共用）。
const BACKUP_PREFIX: &str = "my-chat-backup-";
/// 恢复前自动生成的安全快照前缀。它同样以 `BACKUP_PREFIX` 开头，因此也可以
/// 作为一个普通备份被再次恢复。
const PRE_RESTORE_PREFIX: &str = "my-chat-backup-pre-restore-";
/// 恢复前保护性快照只保留最近这么多份，更旧的自动清理。
const PRE_RESTORE_KEEP: usize = 3;
/// `WebDAV` 单次上传的总量上限（2 GiB）。
const MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;

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

/// 毫秒级时间戳：用于保护性快照目录名，避免同一秒内两次恢复撞名后合并目录。
fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Create a full snapshot of the app data dir into `dest_dir\my-chat-backup-<unix>`
#[tauri::command]
pub fn create_backup(dest_dir: String) -> Result<String, String> {
    let dest = PathBuf::from(&dest_dir).join(format!("{BACKUP_PREFIX}{}", unix_secs()));
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
            if !name.starts_with(BACKUP_PREFIX) || !e.path().is_dir() {
                continue;
            }
            let ts: u64 = name.trim_start_matches(BACKUP_PREFIX).parse().unwrap_or(0);
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

/// 校验一个目录确实是本应用生成的备份（RS-08）。
///
/// 旧实现只查 `is_dir()`：任意目录（例如攻击者放置的 `D:\evil\`）都能在下次
/// 启动时整棵覆盖应用数据，从而劫持 `adapters/models` 配置把 API key 外送。
/// 现在要求三点同时成立：
/// 1. canonicalize 成功（路径真实存在，顺带解掉符号链接/目录联接）；
/// 2. 目录名以 `my-chat-backup-` 开头（`create_backup` 的固定命名）；
/// 3. 目录内存在 `sled_db` 或 `schema_version.txt`（本应用数据目录的标记）。
///
/// 另加一条：不能就是应用数据目录本身（否则恢复=自我覆盖，语义也不成立）。
///
/// `app_data` 作为参数注入，便于在临时目录里单测。
fn validate_backup_dir(src: &Path, app_data: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(src)
        .map_err(|e| format!("备份目录不存在或不可访问: {} ({e})", src.display()))?;
    if !canonical.is_dir() {
        return Err(format!("备份路径不是目录: {}", canonical.display()));
    }
    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if !name.starts_with(BACKUP_PREFIX) {
        return Err(format!(
            "拒绝恢复：目录名必须以 {BACKUP_PREFIX} 开头（实际 {name}）"
        ));
    }
    let has_marker =
        canonical.join("sled_db").exists() || canonical.join("schema_version.txt").exists();
    if !has_marker {
        return Err(
            "拒绝恢复：目录内没有 sled_db 或 schema_version.txt，不是本应用的备份".to_string(),
        );
    }
    if let Ok(app_canonical) = std::fs::canonicalize(app_data) {
        if canonical == app_canonical {
            return Err("拒绝恢复：不能从应用数据目录自身恢复".to_string());
        }
    }
    Ok(canonical)
}

/// 恢复前把当前数据目录整棵快照到 `my-chat-backup-pre-restore-<ts>`。
///
/// 放到应用数据目录的**父目录**下：既满足“和备份放一起”的直觉，又避免
/// 快照写进被拷贝的源目录内部造成自我递归。任何失败都向上返回，调用方据此
/// 中止恢复（RS-08：没有退路就不动数据）。
fn snapshot_before_restore(app_data: &Path) -> Result<PathBuf, String> {
    let parent = app_data
        .parent()
        .ok_or_else(|| format!("应用数据目录没有父目录: {}", app_data.display()))?;
    let dest = parent.join(format!("{PRE_RESTORE_PREFIX}{}", unix_millis()));
    copy_dir_all(app_data, &dest).map_err(|e| format!("恢复前快照失败，已中止恢复: {e}"))?;
    // 只保留最近 N 份，避免每次恢复都多留一整棵数据树。清理失败不影响本次恢复。
    prune_snapshots(parent, PRE_RESTORE_KEEP);
    Ok(dest)
}

/// 保护性快照的排序键：`(名称中的 unix 毫秒, 修改时间)`。
///
/// 名称是主序（同一毫秒内多次恢复也能靠 mtime 稳定分出先后）；
/// 名称解析失败时 ts 记为 0，会优先被清理。
fn snapshot_sort_key(path: &Path) -> (u64, std::time::SystemTime) {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let ts = name
        .trim_start_matches(PRE_RESTORE_PREFIX)
        .parse::<u64>()
        .unwrap_or(0);
    let mtime = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH);
    (ts, mtime)
}

/// 清理 `parent` 下旧的保护性快照，只保留最新 `keep` 份，返回实际删除数。
///
/// 只匹配 `my-chat-backup-pre-restore-*` 目录：普通备份（`my-chat-backup-<ts>`）
/// 不受影响。删除失败只记日志、不向上抛出 —— 恢复流程不能因为清理旧快照而中止。
fn prune_snapshots(parent: &Path, keep: usize) -> usize {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return 0;
    };
    let mut snapshots: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(PRE_RESTORE_PREFIX))
        })
        .collect();
    snapshots.sort_by_key(|p| snapshot_sort_key(p));

    let excess = snapshots.len().saturating_sub(keep);
    let mut removed = 0;
    for old in snapshots.into_iter().take(excess) {
        match std::fs::remove_dir_all(&old) {
            Ok(()) => removed += 1,
            Err(e) => crate::commands::chat::log_chat_error(&format!(
                "清理旧快照失败（已忽略）: {} ({e})",
                old.display()
            )),
        }
    }
    removed
}

/// Restore a backup snapshot back into the app data dir (overwrites current data).
///
/// We cannot copy over the sled database while it is open — Windows locks the
/// open tree files and a half-copied sled is corrupt. So this command only
/// writes a pending marker (the backup path) and flushes the db; the actual
/// copy happens on the NEXT startup, in main.rs setup, BEFORE sled is opened.
///
/// 先 flush 再快照，保证快照里是落盘后的最新状态；快照失败则直接中止，
/// 不写 marker（RS-08）。
#[tauri::command]
pub fn restore_backup(backup_dir: String) -> Result<String, String> {
    let app_data = app_data_dir();
    let src = validate_backup_dir(&PathBuf::from(&backup_dir), &app_data)?;

    // Best-effort flush so in-memory state is persisted before the snapshot
    if let Ok(db) = crate::db::db() {
        let _ = db.flush();
    }
    // 恢复会整棵覆盖应用数据：必须先留一份可回退的当前状态。
    let snapshot = snapshot_before_restore(&app_data)?;

    let marker = app_data.join(RESTORE_MARKER);
    std::fs::write(&marker, src.to_string_lossy().as_bytes()).map_err(|e| {
        format!(
            "写入恢复标记失败: {e}（当前数据已快照到 {}）",
            snapshot.display()
        )
    })?;
    Ok(format!(
        "恢复已安排，重启应用后自动完成（当前数据将在重启后覆盖，已快照到 {}）",
        snapshot.display()
    ))
}

const RESTORE_MARKER: &str = "restore_pending.txt";

/// Executed during startup BEFORE the sled database is opened: if a restore
/// marker exists, copy the marked backup over the app data dir, then remove
/// the marker. Safe here because no db handle is open yet.
///
/// marker 本身可被第三方改写，所以启动时**重新校验**一次（RS-08），
/// 不信任写入时刻的检查结果。
pub fn run_pending_restore() -> Result<(), String> {
    let app_data = app_data_dir();
    let marker = app_data.join(RESTORE_MARKER);
    if !marker.exists() {
        return Ok(());
    }
    let src = PathBuf::from(std::fs::read_to_string(&marker).unwrap_or_default());
    let src = match validate_backup_dir(&src, &app_data) {
        Ok(p) => p,
        Err(e) => {
            // Broken/tampered marker — drop it so we don't retry forever
            let _ = std::fs::remove_file(&marker);
            return Err(format!("{e}；待恢复标记已取消"));
        }
    };
    copy_dir_all(&src, &app_data)?;
    let _ = std::fs::remove_file(&marker);
    Ok(())
}

/// 校验 `WebDAV` 端点（RS-18）。
///
/// Basic 认证会把用户名/密码以 base64 明文随每个请求发出去；只有 HTTPS 才能
/// 保证这段凭据不被同网段的人抓包。因此非 `https://` 一律拒绝，**不做**
/// “http 也能用”的兼容。返回去掉尾部 `/` 的基址。
fn validate_webdav_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if !trimmed.to_ascii_lowercase().starts_with("https://") {
        return Err("拒绝上传：WebDAV 地址必须是 https://（Basic 认证不能走明文）".to_string());
    }
    let host = &trimmed["https://".len()..];
    if host.is_empty() || host.starts_with('/') {
        return Err("WebDAV 地址缺少主机名".to_string());
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

/// 上传前总量校验（RS-18）：超过 2 GiB 直接中止，避免把整盘数据灌进云端。
fn check_upload_size(total: u64) -> Result<(), String> {
    if total > MAX_UPLOAD_BYTES {
        return Err(format!(
            "备份总大小 {:.1} MB 超过上限 2 GiB，已中止上传",
            total as f64 / 1_048_576.0
        ));
    }
    Ok(())
}

/// Upload a backup (directory) to a `WebDAV` server: each file inside is PUT to
/// `url/<relative-path>` with basic auth. Files in a folder root are put at the
/// URL root; subdirectories are created implicitly by many servers, but if the
/// server requires them we create them via MKCOL first (best-effort).
///
/// 安全与并发约束（RS-16 / RS-18）：
/// - 只允许 https（Basic 认证不落明文）；
/// - 递归列目录 / 读文件都是同步 IO，全部放进 `spawn_blocking`，不阻塞 runtime；
/// - 上传前统计总字节数，> 2 GiB 中止；
/// - 使用 `crate::net::upload_client()`（10s 建连 / **无总超时** / 不跟随重定向）：
///   2 GiB 单文件 PUT 可能超过 120s，不能被 `client()` 的总超时切断。
#[tauri::command]
pub async fn webdav_upload(
    url: String,
    username: String,
    password: String,
    file_path: String,
) -> Result<(), String> {
    let base = validate_webdav_url(&url)?;
    let client = crate::net::upload_client();

    // 递归列目录 + stat 是同步 IO，挪出 async 线程（RS-16）。
    let root = PathBuf::from(&file_path);
    let (files, total) = tauri::async_runtime::spawn_blocking(move || {
        if !root.is_dir() {
            return Err("备份目录不存在".to_string());
        }
        let mut files: Vec<(PathBuf, String)> = Vec::new();
        let total = collect_files(&root, &root, &mut files)?;
        Ok((files, total))
    })
    .await
    .map_err(|e| format!("扫描备份目录线程错误: {e}"))??;

    if files.is_empty() {
        return Err("备份目录为空".to_string());
    }
    check_upload_size(total)?;

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
        // 整文件读取同样是同步 IO：大备份可能几十 MB，不能卡在 async worker 上。
        let read_path = abs.clone();
        let data = tauri::async_runtime::spawn_blocking(move || {
            std::fs::read(&read_path).map_err(|e| format!("读取 {}: {}", read_path.display(), e))
        })
        .await
        .map_err(|e| format!("读取文件线程错误: {e}"))??;
        let target = format!("{base}/{rel}");
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

/// 递归收集普通文件，返回 `(相对路径, 大小)` 并累计总字节数。
///
/// 用 `DirEntry::file_type()` 而不是 `Path::is_dir()`：后者会跟随符号链接 /
/// 目录联接，备份目录里一旦有指回上层的联接就会无限递归。非普通文件
/// （符号链接、设备文件）直接跳过。
fn collect_files(dir: &Path, root: &Path, out: &mut Vec<(PathBuf, String)>) -> Result<u64, String> {
    let mut total = 0u64;
    for entry in std::fs::read_dir(dir).map_err(|e| format!("扫描 {} 失败: {e}", dir.display()))?
    {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let ty = entry
            .file_type()
            .map_err(|e| format!("读取文件类型失败: {e}"))?;
        let p = entry.path();
        if ty.is_dir() {
            total += collect_files(&p, root, out)?;
        } else if ty.is_file() {
            let size = entry
                .metadata()
                .map_err(|e| format!("读取 {} 元数据失败: {e}", p.display()))?
                .len();
            total += size;
            let rel = p
                .strip_prefix(root)
                .map_err(|e| format!("计算相对路径失败: {e}"))?
                .to_string_lossy()
                .replace('\\', "/");
            out.push((p, rel));
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// 每个测试独立临时目录；`Drop` 时清理。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "mychat-backup-test-{tag}-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).expect("创建临时目录");
            Self(p)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn child(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn make_backup(root: &Path, name: &str, marker: Option<&str>) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).expect("创建备份目录");
        if let Some(m) = marker {
            std::fs::write(dir.join(m), b"1").expect("写标记文件");
        }
        dir
    }

    // ── RS-08 恢复校验 ────────────────────────────────────

    #[test]
    fn valid_backup_dir_passes() {
        let tmp = TempDir::new("valid");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let backup = make_backup(
            tmp.path(),
            "my-chat-backup-1700000000",
            Some("schema_version.txt"),
        );
        let got = validate_backup_dir(&backup, &app_data).expect("合法备份应通过");
        assert_eq!(got, std::fs::canonicalize(&backup).expect("canonicalize"));
        // marker 里写的是 canonical 路径（Windows 上是 `\\?\` 形式）；
        // 启动时把这段路径再喂回校验必须仍然通过。
        assert!(
            validate_backup_dir(&got, &app_data).is_ok(),
            "canonical（verbatim）路径往返校验失败"
        );
    }

    #[test]
    fn sled_db_marker_alone_is_enough() {
        let tmp = TempDir::new("sled");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let backup = make_backup(tmp.path(), "my-chat-backup-1", None);
        std::fs::create_dir_all(backup.join("sled_db")).expect("建 sled_db");
        assert!(validate_backup_dir(&backup, &app_data).is_ok());
    }

    #[test]
    fn arbitrary_directory_is_rejected() {
        let tmp = TempDir::new("arbitrary");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        // 内容看起来像备份，但目录名不是本应用的命名 → 拒绝
        let evil = make_backup(tmp.path(), "my-chat-data-copy", Some("schema_version.txt"));
        let err = validate_backup_dir(&evil, &app_data).expect_err("任意目录必须拒绝");
        assert!(err.contains("my-chat-backup-"), "错误应说明前缀要求: {err}");
    }

    #[test]
    fn backup_without_marker_is_rejected() {
        let tmp = TempDir::new("nomarker");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let empty = make_backup(tmp.path(), "my-chat-backup-2", None);
        let err = validate_backup_dir(&empty, &app_data).expect_err("缺标记必须拒绝");
        assert!(
            err.contains("schema_version.txt"),
            "错误应说明缺标记: {err}"
        );
    }

    #[test]
    fn missing_directory_is_rejected() {
        let tmp = TempDir::new("missing");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let ghost = tmp.child("my-chat-backup-404");
        assert!(validate_backup_dir(&ghost, &app_data).is_err());
    }

    #[test]
    fn app_data_dir_itself_is_rejected() {
        let tmp = TempDir::new("self");
        // 故意让 app data 目录本身也符合“备份”命名与标记，专门验证自我覆盖规则
        let app_data = make_backup(
            tmp.path(),
            "my-chat-backup-self",
            Some("schema_version.txt"),
        );
        let err = validate_backup_dir(&app_data, &app_data).expect_err("不能从自身恢复");
        assert!(err.contains("自身"), "错误应说明自我覆盖: {err}");
    }

    #[test]
    fn snapshot_before_restore_copies_tree_outside_source() {
        let tmp = TempDir::new("snapshot");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(app_data.join("sled_db")).expect("建 sled_db");
        std::fs::write(app_data.join("schema_version.txt"), b"7").expect("写标记");
        std::fs::write(app_data.join("sled_db").join("data.bin"), b"payload").expect("写数据");

        let snap = snapshot_before_restore(&app_data).expect("快照应成功");
        assert_eq!(snap.parent(), Some(tmp.path()), "快照必须在源目录之外");
        let name = snap.file_name().unwrap_or_default().to_string_lossy();
        assert!(
            name.starts_with("my-chat-backup-pre-restore-"),
            "实际命名: {name}"
        );
        assert_eq!(
            std::fs::read(snap.join("sled_db").join("data.bin")).expect("读快照数据"),
            b"payload"
        );
        assert_eq!(
            std::fs::read_to_string(snap.join("schema_version.txt")).expect("读快照标记"),
            "7"
        );
        // 快照目录本身也应该能通过恢复校验
        assert!(validate_backup_dir(&snap, tmp.path()).is_ok());
    }

    #[test]
    fn snapshot_name_uses_millisecond_timestamp() {
        let tmp = TempDir::new("snapshot-ms");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");

        let snap = snapshot_before_restore(&app_data).expect("快照应成功");
        let name = snap.file_name().unwrap_or_default().to_string_lossy();
        let ts: u64 = name
            .trim_start_matches(PRE_RESTORE_PREFIX)
            .parse()
            .expect("快照名后缀应为纯数字时间戳");
        // 秒级时间戳当前约 1.7e9，毫秒级约 1.7e12；> 1e12 即证明粒度是毫秒。
        assert!(ts > 1_000_000_000_000, "快照名应使用毫秒时间戳: {name}");
    }

    // ── RS-18 WebDAV ─────────────────────────────────────

    #[test]
    fn webdav_url_must_be_https() {
        assert!(validate_webdav_url("http://dav.example.com/backup").is_err());
        assert!(validate_webdav_url("ftp://dav.example.com/backup").is_err());
        assert!(validate_webdav_url("dav.example.com/backup").is_err());
        assert!(validate_webdav_url("https:///nohost").is_err());
        assert_eq!(
            validate_webdav_url(" HTTPS://dav.example.com/backup/ ").expect("https 应通过"),
            "HTTPS://dav.example.com/backup"
        );
    }

    #[test]
    fn upload_size_limit_is_2gib() {
        // 只断言常量与边界，不实际分配 2 GiB 内存。
        assert_eq!(
            MAX_UPLOAD_BYTES,
            2 * 1024 * 1024 * 1024,
            "WebDAV 备份上限已定为 2 GiB"
        );
        assert!(check_upload_size(0).is_ok());
        assert!(check_upload_size(MAX_UPLOAD_BYTES - 1).is_ok());
        assert!(
            check_upload_size(MAX_UPLOAD_BYTES).is_ok(),
            "恰好 2 GiB 应放行"
        );
        assert!(check_upload_size(MAX_UPLOAD_BYTES + 1).is_err());
    }

    #[test]
    fn prune_snapshots_keeps_newest_three_and_spares_normal_backups() {
        let tmp = TempDir::new("prune");
        for ts in 1..=5u64 {
            make_backup(
                tmp.path(),
                &format!("{PRE_RESTORE_PREFIX}{ts}"),
                Some("schema_version.txt"),
            );
        }
        let normal = make_backup(
            tmp.path(),
            "my-chat-backup-1700000000",
            Some("schema_version.txt"),
        );

        let removed = prune_snapshots(tmp.path(), PRE_RESTORE_KEEP);

        assert_eq!(removed, 2, "5 份快照只保留 3 份，应删除最旧 2 份");
        let mut left: Vec<String> = std::fs::read_dir(tmp.path())
            .expect("读临时目录")
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(PRE_RESTORE_PREFIX))
            .collect();
        left.sort_unstable();
        assert_eq!(
            left,
            (3..=5)
                .map(|ts| format!("{PRE_RESTORE_PREFIX}{ts}"))
                .collect::<Vec<_>>(),
            "留下的必须是最新的 3 份"
        );
        assert!(normal.is_dir(), "普通备份不能被快照清理误删");
    }

    #[test]
    fn prune_snapshots_is_noop_when_at_or_below_limit() {
        let tmp = TempDir::new("prune-noop");
        for ts in 1..=3u64 {
            make_backup(
                tmp.path(),
                &format!("{PRE_RESTORE_PREFIX}{ts}"),
                Some("schema_version.txt"),
            );
        }
        assert_eq!(prune_snapshots(tmp.path(), PRE_RESTORE_KEEP), 0);
        assert_eq!(
            std::fs::read_dir(tmp.path())
                .expect("读临时目录")
                .flatten()
                .filter(|e| e
                    .file_name()
                    .to_string_lossy()
                    .starts_with(PRE_RESTORE_PREFIX))
                .count(),
            3
        );
    }

    #[test]
    fn collect_files_reports_total_size_and_posix_relative_paths() {
        let tmp = TempDir::new("collect");
        std::fs::create_dir_all(tmp.child("sub")).expect("建子目录");
        std::fs::write(tmp.child("a.bin"), b"12345").expect("写 a");
        std::fs::write(tmp.child("sub").join("b.bin"), b"789").expect("写 b");

        let root = tmp.path();
        let mut files = Vec::new();
        let total = collect_files(root, root, &mut files).expect("扫描应成功");
        assert_eq!(total, 8, "5 + 3 字节");
        assert_eq!(files.len(), 2);
        let mut rels: Vec<&str> = files.iter().map(|(_, r)| r.as_str()).collect();
        rels.sort_unstable();
        assert_eq!(rels, vec!["a.bin", "sub/b.bin"]);
    }
}
