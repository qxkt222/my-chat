// commands/backup.rs — Local backup snapshots + WebDAV upload (Cherry data protection)

use crate::db::{SLED_IMPORT_PENDING, STARTUP_ERROR_LOG};
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
/// `WebDAV` 单文件上限（1 GiB）。
///
/// 与总量上限分开限制（T-049）：改成流式 body 后内存不再是瓶颈，但一个超大
/// 文件仍会长时间独占一次 PUT、失败重传成本也高，因此保留明确上限。
const MAX_SINGLE_FILE_BYTES: u64 = 1024 * 1024 * 1024;
/// 目录扫描的最大递归深度。正常备份远低于它，用于给异常目录树兜底（T-050）。
const MAX_SCAN_DEPTH: usize = 64;
/// v1（旧格式）备份必须齐全的关键目录。
///
/// 旧版 `create_backup` 整目录复制时按 `read_dir` 顺序拷贝，被 sled 文件锁
/// 打断的半成品可能已经拷到 `sled_db/db`、却还没拷到 `characters/`、
/// `presets/`。只凭 `sled_db/db` 会把这种备份当成完整备份恢复，用户数据
/// 静默缺失（T-045）。
const V1_REQUIRED_DIRS: &[&str] = &["characters", "presets"];

// ── 备份格式 v2 ──────────────────────────────────────────
//
// v1 = 整棵 app data 目录复制（含 `sled_db/`）。问题：应用运行中 sled 对
// `sled_db` 内的文件持有字节范围锁，`std::fs::copy` 必然
// `os error 33（另一个程序已锁定文件的一部分）`。用户实测点「立即备份」即失败。
//
// v2 = 其余文件照旧复制，**跳过 `sled_db/`**，改用 `sled::Db::export()` 的逻辑导出
// 落成 JSON。恢复时把该 JSON 放成待导入文件，下次启动在 sled 打开后、迁移前导入空库。

/// v2 备份根目录里的格式标记，内容为 [`BACKUP_FORMAT_V2`]。
/// v1 备份没有这个文件（但有 `sled_db/`），据此区分。
const BACKUP_FORMAT_FILE: &str = "backup_format.txt";
const BACKUP_FORMAT_V2: &str = "2";
/// v2 备份内 sled 逻辑导出的文件名。
const SLED_EXPORT_FILE: &str = "sled_db.export.json";
/// sled 数据目录名（v1 备份会整目录复制它）。
const SLED_DB_DIR: &str = "sled_db";
/// `sled_db/` 内的默认树数据文件。
///
/// sled 0.34 打开库时，`conf` 与 `blobs/` 会先于它落盘；只有 `db` 出现才说明
/// 默认树真的写入了。旧版 `create_backup` 被文件锁打断时，留下的正是
/// 「只有 `conf`、没有 `db`」的半成品 —— 恢复它只会覆盖 `conf`，不覆盖 `db`。
const SLED_DB_DATA_FILE: &str = "db";

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
    copy_dir_all_excluding(src, dst, &[])
}

/// 同 [`copy_dir_all`]，但跳过 `src` **顶层**名为 `skip` 中任一项的条目。
///
/// v2 备份用它跳过 `sled_db`：运行中的 sled 对库文件持有字节范围锁，整目录复制
/// 必然 `os error 33`。只匹配顶层，避免误伤子目录里同名的用户数据。
fn copy_dir_all_excluding(src: &Path, dst: &Path, skip: &[&str]) -> Result<(), String> {
    if !src.is_dir() {
        return Err(format!("Not a dir: {}", src.display()));
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("Create: {e}"))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("Read: {e}"))? {
        let entry = entry.map_err(|e| format!("Entry: {e}"))?;
        let name = entry.file_name();
        if skip
            .iter()
            .any(|s| name.as_os_str() == std::ffi::OsStr::new(s))
        {
            continue;
        }
        let ty = entry.file_type().map_err(|e| format!("Type: {e}"))?;
        let from = entry.path();
        let to = dst.join(&name);
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
///
/// `dest_dir` 必须真实存在，且不能是应用数据目录或其子孙（T-043）：旧实现
/// 不做校验，用户选中 `%APPDATA%/com.my-chat` 后备份会把备份目录再拷进源
/// 目录，自我递归复制直到路径超长/磁盘写满。同一秒内的多次备份用序号后缀
/// 区分，每份备份由 [`create_backup_from`] 原子占位（T-044）。
#[tauri::command]
pub fn create_backup(dest_dir: String) -> Result<String, String> {
    create_backup_at(&PathBuf::from(&dest_dir), &app_data_dir())
}

/// [`create_backup`] 的可测核心：校验目标目录并生成唯一的备份目录名。
fn create_backup_at(dest_dir: &Path, app_data: &Path) -> Result<String, String> {
    let dest_root = validate_backup_dest(dest_dir, app_data)?;
    let dest = unique_backup_dest(&dest_root, unix_secs());
    // 运行中也能备份：sled 部分走逻辑导出，不碰被锁的物理文件。
    let db = crate::db::db()?;
    create_backup_from(db, app_data, &dest)?;
    Ok(dest.to_string_lossy().to_string())
}

/// 校验备份目标目录：必须真实存在、是目录，且不在应用数据目录内部。
///
/// canonicalize 顺带解掉 `..`、符号链接与目录联接，比较基于解析后的真实
/// 路径 —— 否则 `dest/../com.my-chat` 这类写法能绕过检查。
fn validate_backup_dest(dest_dir: &Path, app_data: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(dest_dir).map_err(|e| {
        format!(
            "备份目标目录不存在或不可访问: {} ({e})；请选择一个已存在的目录",
            dest_dir.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!("备份目标是文件而不是目录: {}", canonical.display()));
    }
    if let Some(app) = resolve_app_data(app_data) {
        // 逐组件前缀比较：目标在 app data 内部（含自身）都会自我递归。
        if canonical == app || canonical.starts_with(&app) {
            return Err(format!(
                "拒绝备份：不能把备份写进应用数据目录或其子目录（{}）。\
                 那会把备份目录再拷进源目录，自我递归直到磁盘写满；请改选其它目录",
                canonical.display()
            ));
        }
    }
    Ok(canonical)
}

/// 选一个尚未占用的备份目录名：`my-chat-backup-<secs>`，同秒冲突追加
/// `-2`、`-3`…。
///
/// 这里只是选名字；真正的占位由 [`create_backup_from`] 的 `create_dir`
/// 原子完成。并发下两个调用可能选中同一名字，后者会得到「目标目录已存在」
/// 而不会覆盖已有备份。
fn unique_backup_dest(root: &Path, secs: u64) -> PathBuf {
    let base = format!("{BACKUP_PREFIX}{secs}");
    let mut candidate = root.join(&base);
    let mut seq = 2u32;
    while candidate.exists() {
        candidate = root.join(format!("{base}-{seq}"));
        seq += 1;
    }
    candidate
}

/// 从备份目录名解析时间戳，容忍同秒序号后缀（`...-1700000000-2`）。
/// 解析不出数字（例如 pre-restore 快照）时返回 0。
fn backup_ts_from_name(name: &str) -> u64 {
    name.trim_start_matches(BACKUP_PREFIX)
        .split('-')
        .next()
        .and_then(|d| d.parse().ok())
        .unwrap_or(0)
}

/// v2 备份核心（可测：注入 db 与目录，不依赖真实 `APPDATA`）。
///
/// 产物结构：
/// ```text
/// my-chat-backup-<unix>/
///   backup_format.txt      # "2"（v1 无此文件）
///   sled_db.export.json    # sled 逻辑导出
///   <其余 app data 文件>     # 不含 sled_db/
/// ```
///
/// 失败即**整目录删除**：半截备份比没有备份更危险 —— 它看起来像一个可恢复目录，
/// 但可能缺 `sled_db.export.json`，恢复后就是空库。
///
/// 只有**本次原子创建出来**的目录才会在失败时删除：`dest` 已存在（同秒撞名、
/// 或调用方指向一份已有备份）时直接拒绝，绝不往已有备份里合并文件，也绝不
/// 在失败时删掉别人的目录（T-044）。
pub fn create_backup_from(db: &sled::Db, app_dir: &Path, dest: &Path) -> Result<(), String> {
    claim_and_run(dest, |dest| write_backup_v2(db, app_dir, dest))
}

/// 原子占位 + 失败清理的核心：只有本次 `create_dir` 成功的目录才允许删除。
fn claim_and_run(dest: &Path, run: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
    if let Err(e) = std::fs::create_dir(dest) {
        return Err(format!(
            "备份目标目录已存在或无法创建，拒绝覆盖: {} ({e})",
            dest.display()
        ));
    }
    let result = run(dest);
    if result.is_err() {
        discard_partial_backup(dest);
    }
    result
}

fn write_backup_v2(db: &sled::Db, app_dir: &Path, dest: &Path) -> Result<(), String> {
    copy_dir_all_excluding(app_dir, dest, &[SLED_DB_DIR])?;
    let export = crate::db::export_all(db);
    let json = serde_json::to_vec(&export).map_err(|e| format!("序列化 sled 导出失败: {e}"))?;
    std::fs::write(dest.join(SLED_EXPORT_FILE), json)
        .map_err(|e| format!("写 {SLED_EXPORT_FILE}: {e}"))?;
    // 格式标记最后写：它存在即代表本次备份已完整落盘。
    std::fs::write(dest.join(BACKUP_FORMAT_FILE), BACKUP_FORMAT_V2)
        .map_err(|e| format!("写 {BACKUP_FORMAT_FILE}: {e}"))?;
    Ok(())
}

/// best-effort 删除半截备份目录。删不掉只记日志（原始错误更值得上报）。
fn discard_partial_backup(dest: &Path) {
    if let Err(e) = std::fs::remove_dir_all(dest) {
        // 从未创建过（例如复制第一步就失败）不算问题，不刷日志。
        if dest.exists() {
            crate::commands::chat::log_chat_error(&format!(
                "清理失败的备份目录失败（已忽略）: {} ({e})",
                dest.display()
            ));
        }
    }
}

/// List existing backups under `dest_dir` (name, unix seconds, size in MB)
///
/// 递归统计大小是同步 IO：备份多、单份大时会在 async worker 上跑很久，旧实现
/// 直接卡住 runtime 让 UI 冻结。现在整体挪进 `spawn_blocking`（T-050）。
#[tauri::command]
pub async fn list_backups(dest_dir: String) -> Result<Vec<serde_json::Value>, String> {
    let root = PathBuf::from(dest_dir);
    tauri::async_runtime::spawn_blocking(move || list_backups_at(&root))
        .await
        .map_err(|e| format!("扫描备份目录线程错误: {e}"))
}

/// [`list_backups`] 的可测核心（同步扫描，调用方负责放到阻塞线程）。
fn list_backups_at(root: &Path) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            // `file_type()` 不跟随符号链接/目录联接；`path().is_dir()` 会跟随。
            let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
            if !name.starts_with(BACKUP_PREFIX) || !is_dir {
                continue;
            }
            let ts = backup_ts_from_name(&name);
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
    out
}

/// 目录总大小（字节）。
///
/// 用 `DirEntry::file_type()` 判目录：它不跟随符号链接/目录联接。旧实现的
/// `Path::is_dir()` 会跟随，备份目录里一旦有指回上层的 junction 就无限递归
/// 直到爆栈（T-050）；另有深度上限兜底。
fn dir_size(dir: &Path) -> u64 {
    dir_size_at(dir, 0)
}

fn dir_size_at(dir: &Path, depth: usize) -> u64 {
    if depth >= MAX_SCAN_DEPTH {
        return 0;
    }
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            let Ok(ty) = e.file_type() else { continue };
            if ty.is_dir() {
                total += dir_size_at(&p, depth + 1);
            } else if ty.is_file() {
                total += e.metadata().map_or(0, |md| md.len());
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
/// 3. 目录内有**数据库本体**的标记：v2 的 `sled_db.export.json`（文件），
///    或 v1 的 `sled_db/db`（文件）。
///
/// v1 判据曾经只看 `sled_db/` 是否是目录，太松：旧版 `create_backup` 被 sled
/// 文件锁打断时，留下的目录里只有 `conf` 和空的 `blobs/`，没有 `db`。恢复这种
/// 目录时整目录复制只会覆盖 `conf`，不会覆盖 `db`，等于一次**静默的空操作**，
/// 用户却以为恢复成功。因此判据落在真正承载数据的 `db` 文件上。
///
/// `schema_version.txt` 曾经也被当作标记，已移除：它是复制顺序里较早出现的普通
/// 文件，一次半截 v1 复制完全可能"已拷到它、还没拷到 `sled_db/`"，那样会被当成
/// 合法备份恢复成**空库**。判据必须落在数据本身上。
///
/// 另加一条：不能就是应用数据目录本身（否则恢复=自我覆盖，语义也不成立）。
///
/// v1 还要求关键目录齐全（T-045）：旧版整目录复制被中断时，可能已经拷到
/// `sled_db/db`、却还没拷到 `characters/`、`presets/`。只凭数据库文件会把它
/// 当成完整备份恢复，用户数据静默缺失。
///
/// `app_data` 作为参数注入，便于在临时目录里单测。恢复与 `WebDAV` 上传共用
/// 本校验（T-048）。
fn validate_backup_dir(src: &Path, app_data: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(src)
        .map_err(|e| format!("备份目录不存在或不可访问: {} ({e})", src.display()))?;
    if !canonical.is_dir() {
        return Err(format!("备份路径不是目录: {}", canonical.display()));
    }
    // 自我覆盖/自我上传：先于内容检查，避免「缺 db」之类的误导性错误。
    if let Some(app_canonical) = resolve_app_data(app_data) {
        if canonical == app_canonical {
            return Err("拒绝：不能使用应用数据目录自身作为备份".to_string());
        }
    }
    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if !name.starts_with(BACKUP_PREFIX) {
        return Err(format!(
            "拒绝：目录名必须以 {BACKUP_PREFIX} 开头（实际 {name}）"
        ));
    }
    let has_v2 = canonical.join(SLED_EXPORT_FILE).is_file();
    let sled_db_dir = canonical.join(SLED_DB_DIR);
    let has_v1 = sled_db_dir.join(SLED_DB_DATA_FILE).is_file();
    if !has_v2 && !has_v1 {
        // `sled_db/` 存在但缺 `db`：典型的「旧版备份被文件锁打断」半成品。
        // 单独给出可操作的错误，而不是笼统的「不是本应用的备份」。
        if sled_db_dir.is_dir() {
            return Err(format!(
                "拒绝：旧格式备份缺少 {SLED_DB_DIR}/{SLED_DB_DATA_FILE}，\
                 可能是不完整备份（备份中断或被文件锁打断）。请改用应用内\
                 「立即备份」重新生成一份，或手工确认该目录内含数据库文件"
            ));
        }
        return Err(format!(
            "拒绝：目录内既没有 {SLED_EXPORT_FILE}，也没有 {SLED_DB_DIR}/ \
             {SLED_DB_DATA_FILE}，不是本应用的备份"
        ));
    }
    // v1 完整性：数据库文件在、但关键目录不在，就是复制中途被打断的半成品。
    if has_v1 && !has_v2 {
        let missing: Vec<&str> = V1_REQUIRED_DIRS
            .iter()
            .copied()
            .filter(|d| !canonical.join(d).is_dir())
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "拒绝：旧格式（v1）备份不完整，缺少关键目录 {}。\
                 这类备份通常是复制到一半被中断；请改用应用内「立即备份」\
                 重新生成，或在确认备份完整后手工补齐这些目录再试",
                missing.join("、")
            ));
        }
    }
    Ok(canonical)
}

/// 恢复前把当前数据目录快照到 `my-chat-backup-pre-restore-<ts>`。
///
/// 放到应用数据目录的**父目录**下：既满足“和备份放一起”的直觉，又避免
/// 快照写进被拷贝的源目录内部造成自我递归。任何失败都向上返回，调用方据此
/// 中止恢复（RS-08：没有退路就不动数据）。
///
/// 与 `create_backup` 用同一套 v2 逻辑（跳过被锁的 `sled_db`、改用逻辑导出）——
/// 否则恢复前快照会在 DB 打开状态下踩同一个 `os error 33`，把恢复整个卡死。
/// `db` 显式注入，便于在临时库上验证。
fn snapshot_before_restore(app_data: &Path, db: &sled::Db) -> Result<PathBuf, String> {
    let parent = app_data
        .parent()
        .ok_or_else(|| format!("应用数据目录没有父目录: {}", app_data.display()))?;
    let dest = parent.join(format!("{PRE_RESTORE_PREFIX}{}", unix_millis()));
    create_backup_from(db, app_data, &dest)
        .map_err(|e| format!("恢复前快照失败，已中止恢复: {e}"))?;
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

/// 恢复前确认没有待执行的迁移回滚（两个 marker 互斥）。
///
/// 迁移回滚标记存在时，`run_pending_restore` 之后紧接着的
/// `run_pending_migration_rollback` 会把旧库装回 `sled_db`，与恢复留下的
/// `SLED_IMPORT_PENDING` 组成「非空库 + pending」—— 导入被拒后 marker 已被删，
/// 只剩 pending，此后每次启动都会失败。因此宁可晚一轮恢复，也不能交叉。
fn ensure_no_migration_pending_at(app_data: &Path) -> Result<(), String> {
    let marker = app_data.join(MIGRATION_MARKER);
    if marker.exists() {
        return Err(format!(
            "检测到未完成的数据库迁移回滚（{}），已拒绝恢复以免两套待办标记交叉；请先重启应用让回滚完成后再试",
            marker.display()
        ));
    }
    Ok(())
}

/// Restore a backup snapshot back into the app data dir (overwrites current data).
///
/// We cannot copy over the sled database while it is open — Windows locks the
/// open tree files and a half-copied sled is corrupt. So this command only
/// writes a pending marker (the backup path); the actual copy happens on the
/// NEXT startup, in main.rs setup, BEFORE sled is opened.
///
/// **快照不在这里拍**：安排恢复与真正覆盖之间应用仍在运行，用户可能继续使用
/// 数小时；此刻的快照会漏掉这段窗口内新增的数据，而覆盖会把它删掉。保护快照
/// 改在启动期、覆盖前的那一刻拍（[`run_pending_restore`]），拿到的才是真正
/// 将被覆盖的当前库。
#[tauri::command]
pub fn restore_backup(backup_dir: String) -> Result<String, String> {
    let app_data = app_data_dir();
    // 数据仍在运行中的库内；先尽力落盘，确保重启时快照拿到的是最新状态。
    // （这不是快照，只是把已写入的数据持久化。）
    let db = crate::db::db()?;
    let _ = db.flush();
    schedule_restore_at(&app_data, &PathBuf::from(&backup_dir))
}

/// [`restore_backup`] 的可测核心：只校验并写 marker —— 不拍快照、不动数据。
fn schedule_restore_at(app_data: &Path, backup_dir: &Path) -> Result<String, String> {
    // 恢复 × 迁移回滚的交叉会让应用此后每次启动都失败：先拒绝，再动任何数据。
    ensure_no_migration_pending_at(app_data)?;
    let src = validate_backup_dir(backup_dir, app_data)?;
    let marker = app_data.join(RESTORE_MARKER);
    std::fs::write(&marker, src.to_string_lossy().as_bytes())
        .map_err(|e| format!("写入恢复标记失败: {e}"))?;
    Ok(
        "恢复已安排，重启应用后自动完成（重启时会先为当前数据生成保护快照，再执行覆盖）"
            .to_string(),
    )
}

/// 删除一个备份目录（普通备份或恢复前的保护快照）。
///
/// 安全边界比 [`validate_backup_dir`] 更严 —— 恢复有快照兜底，删除不可逆：
/// 1. `canonicalize` 成功且是目录：顺带解掉 `..`、符号链接与目录联接，
///    后续判断都基于**解析后的真实路径**；
/// 2. 目录名必须以 `my-chat-backup-` 开头。`PRE_RESTORE_PREFIX` 也以它开头，
///    所以普通备份与 pre-restore 快照都能删，任意用户目录不能；
/// 3. 不能是应用数据目录本身，也不能是它的**祖先** —— 否则
///    `delete_backup("C:\\")` 这类调用会连用户数据一起删光；
/// 4. 只删这个目录本身（`remove_dir_all` 的目标就是它），不会向外部递归。
#[tauri::command]
pub fn delete_backup(backup_dir: String) -> Result<(), String> {
    delete_backup_at(&PathBuf::from(&backup_dir), &app_data_dir())
}

/// [`delete_backup`] 的可测核心（`app_data` 注入，便于临时目录单测）。
fn delete_backup_at(target: &Path, app_data: &Path) -> Result<(), String> {
    let canonical = std::fs::canonicalize(target)
        .map_err(|e| format!("备份目录不存在或不可访问: {} ({e})", target.display()))?;
    if !canonical.is_dir() {
        return Err(format!("备份路径不是目录: {}", canonical.display()));
    }
    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if !name.starts_with(BACKUP_PREFIX) {
        return Err(format!(
            "拒绝删除：目录名必须以 {BACKUP_PREFIX} 开头（实际 {name}）"
        ));
    }
    if let Some(app_canonical) = resolve_app_data(app_data) {
        if canonical == app_canonical {
            return Err("拒绝删除：不能删除应用数据目录自身".to_string());
        }
        // 逐组件前缀比较：目标若是 app data 的祖先，删除会连用户数据一起丢掉。
        if app_canonical.starts_with(&canonical) {
            return Err(format!(
                "拒绝删除：{} 是应用数据目录的上级，删除会连带用户数据",
                canonical.display()
            ));
        }
    }
    std::fs::remove_dir_all(&canonical)
        .map_err(|e| format!("删除备份失败: {} ({e})", canonical.display()))
}

/// 解析应用数据目录的真实路径，**不要求它已存在**。
///
/// 全新安装时 `com.my-chat` 可能还没建出来；此时若直接 `canonicalize(app_data)`
/// 失败并跳过祖先检查，一个名字恰好带备份前缀的上级目录就能被删掉。
/// 退路是规范化父目录再拼上末段名字 —— APPDATA 本身几乎总是存在的。
fn resolve_app_data(app_data: &Path) -> Option<PathBuf> {
    if let Ok(p) = std::fs::canonicalize(app_data) {
        return Some(p);
    }
    let parent = std::fs::canonicalize(app_data.parent()?).ok()?;
    Some(parent.join(app_data.file_name()?))
}

const RESTORE_MARKER: &str = "restore_pending.txt";

/// 迁移回滚待办标记（`db::migration` 在迁移前快照后写入、迁移成功后删除）。
///
/// 与恢复交叉会让启动序变成「restore 删库并挂 pending → rollback 把旧库装回」，
/// 结果是「非空库 + pending」；两个 marker 随后被删，pending 却还在，
/// 此后每次启动都导入失败。两个标记必须互斥：恢复只要看到它就拒绝。
const MIGRATION_MARKER: &str = "migration_pending.txt";

/// 恢复时**不得**用备份里的副本覆盖的易失文件（只匹配 app data 顶层名）。
///
/// - `chat_errors.log`：本机实时诊断日志。备份里是导出那一刻的旧副本，覆盖它
///   会把备份之后产生的日志整段吞掉（实测：mtime 倒退、19:13–19:28 记录丢失）。
/// - `startup.marker`：本次启动的证据，覆盖等于伪造启动时间。
/// - `restore_pending.txt`：恢复待办标记。从备份拷回来会让下次启动再次执行恢复。
/// - `sled_import.pending.json`：sled 导入待办标记。同上，会让下次启动再次导入。
/// - `migration_error.log` / `restore_error.log` / `startup_error.log`：启动期故障
///   现场。被旧副本覆盖后，本次迁移/恢复失败的原因就查不到了。
/// - `migration_pending.txt`：迁移回滚待办标记。从备份拷回来会让下次启动对旧快照
///   再跑一次无效回滚（校验通常拒绝，但会留下误导性的错误日志）。
///
/// 备份侧（[`write_backup_v2`]）不排除这些文件 —— 日志留在备份里对排障有用，
/// 只是恢复时忽略它们。
const VOLATILE_FILES: &[&str] = &[
    "chat_errors.log",
    "startup.marker",
    RESTORE_MARKER,
    SLED_IMPORT_PENDING,
    "migration_error.log",
    "restore_error.log",
    STARTUP_ERROR_LOG,
    MIGRATION_MARKER,
];

/// Executed during startup BEFORE the sled database is opened: if a restore
/// marker exists, snapshot the CURRENT data, then apply the marked backup to
/// the app data dir, then remove the marker.
///
/// - v2 备份（有 `sled_db.export.json`）：其余文件照抄，旧 `sled_db` 清空，
///   导出文件改名成待导入标记 —— 由 `db` 的启动导入流程在 sled 打开后导入。
/// - v1 备份（`sled_db/db` 存在、无 `sled_db.export.json`）：整目录复制，
///   此时文件未被锁，安全。
///
/// marker 本身可被第三方改写，所以启动时**重新校验**一次（RS-08），
/// 不信任写入时刻的检查结果。
///
/// 保护快照也在这里拍：[`snapshot_before_pending_restore`]。用户点「恢复」只写
/// marker；从那一刻到真正覆盖之间应用仍可继续使用，这段窗口内新增的数据只有
/// 覆盖前的最后一刻才完整。快照失败即中止并保留 marker —— 没有回滚点绝不覆盖。
pub fn run_pending_restore() -> Result<(), String> {
    run_pending_restore_at(&app_data_dir())
}

/// 启动期、真正覆盖之前，为**当前**数据拍保护快照。
///
/// 此时全局 DB 尚未打开（`db::db()` 不可用），所以这里临时 `sled::open` 当前
/// `sled_db` 做 v2 逻辑导出，随后立刻 drop：Windows 上句柄不释放，下一步
/// `restore_v2_from` rename 旧库必然失败。导出前 flush，保证快照是最新状态。
///
/// 任何失败都向上返回，调用方中止恢复并保留 marker（RS-08：没有退路就不动数据）。
fn snapshot_before_pending_restore(app_data: &Path) -> Result<PathBuf, String> {
    let db_dir = app_data.join(SLED_DB_DIR);
    let db = sled::open(&db_dir).map_err(|e| {
        format!(
            "恢复前快照失败：无法打开当前数据库 {} 以生成保护快照（{e}）；\
             已中止恢复，当前数据未改动，待恢复标记已保留，修正后重启会重试",
            db_dir.display()
        )
    })?;
    // Best-effort flush：快照里应是落盘后的最新状态。
    let _ = db.flush();
    let snapshot = snapshot_before_restore(app_data, &db)
        .map_err(|e| format!("{e}；当前数据未改动，待恢复标记已保留，修正后重启会重试"))?;
    // 必须在 restore_v2_from rename 旧库之前关闭句柄。
    drop(db);
    Ok(snapshot)
}

/// [`run_pending_restore`] 的可测核心（`app_data` 注入，便于临时目录单测）。
///
/// 若同时存在迁移回滚标记，则**推迟**本次恢复并返回 Err：标记保留，
/// 待 `run_pending_migration_rollback` 清掉迁移标记后的下一次启动再执行。
fn run_pending_restore_at(app_data: &Path) -> Result<(), String> {
    let marker = app_data.join(RESTORE_MARKER);
    if !marker.exists() {
        return Ok(());
    }
    ensure_no_migration_pending_at(app_data)?;
    let src = PathBuf::from(std::fs::read_to_string(&marker).unwrap_or_default());
    let src = match validate_backup_dir(&src, app_data) {
        Ok(p) => p,
        Err(e) => {
            // Broken/tampered marker — drop it so we don't retry forever
            let _ = std::fs::remove_file(&marker);
            return Err(format!("{e}；待恢复标记已取消"));
        }
    };
    // 覆盖前先为「当前」数据留退路：安排恢复之后新增的数据也在这里面。
    // 失败则整个恢复中止（marker 保留），绝不无快照覆盖。
    snapshot_before_pending_restore(app_data)?;
    if src.join(SLED_EXPORT_FILE).is_file() {
        // v2：sled 部分是逻辑导出，必须先把旧库清空再挂上待导入文件。
        restore_v2_from(&src, app_data)?;
    } else {
        // v1：整目录复制（含 `sled_db/`）。此刻 DB 尚未打开，文件没被锁，安全。
        // 走到这里说明 `validate_backup_dir` 已确认 `sled_db/db` 存在 —— 不存在
        // 的半成品在上面就被拒了，不会出现「只覆盖 conf、不覆盖 db」的空操作。
        restore_v1_from(&src, app_data)?;
    }
    let _ = std::fs::remove_file(&marker);
    Ok(())
}

/// v1 恢复核心（可测）：先复制其余文件，再把旧 `sled_db` 整体换掉。
///
/// 旧实现直接整目录覆盖：备份里没有的旧段文件、旧 `conf` 会和恢复出来的库
/// 混在一起（T-046）。现在与 v2 一样先把旧库 rename 开，再复制备份的
/// `sled_db/`；复制失败则删掉半成品并把旧库 rename 回来，旧数据完好。
/// 易失文件与本机运行状态绑定，仍跳过、不覆盖。
fn restore_v1_from(src: &Path, app_data: &Path) -> Result<(), String> {
    let parked = app_data.join(format!("{SLED_DB_DIR}.restore-old-{}", unix_millis()));
    restore_v1_with(src, app_data, &parked)
}

fn restore_v1_with(src: &Path, app_data: &Path, parked: &Path) -> Result<(), String> {
    let mut skip: Vec<&str> = vec![SLED_DB_DIR];
    skip.extend_from_slice(VOLATILE_FILES);
    copy_dir_all_excluding(src, app_data, &skip)?;

    let db_dir = app_data.join(SLED_DB_DIR);
    let had_db = db_dir.exists();
    if had_db {
        std::fs::rename(&db_dir, parked)
            .map_err(|e| format!("挪开旧库失败（现有数据未改动）: {e}"))?;
    }
    if let Err(e) = copy_dir_all(&src.join(SLED_DB_DIR), &db_dir) {
        let _ = std::fs::remove_dir_all(&db_dir);
        if had_db {
            let _ = std::fs::rename(parked, &db_dir);
        }
        return Err(format!("复制 v1 数据库失败，已恢复旧库: {e}"));
    }
    if had_db {
        let _ = std::fs::remove_dir_all(parked);
    }
    Ok(())
}

/// v2 恢复核心（可测：注入备份目录与应用数据目录）。
///
/// 顺序是安全性的核心（T-047）：
/// 1. 先解析导出 JSON —— 坏文件在**动旧库之前**就失败；
/// 2. 把旧 `sled_db` **rename** 开（同卷原子，不会拷到一半失败）—— 必须在
///    覆盖文件之前：这样 rename 失败时文件与 DB 都还是原样，「现有数据未改动」
///    才与事实一致。旧实现先覆盖文件再 rename，失败文案说未改动，实际文件
///    已经换了一半；
/// 3. 复制其余文件（跳过 `sled_db/` 与两个 v2 专用文件）；
/// 4. 写待导入文件；失败则把旧库 rename 回来并报告真实状态；
/// 5. 删除挪开的旧库。
///
/// 这里的删除是安全的：`sled::Db::import` 对已存在的 key 会 panic，所以导入目标
/// 必须是空库；删除发生在 DB 尚未打开的启动早期，且保护快照已先生成。
fn restore_v2_from(src: &Path, app_data: &Path) -> Result<(), String> {
    let parked = app_data.join(format!("{SLED_DB_DIR}.restore-old-{}", unix_millis()));
    restore_v2_with(src, app_data, &parked)
}

fn restore_v2_with(src: &Path, app_data: &Path, parked: &Path) -> Result<(), String> {
    let export_bytes = std::fs::read(src.join(SLED_EXPORT_FILE))
        .map_err(|e| format!("读取 {SLED_EXPORT_FILE} 失败（未改动现有数据）: {e}"))?;
    crate::db::parse_export(&export_bytes)
        .map_err(|e| format!("备份内 sled 导出不可用，已中止恢复（未改动现有数据）: {e}"))?;

    let db_dir = app_data.join(SLED_DB_DIR);
    let had_db = db_dir.exists();
    if had_db {
        std::fs::rename(&db_dir, parked)
            .map_err(|e| format!("挪开旧库失败（现有数据未改动）: {e}"))?;
    }

    // 除 v2 专用文件外，还要跳过易失文件：备份里的旧日志/启动标记不该覆盖本机，
    // 待办标记被拷回更会触发循环恢复。
    let mut skip: Vec<&str> = vec![SLED_DB_DIR, SLED_EXPORT_FILE, BACKUP_FORMAT_FILE];
    skip.extend_from_slice(VOLATILE_FILES);
    if let Err(e) = copy_dir_all_excluding(src, app_data, &skip) {
        // 旧库还没被删、也没被新内容覆盖：rename 回来即可。
        if had_db {
            let _ = std::fs::rename(parked, &db_dir);
        }
        return Err(format!(
            "复制备份文件失败，已把旧数据库放回（已覆盖的文件可能来自本次备份）: {e}"
        ));
    }

    if let Err(e) = std::fs::write(app_data.join(SLED_IMPORT_PENDING), &export_bytes) {
        if had_db {
            let _ = std::fs::rename(parked, &db_dir);
        }
        return Err(format!("写待导入数据失败，已恢复旧库: {e}"));
    }
    if had_db {
        let _ = std::fs::remove_dir_all(parked);
    }
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

/// 单文件上限（T-049）：与总量上限分别限制。
fn check_single_file_size(size: u64, name: &str) -> Result<(), String> {
    if size > MAX_SINGLE_FILE_BYTES {
        return Err(format!(
            "文件 {name} 大小 {:.1} MB 超过单文件上限 1 GiB，已中止上传",
            size as f64 / 1_048_576.0
        ));
    }
    Ok(())
}

/// 上传目标必须是本应用生成的备份目录（T-048）。
///
/// 复用恢复校验：目录名必须 `my-chat-backup-` 开头且含数据库标记。否则用户
/// 可能把 `%APPDATA%/com.my-chat`、`~/.ssh` 等任意目录整个推到云端。
fn validate_upload_root(root: &Path, app_data: &Path) -> Result<PathBuf, String> {
    validate_backup_dir(root, app_data).map_err(|e| format!("拒绝上传：{e}"))
}

/// 把 `rel`（`/` 分隔）按路径段做 percent-encode，保留段间 `/`。
///
/// 文件名里的 `?`、`#`、空格、非 ASCII 不编码会被 URL 解析成 query/fragment
/// 或产生非法请求行，PUT 会落到错误路径（T-048）。
fn encode_rel_path(rel: &str) -> String {
    rel.split('/')
        .map(|segment| {
            let mut out = String::with_capacity(segment.len());
            for b in segment.bytes() {
                match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                        out.push(char::from(b));
                    }
                    _ => {
                        const HEX: &[u8; 16] = b"0123456789ABCDEF";
                        out.push('%');
                        out.push(char::from(HEX[usize::from(b >> 4)]));
                        out.push(char::from(HEX[usize::from(b & 0x0F)]));
                    }
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// 构造流式上传 body（T-049）。
///
/// 旧实现 `std::fs::read` 把整份文件读进内存再交给 reqwest：2 GiB 上限下
/// 单文件就可能吃掉 2 GiB RAM。这里返回按 64 KiB 块读取的流，峰值内存与文件
/// 大小无关。同时给出真实文件长度，供单文件上限校验。
fn stream_file_body(path: &Path) -> Result<(reqwest::Body, u64), String> {
    use tokio::io::AsyncReadExt;

    let file =
        std::fs::File::open(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    let len = file
        .metadata()
        .map_err(|e| format!("读取 {} 元数据失败: {e}", path.display()))?
        .len();
    let file = tokio::fs::File::from_std(file);
    let stream = futures::stream::try_unfold(file, |mut file| async move {
        let mut buf = vec![0u8; 64 * 1024];
        let n = file.read(&mut buf).await?;
        if n == 0 {
            Ok::<_, std::io::Error>(None)
        } else {
            buf.truncate(n);
            Ok::<_, std::io::Error>(Some((buf, file)))
        }
    });
    Ok((reqwest::Body::wrap_stream(stream), len))
}

/// Upload a backup (directory) to a `WebDAV` server: each file inside is PUT to
/// `url/<relative-path>` with basic auth. Files in a folder root are put at the
/// URL root; subdirectories are created implicitly by many servers, but if the
/// server requires them we create them via MKCOL first (best-effort).
///
/// 安全与并发约束（RS-16 / RS-18 / T-048 / T-049）：
/// - 只允许 https（Basic 认证不落明文）；
/// - 上传目录必须是本应用生成的备份（`my-chat-backup-` + 数据库标记），
///   `.ssh`、应用数据目录等任意目录一律拒绝；
/// - 相对路径按段 percent-encode，文件名含 `?`/`#`/空格时仍 PUT 到正确路径；
/// - 递归列目录 / stat 是同步 IO，全部放进 `spawn_blocking`，不阻塞 runtime；
/// - 总字节数 > 2 GiB 中止，单文件 > 1 GiB 中止；
/// - 文件内容用流式 body 发送，峰值内存与文件大小无关；
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
    // 只接受本应用生成的备份目录：这是内容物（API key、聊天记录）离开本机前的
    // 最后一道闸门。
    let root = validate_upload_root(&PathBuf::from(&file_path), &app_data_dir())?;
    let client = crate::net::upload_client();

    // 递归列目录 + stat 是同步 IO，挪出 async 线程（RS-16）。
    let (files, total) = tauri::async_runtime::spawn_blocking(move || {
        let mut files: Vec<(PathBuf, String)> = Vec::new();
        let total = collect_files(&root, &root, &mut files)?;
        Ok::<_, String>((files, total))
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
        // 流式 body：不在内存里拼整份文件（T-049）。
        let (body, len) = stream_file_body(&abs)?;
        check_single_file_size(len, &rel)?;
        let target = format!("{base}/{}", encode_rel_path(&rel));
        let resp = client
            .put(&target)
            .basic_auth(&username, Some(&password))
            .header("Content-Type", "application/octet-stream")
            .body(body)
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
            let rel = p
                .strip_prefix(root)
                .map_err(|e| format!("计算相对路径失败: {e}"))?
                .to_string_lossy()
                .replace('\\', "/");
            // 单文件与总量分别限制（T-049）：超大文件在扫描阶段就拒绝，
            // 不等到 PUT 开始。
            check_single_file_size(size, &rel)?;
            total += size;
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

    /// 在 `app_dir/sled_db` 打开一个临时库，模拟“应用正在运行、文件被锁”。
    fn open_temp_sled(app_dir: &Path) -> sled::Db {
        sled::open(app_dir.join(SLED_DB_DIR)).expect("打开临时 sled")
    }

    /// `parent` 下所有恢复前保护快照目录（按名称排序，便于断言「只有一份」）。
    fn pre_restore_snapshots(parent: &Path) -> Vec<PathBuf> {
        let mut snapshots: Vec<PathBuf> = std::fs::read_dir(parent)
            .expect("读父目录")
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(PRE_RESTORE_PREFIX))
            })
            .collect();
        snapshots.sort_unstable();
        snapshots
    }

    /// RED 探针：证明「运行中的 sled 目录整目录复制」在本机确实失败。
    /// 这正是必须改用 `export()` 逻辑导出的原因（os error 33）。
    #[test]
    fn whole_dir_copy_of_running_sled_fails_with_lock_error() {
        let tmp = TempDir::new("lock-probe");
        let app = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app).expect("建 app data");
        let db = sled::open(app.join("sled_db")).expect("打开临时 sled");
        db.open_tree("t")
            .expect("建树")
            .insert(b"k", b"v")
            .expect("写 key");
        db.flush().expect("flush");

        let err = copy_dir_all(&app.join("sled_db"), &tmp.child("copy"))
            .expect_err("运行中的 sled 目录整目录复制必须失败（否则本 bug 不存在）");
        eprintln!("实测锁错误: {err}");
        drop(db);
    }

    // ── T-043 / T-044 备份目标与命名 ───────────────────────

    /// 选中应用数据目录或其子目录必须拒绝：否则备份会拷进源目录自我递归。
    #[test]
    fn backup_dest_rejects_app_data_and_its_subdirs() {
        let tmp = TempDir::new("dest-guard");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(app_data.join("conversations")).expect("建 app data");
        let outside = tmp.child("backups");
        std::fs::create_dir_all(&outside).expect("建外部目录");

        let err = validate_backup_dest(&app_data, &app_data).expect_err("应用数据目录自身必须拒绝");
        assert!(err.contains("拒绝备份"), "错误应明确拒绝: {err}");
        assert!(err.contains("自我递归"), "错误应说明递归风险: {err}");

        let err = validate_backup_dest(&app_data.join("conversations"), &app_data)
            .expect_err("应用数据子目录必须拒绝");
        assert!(err.contains("拒绝备份"), "错误应明确拒绝: {err}");

        assert_eq!(
            validate_backup_dest(&outside, &app_data).expect("外部目录应通过"),
            std::fs::canonicalize(&outside).expect("canonicalize")
        );
    }

    /// 同秒两次备份：第二次自动加 `-2` 序号，第一份保持完整。
    #[test]
    fn same_second_backups_get_unique_suffix_and_first_survives() {
        let tmp = TempDir::new("same-second");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        std::fs::write(app_data.join("note.txt"), b"live").expect("写文件");
        let db = open_temp_sled(&app_data);

        let first = unique_backup_dest(tmp.path(), 1_700_000_000);
        assert_eq!(
            first.file_name().unwrap_or_default().to_string_lossy(),
            "my-chat-backup-1700000000"
        );
        create_backup_from(&db, &app_data, &first).expect("第一份备份应成功");

        let second = unique_backup_dest(tmp.path(), 1_700_000_000);
        assert_eq!(
            second.file_name().unwrap_or_default().to_string_lossy(),
            "my-chat-backup-1700000000-2",
            "同秒第二份备份必须加序号"
        );
        create_backup_from(&db, &app_data, &second).expect("同秒第二份备份应成功");

        assert!(first.is_dir() && second.is_dir(), "两份备份都必须存在");
        assert!(first.join(SLED_EXPORT_FILE).is_file(), "第一份必须完整保留");
        assert!(second.join(SLED_EXPORT_FILE).is_file(), "第二份也必须完整");
        assert_eq!(
            backup_ts_from_name(&first.file_name().unwrap_or_default().to_string_lossy()),
            1_700_000_000
        );
        assert_eq!(
            backup_ts_from_name(&second.file_name().unwrap_or_default().to_string_lossy()),
            1_700_000_000,
            "带序号后缀的备份仍应解析出同一秒时间戳"
        );
    }

    /// 目标目录已存在时拒绝覆盖，且失败清理绝不删已有目录（T-044）。
    #[test]
    fn backup_refuses_existing_dest_without_deleting_it() {
        let tmp = TempDir::new("dest-exists");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        std::fs::write(app_data.join("note.txt"), b"live").expect("写文件");
        let db = open_temp_sled(&app_data);

        // 模拟上一份成功备份恰好占用了这个名字
        let dest = tmp.child("my-chat-backup-1700000000");
        std::fs::create_dir_all(&dest).expect("建已有备份");
        std::fs::write(dest.join(SLED_EXPORT_FILE), b"[]").expect("写导出");
        std::fs::write(dest.join("sentinel.txt"), b"keep").expect("写哨兵文件");

        let err = create_backup_from(&db, &app_data, &dest)
            .expect_err("已存在的目标目录必须拒绝，不能覆盖");
        assert!(err.contains("已存在"), "错误应说明撞名: {err}");
        assert!(
            dest.join("sentinel.txt").is_file(),
            "已有备份里的文件绝不能被删除"
        );
        assert!(
            dest.join(SLED_EXPORT_FILE).is_file(),
            "已有备份必须原样保留"
        );
    }

    /// 扫描只列本应用备份；带序号的历史备份时间戳仍按秒解析。
    #[test]
    fn list_backups_skips_non_backup_entries_and_parses_suffix() {
        let tmp = TempDir::new("list");
        let bak = make_backup(tmp.path(), "my-chat-backup-1700000000-2", None);
        std::fs::write(bak.join("a.bin"), b"1234").expect("写文件");
        make_backup(tmp.path(), "someone-elses-dir", None);
        std::fs::write(tmp.child("my-chat-backup-file"), b"x").expect("写同名文件");

        let items = list_backups_at(tmp.path());
        assert_eq!(items.len(), 1, "只应列出目录形式的备份: {items:?}");
        assert_eq!(items[0]["name"], "my-chat-backup-1700000000-2");
        assert_eq!(items[0]["ts"], 1_700_000_000u64);
        assert_eq!(items[0]["size_mb"], 0.0);
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
            Some(SLED_EXPORT_FILE),
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

    /// sled 0.34 的物理布局：默认树的 `db` 文件直接落在 `sled_db/` 根下，
    /// `conf` 与 `blobs/` 先于它出现。v1 判据必须与这个真实布局一致。
    #[test]
    fn sled_layout_has_db_file_at_root() {
        let tmp = TempDir::new("sled-layout");
        let app = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app).expect("建 app data");
        let db = open_temp_sled(&app);
        db.flush().expect("flush");
        let entries: Vec<String> = std::fs::read_dir(app.join(SLED_DB_DIR))
            .expect("读 sled_db")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        eprintln!("sled_db 实际布局: {entries:?}");
        assert!(
            app.join(SLED_DB_DIR).join(SLED_DB_DATA_FILE).is_file(),
            "sled 0.34 应在 sled_db/ 下产生 {SLED_DB_DATA_FILE} 文件，实际: {entries:?}"
        );
        drop(db);
    }

    /// 真机实测的坏备份：`sled_db/` 只有 `conf` 和空的 `blobs/`，没有 `db`。
    /// 这是旧版 `create_backup` 被 sled 文件锁打断留下的半成品 —— 恢复它只会覆盖
    /// `conf`，不覆盖 `db`，等于静默空操作。必须拒绝。
    #[test]
    fn v1_backup_without_db_file_is_rejected() {
        let tmp = TempDir::new("v1-no-db");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let backup = make_backup(tmp.path(), "my-chat-backup-1792753368", None);
        let sled = backup.join(SLED_DB_DIR);
        std::fs::create_dir_all(sled.join("blobs")).expect("建空 blobs");
        std::fs::write(sled.join("conf"), b"segment_size: 524288\n").expect("写 conf");

        let err = validate_backup_dir(&backup, &app_data)
            .expect_err("缺 sled_db/db 的半截 v1 备份必须拒绝");
        assert!(
            err.contains("sled_db/db"),
            "错误应点名缺失的 db 文件: {err}"
        );
        assert!(err.contains("不完整"), "错误应说明可能是不完整备份: {err}");
    }

    /// 完整 v1 备份：`sled_db/db` + 关键目录齐全才接受（T-045）。
    #[test]
    fn v1_backup_with_db_file_passes() {
        let tmp = TempDir::new("v1-ok");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let backup = make_backup(tmp.path(), "my-chat-backup-1", None);
        let sled = backup.join(SLED_DB_DIR);
        std::fs::create_dir_all(sled.join("blobs")).expect("建 blobs");
        std::fs::write(sled.join("conf"), b"segment_size: 524288\n").expect("写 conf");
        std::fs::write(sled.join(SLED_DB_DATA_FILE), b"\x00").expect("写 db");
        for dir in V1_REQUIRED_DIRS {
            std::fs::create_dir_all(backup.join(dir)).expect("建关键目录");
        }
        assert!(validate_backup_dir(&backup, &app_data).is_ok());
    }

    /// T-045：`sled_db/db` 已在、但 `characters/`、`presets/` 还没拷到的半份
    /// v1 必须拒绝 —— 恢复它会让角色/预设静默缺失。
    #[test]
    fn v1_backup_without_key_dirs_is_rejected() {
        let tmp = TempDir::new("v1-partial");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let backup = make_backup(tmp.path(), "my-chat-backup-3", None);
        let sled = backup.join(SLED_DB_DIR);
        std::fs::create_dir_all(&sled).expect("建 sled_db");
        std::fs::write(sled.join(SLED_DB_DATA_FILE), b"\x00").expect("写 db");
        std::fs::create_dir_all(backup.join("characters")).expect("只拷到 characters");

        let err =
            validate_backup_dir(&backup, &app_data).expect_err("缺关键目录的半份 v1 必须拒绝");
        assert!(err.contains("不完整"), "错误应说明不完整: {err}");
        assert!(
            err.contains("presets") && !err.contains("characters"),
            "错误应只点名缺失的 presets（characters 已存在）: {err}"
        );
        assert!(err.contains("立即备份"), "错误应给出可操作建议: {err}");
    }

    /// v2 备份只有 `sled_db.export.json`、没有 `sled_db/`，必须被接受。
    #[test]
    fn v2_export_marker_alone_is_enough() {
        let tmp = TempDir::new("v2-marker");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let backup = make_backup(tmp.path(), "my-chat-backup-42", None);
        std::fs::write(backup.join(SLED_EXPORT_FILE), b"[]").expect("写导出");
        assert!(validate_backup_dir(&backup, &app_data).is_ok());
    }

    #[test]
    fn arbitrary_directory_is_rejected() {
        let tmp = TempDir::new("arbitrary");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        // 内容看起来像备份，但目录名不是本应用的命名 → 拒绝
        let evil = make_backup(tmp.path(), "my-chat-data-copy", Some(SLED_EXPORT_FILE));
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
            err.contains(SLED_EXPORT_FILE) && err.contains(SLED_DB_DIR),
            "错误应说明两个可接受标记: {err}"
        );
    }

    /// 半截 v1 复制可能先拷到 `schema_version.txt`、还没拷到 `sled_db/`。
    /// 这种目录必须拒绝 —— 否则会恢复成空库。
    #[test]
    fn schema_version_only_directory_is_rejected() {
        let tmp = TempDir::new("schema-only");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let partial = make_backup(tmp.path(), "my-chat-backup-77", Some("schema_version.txt"));
        let err = validate_backup_dir(&partial, &app_data)
            .expect_err("只有 schema_version.txt 的半截备份必须拒绝");
        assert!(err.contains("不是本应用的备份"), "错误应说明判据: {err}");
    }

    #[test]
    fn missing_directory_is_rejected() {
        let tmp = TempDir::new("missing");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let ghost = tmp.child("my-chat-backup-404");
        assert!(validate_backup_dir(&ghost, &app_data).is_err());
    }

    // ── 删除备份 ──────────────────────────────────────────

    #[test]
    fn delete_backup_removes_valid_backup_dir() {
        let tmp = TempDir::new("delete-ok");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let backup = make_backup(
            tmp.path(),
            "my-chat-backup-1700000000",
            Some(SLED_EXPORT_FILE),
        );
        std::fs::write(backup.join("schema_version.txt"), b"1").expect("写数据文件");

        delete_backup_at(&backup, &app_data).expect("合法备份应可删除");

        assert!(!backup.exists(), "备份目录应被整棵删除");
        assert!(app_data.is_dir(), "应用数据目录不得受影响");
    }

    /// 恢复前保护快照与普通备份共用前缀，也必须能删。
    #[test]
    fn delete_backup_removes_pre_restore_snapshot() {
        let tmp = TempDir::new("delete-snapshot");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let snap = make_backup(
            tmp.path(),
            &format!("{PRE_RESTORE_PREFIX}1700000000123"),
            Some(SLED_EXPORT_FILE),
        );

        delete_backup_at(&snap, &app_data).expect("保护快照应可删除");
        assert!(!snap.exists());
    }

    #[test]
    fn delete_backup_rejects_arbitrary_directory() {
        let tmp = TempDir::new("delete-arbitrary");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let user_dir = make_backup(tmp.path(), "别删我", None);
        std::fs::write(user_dir.join("important.txt"), b"keep").expect("写用户文件");

        let err = delete_backup_at(&user_dir, &app_data).expect_err("任意目录必须拒绝");
        assert!(err.contains(BACKUP_PREFIX), "错误应说明前缀要求: {err}");
        assert!(
            user_dir.join("important.txt").is_file(),
            "用户文件必须原样保留"
        );
    }

    #[test]
    fn delete_backup_rejects_app_data_dir_itself() {
        let tmp = TempDir::new("delete-self");
        // 让 app data 目录本身也带备份前缀，专门验证自我保护规则
        let app_data = make_backup(tmp.path(), "my-chat-backup-self", None);
        let err = delete_backup_at(&app_data, &app_data).expect_err("不能删除应用数据目录自身");
        assert!(err.contains("应用数据目录"), "错误应说明原因: {err}");
        assert!(app_data.is_dir(), "应用数据目录必须保留");
    }

    /// `delete_backup("C:\\")` 之类：目标是 app data 的祖先时必须拒绝，
    /// 否则一次调用能连用户数据一起删掉。
    #[test]
    fn delete_backup_rejects_ancestor_of_app_data() {
        let tmp = TempDir::new("delete-ancestor");
        let outer = make_backup(tmp.path(), "my-chat-backup-outer", None);
        let app_data = outer.join("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        std::fs::write(app_data.join("schema_version.txt"), b"7").expect("写标记");

        let err = delete_backup_at(&outer, &app_data).expect_err("应用数据目录的祖先必须拒绝删除");
        assert!(err.contains("应用数据目录"), "错误应说明原因: {err}");
        assert!(
            app_data.join("schema_version.txt").is_file(),
            "数据必须原样保留"
        );
    }

    /// 全新安装、app data 目录还没建出来时，祖先保护同样必须生效。
    /// （此时 `canonicalize(app_data)` 会失败，不能因此跳过检查。）
    #[test]
    fn delete_backup_rejects_ancestor_even_when_app_data_missing() {
        let tmp = TempDir::new("delete-ancestor-missing");
        let outer = make_backup(tmp.path(), "my-chat-backup-fresh", None);
        let app_data = outer.join("com.my-chat"); // 故意不创建

        let err = delete_backup_at(&outer, &app_data).expect_err("app data 不存在也要保护");
        assert!(err.contains("应用数据目录"), "错误应说明原因: {err}");
        assert!(outer.is_dir(), "祖先目录必须保留");
    }

    #[test]
    fn delete_backup_rejects_missing_path() {
        let tmp = TempDir::new("delete-missing");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let ghost = tmp.child("my-chat-backup-404");

        assert!(
            delete_backup_at(&ghost, &app_data).is_err(),
            "不存在的路径必须拒绝"
        );
    }

    /// `..` 规范化后落到一个非备份目录 —— 必须被前缀规则拦住，且上级目录不能被动。
    #[test]
    fn delete_backup_rejects_dotdot_escaping_to_parent() {
        let tmp = TempDir::new("delete-dotdot");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let backup = make_backup(tmp.path(), "my-chat-backup-1", None);

        let escape = backup.join("..");
        let err = delete_backup_at(&escape, &app_data).expect_err(".. 规范化到上级必须拒绝");
        assert!(err.contains(BACKUP_PREFIX), "错误应说明前缀要求: {err}");
        assert!(tmp.path().is_dir(), "上级目录必须保留");
        assert!(backup.is_dir(), "备份目录本身（未被指向）必须保留");
    }

    /// 名字带前缀但是普通文件（不是目录）—— 不是备份，拒绝。
    #[test]
    fn delete_backup_rejects_regular_file() {
        let tmp = TempDir::new("delete-file");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        let file = tmp.child("my-chat-backup-not-a-dir");
        std::fs::write(&file, b"x").expect("写文件");

        let err = delete_backup_at(&file, &app_data).expect_err("普通文件必须拒绝");
        assert!(err.contains("不是目录"), "错误应说明类型: {err}");
        assert!(file.is_file(), "文件必须保留");
    }

    #[test]
    fn app_data_dir_itself_is_rejected() {
        let tmp = TempDir::new("self");
        // 故意让 app data 目录本身也符合“备份”命名与标记，专门验证自我覆盖规则
        let app_data = make_backup(tmp.path(), "my-chat-backup-self", None);
        std::fs::create_dir_all(app_data.join(SLED_DB_DIR)).expect("建 sled_db");
        // 先满足 v1 数据判据，确保错误来自「自身」规则而不是「缺 db」规则。
        std::fs::write(app_data.join(SLED_DB_DIR).join(SLED_DB_DATA_FILE), b"\x00").expect("写 db");
        let err = validate_backup_dir(&app_data, &app_data).expect_err("不能从自身恢复");
        assert!(err.contains("自身"), "错误应说明自我覆盖: {err}");
    }

    /// v2 保护快照：DB **打开着**（文件被锁）也必须成功，且产物不含 `sled_db/`。
    /// 旧实现整目录复制，走到这里就是 `os error 33`。
    #[test]
    fn snapshot_before_restore_uses_v2_and_skips_locked_sled() {
        let tmp = TempDir::new("snapshot");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        std::fs::write(app_data.join("schema_version.txt"), b"7").expect("写标记");
        std::fs::write(app_data.join("note.txt"), b"hi").expect("写普通文件");

        let db = open_temp_sled(&app_data);
        db.open_tree("conversations")
            .expect("建树")
            .insert(b"c:1", b"hello")
            .expect("写 key");
        db.flush().expect("flush");

        let snap = snapshot_before_restore(&app_data, &db).expect("DB 打开时快照也必须成功");
        assert_eq!(snap.parent(), Some(tmp.path()), "快照必须在源目录之外");
        let name = snap.file_name().unwrap_or_default().to_string_lossy();
        assert!(
            name.starts_with("my-chat-backup-pre-restore-"),
            "实际命名: {name}"
        );
        assert!(
            snap.join(SLED_EXPORT_FILE).is_file(),
            "v2 快照必须带 sled 逻辑导出"
        );
        assert!(
            !snap.join(SLED_DB_DIR).exists(),
            "v2 快照不得含被锁的 sled_db 目录"
        );
        assert_eq!(
            std::fs::read_to_string(snap.join("schema_version.txt")).expect("读快照标记"),
            "7"
        );
        assert_eq!(
            std::fs::read_to_string(snap.join("note.txt")).expect("读快照文件"),
            "hi"
        );
        // 快照目录本身也应该能通过恢复校验
        assert!(validate_backup_dir(&snap, tmp.path()).is_ok());
        // 导出内容必须真的包含库里的键
        let export =
            crate::db::parse_export(&std::fs::read(snap.join(SLED_EXPORT_FILE)).expect("读导出"))
                .expect("导出应可解析");
        let found = export.iter().any(|(_, _, kvs)| {
            kvs.iter()
                .any(|kv| kv.len() == 2 && kv[1].as_slice() == b"hello")
        });
        assert!(found, "快照里的导出必须包含运行中写入的键值");
    }

    /// `create_backup_from`：DB 打开着也能备份；产物含导出、不含 `sled_db/`。
    #[test]
    fn create_backup_from_works_with_open_db() {
        let tmp = TempDir::new("v2-backup");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(app_data.join("conversations")).expect("建目录");
        std::fs::write(app_data.join("schema_version.txt"), b"3").expect("写标记");
        std::fs::write(app_data.join("conversations").join("c.json"), b"{}").expect("写文件");

        let db = open_temp_sled(&app_data);
        db.open_tree("conversations")
            .expect("建树")
            .insert(b"c:1", b"hello")
            .expect("写 key");
        db.flush().expect("flush");

        let dest = tmp.child("my-chat-backup-1700000000");
        create_backup_from(&db, &app_data, &dest).expect("运行中的 DB 必须能备份");

        assert!(dest.join(SLED_EXPORT_FILE).is_file(), "必须写 sled 导出");
        assert!(
            !dest.join(SLED_DB_DIR).exists(),
            "备份不得包含被锁的 sled_db 目录"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join(BACKUP_FORMAT_FILE)).expect("读格式标记"),
            BACKUP_FORMAT_V2
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("schema_version.txt")).expect("读 schema 标记"),
            "3"
        );
        assert!(
            dest.join("conversations").join("c.json").is_file(),
            "其余文件应照常复制"
        );
        // 产物本身就是一个合法备份
        assert!(validate_backup_dir(&dest, tmp.path()).is_ok());
    }

    /// 备份中途失败不得留下半截目录（它会看起来像一个可恢复的备份）。
    ///
    /// 用真实 IO 错误注入：源目录不存在，`copy_dir_all_excluding` 在目录已
    /// 原子创建之后失败 —— 半截 dest 必须被整棵删除。
    #[test]
    fn failed_backup_leaves_no_partial_directory() {
        let tmp = TempDir::new("v2-cleanup");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");

        let db = open_temp_sled(&app_data);
        db.open_tree("t")
            .expect("建树")
            .insert(b"k", b"v")
            .expect("写 key");
        db.flush().expect("flush");

        let dest = tmp.child("my-chat-backup-1700000001");
        let missing_source = tmp.child("missing-source");
        let err =
            create_backup_from(&db, &missing_source, &dest).expect_err("源目录不存在必须失败");
        assert!(err.contains("Not a dir"), "错误应指向失败步骤: {err}");
        assert!(
            !dest.exists(),
            "失败后必须删除半截备份目录: {}",
            dest.display()
        );
    }

    /// T-044：复制已经开始（dest 里已有半截文件）后失败，也只清本次目录。
    #[test]
    fn failed_claimed_backup_is_fully_discarded() {
        let tmp = TempDir::new("claim-cleanup");
        let dest = tmp.child("my-chat-backup-1700000002");

        let err = claim_and_run(&dest, |dest| {
            std::fs::write(dest.join("copied.bin"), b"partial").expect("写半截文件");
            Err("注入失败".to_string())
        })
        .expect_err("注入错误必须上报");

        assert!(err.contains("注入失败"), "{err}");
        assert!(!dest.exists(), "本次创建的半截目录必须整棵删除");
    }

    /// T-044：目标目录已存在时连闭包都不能执行，更不会删除已有内容。
    #[test]
    fn claim_refuses_existing_dir_without_running() {
        let tmp = TempDir::new("claim-existing");
        let dest = tmp.child("my-chat-backup-1700000003");
        std::fs::create_dir_all(&dest).expect("建已有目录");
        std::fs::write(dest.join("sentinel.txt"), b"keep").expect("写哨兵");

        let err = claim_and_run(&dest, |_| panic!("目标已存在时不得执行写入"))
            .expect_err("已存在的目录必须拒绝");
        assert!(err.contains("已存在"), "{err}");
        assert!(
            dest.join("sentinel.txt").is_file(),
            "已有目录内容绝不能被删除"
        );
    }

    /// 恢复前快照的导出必须能原样导入空库（端到端：备份 → 导入）。
    #[test]
    fn snapshot_export_can_be_imported_into_empty_db() {
        let tmp = TempDir::new("snapshot-import");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");

        let src = open_temp_sled(&app_data);
        src.open_tree("conversations")
            .expect("建树")
            .insert(b"c:1", b"hello")
            .expect("写 key");
        src.flush().expect("flush");

        let snap = snapshot_before_restore(&app_data, &src).expect("快照应成功");
        let export =
            crate::db::parse_export(&std::fs::read(snap.join(SLED_EXPORT_FILE)).expect("读导出"))
                .expect("导出应可解析");

        let other = TempDir::new("snapshot-import-dst");
        let dst_dir = other.child("sled_db");
        let dst = sled::open(&dst_dir).expect("打开目标库");
        crate::db::import_export_into(&dst, export).expect("导入空库应成功");
        assert_eq!(
            dst.open_tree("conversations")
                .expect("建树")
                .get(b"c:1")
                .expect("读 key")
                .as_deref(),
            Some(&b"hello"[..])
        );
    }

    /// v2 恢复：删旧库、挂待导入文件、不动格式标记。
    #[test]
    fn restore_v2_replaces_db_dir_and_stages_import() {
        let tmp = TempDir::new("v2-restore");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(app_data.join(SLED_DB_DIR)).expect("建旧库目录");
        std::fs::write(app_data.join(SLED_DB_DIR).join("old.bin"), b"old").expect("写旧库文件");

        let backup = tmp.child("my-chat-backup-9");
        std::fs::create_dir_all(&backup).expect("建备份目录");
        std::fs::write(backup.join(SLED_EXPORT_FILE), b"[]").expect("写导出");
        std::fs::write(backup.join(BACKUP_FORMAT_FILE), b"2").expect("写格式标记");
        std::fs::write(backup.join("schema_version.txt"), b"9").expect("写 schema 标记");

        restore_v2_from(&backup, &app_data).expect("v2 恢复应成功");

        assert!(
            !app_data.join(SLED_DB_DIR).exists(),
            "旧库必须清空（否则 import 会撞已存在 key 触发 panic）"
        );
        assert!(
            app_data.join(SLED_IMPORT_PENDING).is_file(),
            "v2 恢复必须留下待导入文件"
        );
        assert_eq!(
            std::fs::read_to_string(app_data.join("schema_version.txt")).expect("读 schema 标记"),
            "9",
            "其余文件应复制过来"
        );
        assert!(
            !app_data.join(BACKUP_FORMAT_FILE).exists(),
            "备份格式标记不该进 app data"
        );
        assert!(
            !app_data.join(SLED_EXPORT_FILE).exists(),
            "导出文件应改名成待导入标记，而不是留在 app data 里"
        );
        // 没有残留的 .restore-old-* 目录
        let leftovers = std::fs::read_dir(&app_data)
            .expect("读 app data")
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("restore-old"))
            .count();
        assert_eq!(leftovers, 0, "挪开的旧库应被清理");
    }

    /// 坏导出文件：推进恢复前就必须失败，且现有数据一个字节都不能动。
    #[test]
    fn restore_v2_with_broken_export_leaves_data_untouched() {
        let tmp = TempDir::new("v2-broken");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(app_data.join(SLED_DB_DIR)).expect("建旧库目录");
        std::fs::write(app_data.join(SLED_DB_DIR).join("old.bin"), b"old").expect("写旧库文件");

        let backup = tmp.child("my-chat-backup-10");
        std::fs::create_dir_all(&backup).expect("建备份目录");
        std::fs::write(backup.join(SLED_EXPORT_FILE), b"{not json").expect("写坏导出");

        let err = restore_v2_from(&backup, &app_data).expect_err("坏导出必须中止恢复");
        assert!(err.contains("无法解析"), "{err}");
        assert_eq!(
            std::fs::read(app_data.join(SLED_DB_DIR).join("old.bin")).expect("旧库应完好"),
            b"old"
        );
        assert!(
            !app_data.join(SLED_IMPORT_PENDING).exists(),
            "失败时不得留下待导入文件"
        );
    }

    /// T-047：rename 旧库失败必须发生在覆盖文件之前 —— 文件与 DB 都保持原样，
    /// 错误文案「未改动」才与事实一致。注入方式：预先占用 parked 目录名，
    /// 让 rename 的目标已存在（Windows/macOS 均失败）。
    #[test]
    fn restore_v2_rename_failure_leaves_files_and_db_untouched() {
        let tmp = TempDir::new("v2-rename-fail");
        let app_data = tmp.child("com.my-chat");
        let app_db = app_data.join(SLED_DB_DIR);
        std::fs::create_dir_all(&app_db).expect("建旧库");
        std::fs::write(app_db.join("old.bin"), b"old").expect("写旧库文件");
        std::fs::write(app_data.join("settings.json"), b"live").expect("写本机设置");

        let backup = tmp.child("my-chat-backup-17");
        std::fs::create_dir_all(&backup).expect("建备份目录");
        std::fs::write(backup.join(SLED_EXPORT_FILE), b"[]").expect("写导出");
        std::fs::write(backup.join("settings.json"), b"backup").expect("写备份设置");

        // 占住 rename 目标（非空目录在 Windows/Unix 上都不能被 rename 覆盖）。
        let parked = app_data.join("sled_db.restore-old-fixed");
        std::fs::create_dir_all(parked.join("occupied")).expect("占位 parked");
        std::fs::write(parked.join("occupied").join("x"), b"x").expect("写占位文件");

        let err = restore_v2_with(&backup, &app_data, &parked).expect_err("rename 必须失败");
        assert!(err.contains("挪开旧库失败"), "错误应点名失败步骤: {err}");
        assert!(err.contains("未改动"), "错误应如实说明未改动: {err}");
        assert_eq!(
            std::fs::read(app_data.join("settings.json")).expect("读设置"),
            b"live",
            "rename 失败时文件不能被覆盖"
        );
        assert_eq!(
            std::fs::read(app_db.join("old.bin")).expect("旧库应完好"),
            b"old",
            "rename 失败时旧库必须原样"
        );
        assert!(
            !app_data.join(SLED_IMPORT_PENDING).exists(),
            "rename 失败时不得挂待导入文件"
        );
    }

    /// restore × migration rollback 交叉：`migration_pending.txt` 存在时不得执行已排队的
    /// 恢复，否则 rollback 会把旧库装回，与 pending 组成「非空库 + pending」永久失败。
    #[test]
    fn pending_restore_is_refused_while_migration_pending_exists() {
        let tmp = TempDir::new("restore-migration-cross");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(app_data.join(SLED_DB_DIR)).expect("建旧库目录");
        std::fs::write(app_data.join(SLED_DB_DIR).join("old.bin"), b"old").expect("写旧库文件");
        std::fs::write(app_data.join(MIGRATION_MARKER), b"snapshot").expect("写迁移标记");

        let backup = make_backup(tmp.path(), "my-chat-backup-15", Some(SLED_EXPORT_FILE));
        std::fs::write(backup.join(SLED_EXPORT_FILE), b"[]").expect("写导出");
        std::fs::write(
            app_data.join(RESTORE_MARKER),
            backup.to_string_lossy().as_bytes(),
        )
        .expect("写恢复标记");

        let err = run_pending_restore_at(&app_data).expect_err("迁移标记存在时必须拒绝恢复");
        assert!(err.contains(MIGRATION_MARKER), "错误应点名交叉标记: {err}");
        assert!(
            app_data.join(RESTORE_MARKER).exists(),
            "拒绝时必须保留恢复标记，等回滚完成后的下次启动再执行"
        );
        assert!(
            !app_data.join(SLED_IMPORT_PENDING).exists(),
            "拒绝时不得产生待导入文件"
        );
        assert_eq!(
            std::fs::read(app_data.join(SLED_DB_DIR).join("old.bin")).expect("旧库应完好"),
            b"old",
            "拒绝时不得改动现有数据库"
        );
    }

    /// 没有交叉标记时，启动恢复的正常流程语义不变（v2 清旧库、挂 pending、删 marker）。
    #[test]
    fn pending_restore_still_runs_without_migration_marker() {
        let tmp = TempDir::new("restore-normal");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(app_data.join(SLED_DB_DIR)).expect("建旧库目录");
        std::fs::write(app_data.join(SLED_DB_DIR).join("old.bin"), b"old").expect("写旧库文件");

        let backup = make_backup(tmp.path(), "my-chat-backup-16", Some(SLED_EXPORT_FILE));
        std::fs::write(backup.join(SLED_EXPORT_FILE), b"[]").expect("写导出");
        std::fs::write(
            app_data.join(RESTORE_MARKER),
            backup.to_string_lossy().as_bytes(),
        )
        .expect("写恢复标记");

        run_pending_restore_at(&app_data).expect("无交叉标记时恢复应执行");

        assert!(
            !app_data.join(RESTORE_MARKER).exists(),
            "恢复成功后应删除标记"
        );
        assert_eq!(
            std::fs::read_to_string(app_data.join(SLED_IMPORT_PENDING)).expect("读待导入文件"),
            "[]",
            "v2 恢复应挂上待导入文件"
        );
        assert!(
            !app_data.join(SLED_DB_DIR).exists(),
            "v2 恢复应清空旧库，等待下次启动导入"
        );
    }

    // ── T-006：恢复前快照的时机 ─────────────────────────────
    //
    // 「安排恢复」与「真正覆盖」之间应用仍可继续使用（窗口可长达数小时）。
    // 快照必须在启动期、覆盖之前拍，才能覆盖这段窗口内新增的数据。

    /// 安排恢复只写 marker：不得产生任何 pre-restore 快照。
    #[test]
    fn scheduling_restore_writes_marker_without_snapshot() {
        let tmp = TempDir::new("schedule-no-snapshot");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        std::fs::write(app_data.join("note.txt"), b"live").expect("写用户数据");

        let backup = make_backup(tmp.path(), "my-chat-backup-21", Some(SLED_EXPORT_FILE));
        std::fs::write(backup.join(SLED_EXPORT_FILE), b"[]").expect("写导出");

        let msg = schedule_restore_at(&app_data, &backup).expect("安排恢复应成功");

        assert!(
            app_data.join(RESTORE_MARKER).is_file(),
            "安排恢复必须写待恢复标记"
        );
        // marker 存的是 `validate_backup_dir` 解析后的 canonical 路径
        // （Windows 上会带 `\\?\` 前缀，用于解掉符号链接/目录联接）。
        let canonical = std::fs::canonicalize(&backup).expect("canonicalize 备份路径");
        assert_eq!(
            std::fs::read_to_string(app_data.join(RESTORE_MARKER)).expect("读标记"),
            canonical.to_string_lossy(),
            "标记内容应是备份目录路径"
        );
        assert!(
            pre_restore_snapshots(tmp.path()).is_empty(),
            "安排恢复时不得拍快照（真正覆盖发生在下次启动）"
        );
        assert!(msg.contains("重启"), "提示应明确要求重启后执行: {msg}");
    }

    /// 启动执行恢复前才拍快照，且快照必须是「当前」库：
    /// 安排恢复之后新增的数据也在里面，不会被无回滚点地覆盖。
    #[test]
    fn pending_restore_snapshots_current_db_before_overwrite() {
        let tmp = TempDir::new("pending-snapshot-current");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");

        // 安排恢复之前已有的数据
        {
            let db = open_temp_sled(&app_data);
            db.open_tree("conversations")
                .expect("建树")
                .insert(b"c:1", b"before")
                .expect("写 key");
            db.flush().expect("flush");
        }

        let backup = make_backup(tmp.path(), "my-chat-backup-22", Some(SLED_EXPORT_FILE));
        std::fs::write(backup.join(SLED_EXPORT_FILE), b"[]").expect("写导出");
        schedule_restore_at(&app_data, &backup).expect("安排恢复应成功");
        assert!(
            pre_restore_snapshots(tmp.path()).is_empty(),
            "安排恢复时不得拍快照"
        );

        // 安排恢复之后、重启覆盖之前继续使用产生的数据
        {
            let db = open_temp_sled(&app_data);
            db.open_tree("conversations")
                .expect("建树")
                .insert(b"c:2", b"after")
                .expect("写 key");
            db.flush().expect("flush");
        }

        run_pending_restore_at(&app_data).expect("启动时应执行恢复");

        let snapshots = pre_restore_snapshots(tmp.path());
        assert_eq!(snapshots.len(), 1, "启动执行恢复应恰好产生一份保护快照");
        let snap = &snapshots[0];
        let export = crate::db::parse_export(
            &std::fs::read(snap.join(SLED_EXPORT_FILE)).expect("读快照导出"),
        )
        .expect("快照导出应可解析");
        let check_root = TempDir::new("pending-snapshot-check");
        let check_db = sled::open(check_root.child("sled_db")).expect("打开校验库");
        crate::db::import_export_into(&check_db, export).expect("快照应能导入空库");
        let tree = check_db.open_tree("conversations").expect("建树");
        assert_eq!(
            tree.get(b"c:1").expect("读 key").as_deref(),
            Some(&b"before"[..]),
            "快照应包含安排恢复之前的数据"
        );
        assert_eq!(
            tree.get(b"c:2").expect("读 key").as_deref(),
            Some(&b"after"[..]),
            "快照必须包含安排恢复之后新增的数据（它才是真正会被覆盖的当前库）"
        );
        drop(tree);
        drop(check_db);

        assert!(
            !app_data.join(RESTORE_MARKER).exists(),
            "恢复成功后应删除标记"
        );
    }

    /// 快照失败必须中止恢复：原库/文件不动、marker 保留、不挂待导入文件。
    /// 宁可恢复不了，也不能在没有回滚点的情况下覆盖。
    #[test]
    fn pending_restore_aborts_when_snapshot_fails() {
        let tmp = TempDir::new("pending-snapshot-fail");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        std::fs::write(app_data.join("note.txt"), b"live").expect("写用户文件");
        // 把 sled_db 做成普通文件：快照前「临时打开当前库做逻辑导出」必然失败。
        std::fs::write(app_data.join(SLED_DB_DIR), b"not a db dir").expect("写占位文件");

        let backup = make_backup(tmp.path(), "my-chat-backup-23", Some(SLED_EXPORT_FILE));
        std::fs::write(backup.join(SLED_EXPORT_FILE), b"[]").expect("写导出");
        schedule_restore_at(&app_data, &backup).expect("安排恢复应成功");

        let err = run_pending_restore_at(&app_data).expect_err("快照失败必须中止恢复");
        assert!(err.contains("快照"), "错误应点名快照步骤: {err}");
        assert!(
            err.contains("标记已保留"),
            "错误应告知 marker 已保留、下次启动会重试: {err}"
        );

        assert_eq!(
            std::fs::read(app_data.join("note.txt")).expect("读用户文件"),
            b"live",
            "中止时现有用户数据必须未动"
        );
        assert_eq!(
            std::fs::read(app_data.join(SLED_DB_DIR)).expect("读占位文件"),
            b"not a db dir",
            "中止时现有数据库位置必须未动"
        );
        assert!(
            app_data.join(RESTORE_MARKER).is_file(),
            "失败时必须保留 marker 以便下次启动重试"
        );
        assert!(
            !app_data.join(SLED_IMPORT_PENDING).exists(),
            "中止时不得挂待导入文件"
        );
        assert!(
            pre_restore_snapshots(tmp.path()).is_empty(),
            "失败的快照不得留下半截目录"
        );
    }

    /// 易失文件清单（顶层名）：恢复时不得被备份里的旧副本覆盖。
    const VOLATILE_PROBE: &[&str] = &[
        "chat_errors.log",
        "startup.marker",
        RESTORE_MARKER,
        SLED_IMPORT_PENDING,
        "migration_error.log",
        "restore_error.log",
        STARTUP_ERROR_LOG,
        MIGRATION_MARKER,
    ];

    fn write_probe_files(dir: &Path, tag: &str) {
        for name in VOLATILE_PROBE {
            std::fs::write(dir.join(name), format!("{tag}:{name}")).expect("写易失文件");
        }
        std::fs::write(dir.join("settings.json"), format!("{tag}:settings.json"))
            .expect("写 settings.json");
    }

    /// 回归：恢复把备份里的旧日志 / 启动标记 / 待办标记拷进 app data，
    /// 会覆盖本机现存的易失文件（实测：`chat_errors.log` mtime 倒退、日志丢失）。
    #[test]
    fn restore_v2_keeps_local_volatile_files() {
        let tmp = TempDir::new("v2-volatile");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        write_probe_files(&app_data, "live");

        let backup = tmp.child("my-chat-backup-11");
        std::fs::create_dir_all(&backup).expect("建备份目录");
        std::fs::write(backup.join(SLED_EXPORT_FILE), b"[]").expect("写导出");
        write_probe_files(&backup, "backup");

        restore_v2_from(&backup, &app_data).expect("v2 恢复应成功");

        // 待导入标记由恢复流程自己重写，故不在「保持本机内容」之列。
        for name in VOLATILE_PROBE
            .iter()
            .copied()
            .filter(|n| *n != SLED_IMPORT_PENDING)
        {
            assert_eq!(
                std::fs::read_to_string(app_data.join(name)).expect("易失文件应仍在"),
                format!("live:{name}"),
                "{name} 被备份里的旧副本覆盖了"
            );
        }
        // 待导入标记由本次恢复自己写（内容是备份导出），不能沿用备份里的旧标记 —— 否则
        // 恢复完成后再启动会看到旧标记，形成「恢复 → 再恢复」循环。
        assert_eq!(
            std::fs::read_to_string(app_data.join(SLED_IMPORT_PENDING)).expect("待导入文件"),
            "[]",
            "待导入标记应由本次恢复重写"
        );
        assert_eq!(
            std::fs::read_to_string(app_data.join("settings.json")).expect("读 settings"),
            "backup:settings.json",
            "正常文件仍应被备份覆盖"
        );
    }

    /// v1 整目录复制走同一条排除清单：易失文件保留本机版本，普通文件被覆盖，
    /// `sled_db/`（v1 的数据库载体）照常整目录复制。
    #[test]
    fn restore_v1_keeps_local_volatile_files() {
        let tmp = TempDir::new("v1-volatile");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");
        write_probe_files(&app_data, "live");

        let backup = tmp.child("my-chat-backup-12");
        std::fs::create_dir_all(backup.join(SLED_DB_DIR)).expect("建备份 sled_db");
        std::fs::write(backup.join(SLED_DB_DIR).join("db"), b"v1-db").expect("写 sled_db/db");
        write_probe_files(&backup, "backup");

        restore_v1_from(&backup, &app_data).expect("v1 恢复应成功");

        for name in VOLATILE_PROBE {
            assert_eq!(
                std::fs::read_to_string(app_data.join(name)).expect("易失文件应仍在"),
                format!("live:{name}"),
                "{name} 被备份里的旧副本覆盖了"
            );
        }
        assert_eq!(
            std::fs::read_to_string(app_data.join("settings.json")).expect("读 settings"),
            "backup:settings.json",
            "正常文件仍应被备份覆盖"
        );
        assert_eq!(
            std::fs::read(app_data.join(SLED_DB_DIR).join("db")).expect("读 sled_db/db"),
            b"v1-db",
            "v1 的 sled_db 必须整目录恢复"
        );
    }

    /// T-046：在已有数据的库上恢复 v1 —— 旧库整体换掉，不能和恢复出来的
    /// 库混在一起；备份里没有的旧段文件必须消失。
    #[test]
    fn restore_v1_replaces_old_db_without_mixing_stale_segments() {
        let tmp = TempDir::new("v1-over-existing");
        let app_data = tmp.child("com.my-chat");
        let app_db = app_data.join(SLED_DB_DIR);
        std::fs::create_dir_all(&app_db).expect("建旧库");
        std::fs::write(app_db.join("old-segment.bin"), b"old-seg").expect("写旧段");
        std::fs::write(app_db.join("conf"), b"old-conf").expect("写旧 conf");
        std::fs::write(app_data.join("settings.json"), b"live").expect("写本机设置");

        let backup = tmp.child("my-chat-backup-13");
        let backup_db = backup.join(SLED_DB_DIR);
        std::fs::create_dir_all(&backup_db).expect("建备份库");
        std::fs::write(backup_db.join(SLED_DB_DATA_FILE), b"v1-db").expect("写备份 db");
        std::fs::write(backup_db.join("conf"), b"backup-conf").expect("写备份 conf");
        std::fs::write(backup.join("settings.json"), b"backup").expect("写备份设置");

        restore_v1_from(&backup, &app_data).expect("v1 恢复应成功");

        assert!(
            !app_db.join("old-segment.bin").exists(),
            "旧段文件不得与恢复库混在一起"
        );
        assert_eq!(
            std::fs::read(app_db.join(SLED_DB_DATA_FILE)).expect("读 db"),
            b"v1-db",
            "恢复库必须是备份内容"
        );
        assert_eq!(
            std::fs::read(app_db.join("conf")).expect("读 conf"),
            b"backup-conf",
            "旧 conf 必须被备份里的 conf 替换"
        );
        assert_eq!(
            std::fs::read(app_data.join("settings.json")).expect("读设置"),
            b"backup",
            "其余文件照常覆盖"
        );
        let leftovers = std::fs::read_dir(&app_data)
            .expect("读 app data")
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("restore-old"))
            .count();
        assert_eq!(leftovers, 0, "挪开的旧库应被清理");
    }

    /// T-046：v1 数据库复制失败时，旧库必须 rename 回来，用户数据完好。
    #[test]
    fn restore_v1_rolls_back_old_db_when_copy_fails() {
        let tmp = TempDir::new("v1-rollback");
        let app_data = tmp.child("com.my-chat");
        let app_db = app_data.join(SLED_DB_DIR);
        std::fs::create_dir_all(&app_db).expect("建旧库");
        std::fs::write(app_db.join("old-segment.bin"), b"old-seg").expect("写旧段");

        // 备份的 sled_db 是普通文件：rename 走完之后整目录复制必然失败。
        let backup = tmp.child("my-chat-backup-14");
        std::fs::create_dir_all(&backup).expect("建备份目录");
        std::fs::write(backup.join(SLED_DB_DIR), b"not a dir").expect("写占位文件");

        let err = restore_v1_from(&backup, &app_data).expect_err("复制失败必须上报");
        assert!(err.contains("已恢复旧库"), "错误应说明已回滚: {err}");
        assert_eq!(
            std::fs::read(app_db.join("old-segment.bin")).expect("旧库应完好"),
            b"old-seg",
            "失败时旧库必须 rename 回来"
        );
        let leftovers = std::fs::read_dir(&app_data)
            .expect("读 app data")
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("restore-old"))
            .count();
        assert_eq!(leftovers, 0, "回滚后不得留下 parked 目录");
    }

    #[test]
    fn snapshot_name_uses_millisecond_timestamp() {
        let tmp = TempDir::new("snapshot-ms");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(&app_data).expect("建 app data");

        let db = open_temp_sled(&app_data);
        let snap = snapshot_before_restore(&app_data, &db).expect("快照应成功");
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

    /// T-048：非备份目录（`.ssh`、应用数据目录）不得上传。
    #[test]
    fn webdav_upload_only_accepts_backup_dirs() {
        let tmp = TempDir::new("upload-root");
        let app_data = tmp.child("com.my-chat");
        std::fs::create_dir_all(app_data.join("adapters")).expect("建 app data");
        let ssh = tmp.child(".ssh");
        std::fs::create_dir_all(&ssh).expect("建 .ssh");
        std::fs::write(ssh.join("id_rsa"), b"secret").expect("写密钥");

        let err = validate_upload_root(&ssh, &app_data).expect_err(".ssh 必须拒绝上传");
        assert!(err.contains("拒绝上传"), "错误应说明拒绝上传: {err}");
        let err =
            validate_upload_root(&app_data, &app_data).expect_err("应用数据目录自身必须拒绝上传");
        assert!(err.contains("拒绝上传"), "错误应说明拒绝上传: {err}");

        let backup = make_backup(tmp.path(), "my-chat-backup-20", Some(SLED_EXPORT_FILE));
        std::fs::write(backup.join(SLED_EXPORT_FILE), b"[]").expect("写导出");
        assert!(
            validate_upload_root(&backup, &app_data).is_ok(),
            "合法备份目录应允许上传"
        );
    }

    /// T-048：相对路径按段 percent-encode，`?`/`#`/空格/中文都不能破坏 URL。
    #[test]
    fn webdav_rel_path_is_percent_encoded_per_segment() {
        assert_eq!(encode_rel_path("a.bin"), "a.bin");
        assert_eq!(
            encode_rel_path("sub dir/?#.txt"),
            "sub%20dir/%3F%23.txt",
            "空格、?、# 必须编码，分隔符 / 保留"
        );
        assert_eq!(
            encode_rel_path("会话/1.json"),
            "%E4%BC%9A%E8%AF%9D/1.json",
            "非 ASCII 按 UTF-8 字节编码"
        );
    }

    /// T-049：单文件上限与总量上限分开，边界可测。
    #[test]
    fn single_file_limit_is_one_gib() {
        assert_eq!(MAX_SINGLE_FILE_BYTES, 1024 * 1024 * 1024);
        assert!(check_single_file_size(0, "a").is_ok());
        assert!(check_single_file_size(MAX_SINGLE_FILE_BYTES, "a").is_ok());
        let err = check_single_file_size(MAX_SINGLE_FILE_BYTES + 1, "big.bin")
            .expect_err("超过单文件上限必须拒绝");
        assert!(err.contains("big.bin"), "错误应点名文件: {err}");
    }

    /// T-049：流式 body 不预读整份文件，但必须报告真实长度。
    #[test]
    fn stream_file_body_reports_real_length() {
        let tmp = TempDir::new("stream-body");
        let f = tmp.child("payload.bin");
        std::fs::write(&f, vec![7u8; 200_000]).expect("写文件");
        let (_body, len) = stream_file_body(&f).expect("构造流式 body 应成功");
        assert_eq!(len, 200_000, "body 必须报告真实文件长度");
    }

    /// T-050：`dir_size` 不得跟随指回上层的目录联接（旧实现会无限递归爆栈）。
    #[cfg(windows)]
    #[test]
    fn dir_size_does_not_follow_junction_cycles() {
        let tmp = TempDir::new("junction-cycle");
        std::fs::write(tmp.child("keep.bin"), vec![0u8; 5]).expect("写文件");
        let link = tmp.child("loop");
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(tmp.path())
            .output();
        let Ok(output) = output else {
            eprintln!("跳过：无法执行 mklink");
            return;
        };
        if !output.status.success() {
            eprintln!(
                "跳过：当前环境不允许创建 junction: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        // 跟随联接的话这里会无限递归（旧实现直接爆栈）。
        assert_eq!(dir_size(tmp.path()), 5, "目录联接不得被跟随");
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
