// db/migration.rs — DB Schema 迁移框架
//
// sled KV + JSON 存储天然向后兼容(#[serde(default)]),但加字段只解决
// "旧数据能读",不解决"数据升级"(旧格式错误不会自动修、结构迁移无从谈起)。
// 本框架:版本号 + 迁移链 + 启动顺序执行 + 迁移前快照回滚。
//
// 流程:
//   main.rs setup(DB 打开前):
//     run_pending_restore → run_pending_migration_rollback → preflight_snapshot → init_db
//   preflight_snapshot:读【文件侧】schema_version.txt(不依赖 sled),若 < LATEST 且
//     sled_db 存在 → 在 DB 打开前快照 sled_db(此时文件未被锁,拷贝安全)+ 写回滚 marker
//   init_db → run_migrations:
//     读 db_meta 树 meta:version(缺省 1)
//     若 < LATEST → 顺序执行 MIGRATIONS(幂等)→ 写回版本 → flush → 删 marker → 写文件版本
//   迁移失败 → 保留 marker,下次启动 run_pending_migration_rollback 在 DB 打开前回滚快照
//
// 重要:sled 打开后其 db 文件被 Windows 锁,【迁移前快照必须在 DB 打开前做】——
// 曾经把快照放在 run_migrations 内(DB 已打开)导致 os error 33 启动崩溃,已修。
// 文件侧版本号与 sled 内版本号双写,迁移成功后同步;无文件视为旧库(需快照+迁移)。

use super::{key, scan_prefix};
use sled::Db;
use std::path::Path;

/// 迁移函数签名:把版本 v 升级到 v+1(幂等,内部 flush)
pub type MigrationFn = fn(&Db) -> Result<(), String>;

/// 当前最新 schema 版本(= 初始 1 + 迁移数)
pub const SCHEMA_VERSION_LATEST: i64 = 1 + MIGRATIONS.len() as i64;

/// 迁移注册表:MIGRATIONS[i] 把版本 i+1 升级到 i+2。
/// 新增迁移:在数组末尾追加一个纯函数,版本号自动 +1。
pub const MIGRATIONS: &[MigrationFn] = &[
    migrate_1_to_2, // 回填 memories embedding(替代逐条查询时自愈)
    migrate_2_to_3, // 回填 knowledge_chunks embedding
];

/// 文件侧版本号(`schema_version.txt`,`app_data_dir` 下)。
/// 作用:DB 打开前判断"是否需要迁移/快照",避免打开 sled 才能读版本。
/// 无文件 = 旧库未知 → 视为需迁移(触发快照);迁移成功后与 sled 内版本同步写。
const SCHEMA_FILE: &str = "schema_version.txt";

/// 迁移快照目录名前缀（与 [`snapshot_before_migration`] 生成的名字一致）。
/// 回滚时只认这个前缀，避免 marker 被改写成任意目录后照样被拷进数据库。
const MIGRATION_SNAPSHOT_PREFIX: &str = "migration-snapshot-";

fn app_data_dir() -> std::path::PathBuf {
    let base = std::env::var("APPDATA").map_or_else(
        |_| {
            std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
                .join("AppData")
                .join("Roaming")
        },
        std::path::PathBuf::from,
    );
    base.join("com.my-chat")
}

fn schema_file_path() -> std::path::PathBuf {
    app_data_dir().join(SCHEMA_FILE)
}

/// 文件侧版本(缺省 0 = 无文件/旧库未知 → 需要快照+迁移)
fn file_version() -> i64 {
    std::fs::read_to_string(schema_file_path())
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(0)
}

fn write_file_version(v: i64) {
    let _ = std::fs::write(schema_file_path(), v.to_string());
}

fn unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// 读当前 schema 版本(缺省 1 = 初始库)
fn current_version(db: &Db) -> i64 {
    let t = db.open_tree("db_meta").ok();
    if let Some(t) = t {
        if let Ok(Some(raw)) = t.get(key("meta", "version")) {
            if let Ok(s) = std::str::from_utf8(&raw) {
                if let Ok(v) = s.trim().parse::<i64>() {
                    return v;
                }
            }
        }
    }
    1
}

fn write_version(db: &Db, v: i64) -> Result<(), String> {
    let t = db
        .open_tree("db_meta")
        .map_err(|e| format!("打开 db_meta: {e}"))?;
    t.insert(key("meta", "version"), v.to_string().as_bytes().to_vec())
        .map_err(|e| format!("写版本失败: {e}"))?;
    Ok(())
}

/// 迁移前快照 `sled_db` 到 app_data_dir/migration-snapshot-<unix>,写回滚 marker。
/// **必须在 sled 打开前调用**(打开后 db 文件被 Windows 锁,拷贝会 os error 33)。
fn snapshot_before_migration() -> Result<String, String> {
    let src = super::app_db_path();
    if !src.is_dir() {
        return Ok(String::new()); // 新库,无需快照
    }
    let snap = app_data_dir().join(format!("{MIGRATION_SNAPSHOT_PREFIX}{}", unix_secs()));
    crate::commands::backup::copy_dir_all(&src, &snap)?;
    let marker = app_data_dir().join("migration_pending.txt");
    std::fs::write(&marker, snap.to_string_lossy().to_string())
        .map_err(|e| format!("写迁移回滚标记失败: {e}"))?;
    Ok(snap.to_string_lossy().to_string())
}

/// 迁移全部成功 → 删除回滚 marker(快照保留,供人工排查)
fn clear_migration_marker() {
    let _ = std::fs::remove_file(app_data_dir().join("migration_pending.txt"));
}

/// 校验 marker 指向的回滚快照，返回规范化后的真实路径。
///
/// marker 是 `app_data_dir` 下的普通文本文件，可被任意本地进程改写。旧实现
/// 只检查 `snap.is_dir()`，于是把 marker 改成 `C:\Users\<me>` 或应用数据
/// 目录本身，回滚就会把那个目录整树 `copy_dir_all` 进 `sled_db`。
/// 判据必须落在数据本体上：
/// 1. `canonicalize` 成功：顺带解掉 `..`、符号链接与目录联接，后续判断
///    一律基于解析后的真实路径；
/// 2. 目录名必须以 [`MIGRATION_SNAPSHOT_PREFIX`] 开头 —— 只认本模块生成的
///    快照名，任意用户目录不能冒充；
/// 3. 必须是目录且含 sled 的数据文件 `db` —— 只有 `conf`/`blobs` 的是半份
///    拷贝，拷回去等于把库换成空库；
/// 4. 不能是应用数据目录本身，也不能是它的**祖先** —— 否则回滚会把用户
///    数据整棵树拷进数据库。
fn validate_rollback_snapshot_at(
    snap: &Path,
    app_data: &Path,
) -> Result<std::path::PathBuf, String> {
    let canonical = std::fs::canonicalize(snap)
        .map_err(|e| format!("回滚快照不存在或不可访问: {} ({e})", snap.display()))?;
    if !canonical.is_dir() {
        return Err(format!("回滚快照不是目录: {}", canonical.display()));
    }
    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if !name.starts_with(MIGRATION_SNAPSHOT_PREFIX) {
        return Err(format!(
            "快照目录名必须以 {MIGRATION_SNAPSHOT_PREFIX} 开头（实际 {name}）"
        ));
    }
    if !canonical.join("db").is_file() {
        return Err(format!(
            "快照缺少 sled 数据文件 db（疑似半份拷贝）: {}",
            canonical.display()
        ));
    }
    if let Some(app_canonical) = resolve_app_data(app_data) {
        if canonical == app_canonical {
            return Err("快照不能是应用数据目录自身".to_string());
        }
        // 逐组件前缀比较：目标若是 app data 的祖先，回滚会连用户数据一起拷走。
        if app_canonical.starts_with(&canonical) {
            return Err(format!(
                "{} 是应用数据目录的上级，回滚会覆盖用户数据",
                canonical.display()
            ));
        }
    }
    Ok(canonical)
}

/// 解析应用数据目录的真实路径，**不要求它已存在**。
///
/// 全新安装时 `com.my-chat` 可能还没建出来；此时若直接 `canonicalize`
/// 失败就跳过祖先检查，一个名字恰好带快照前缀的上级目录就能被回滚覆盖。
/// 退路是规范化父目录再拼上末段名字 —— APPDATA 本身几乎总是存在的。
fn resolve_app_data(app_data: &Path) -> Option<std::path::PathBuf> {
    if let Ok(p) = std::fs::canonicalize(app_data) {
        return Some(p);
    }
    let parent = std::fs::canonicalize(app_data.parent()?).ok()?;
    Some(parent.join(app_data.file_name()?))
}

/// 启动时(DB 打开前)执行:若上次迁移失败留下 marker,把 `sled_db` 回滚到迁移前快照。
/// main.rs 在 `run_pending_restore` 之后、`preflight_snapshot`/`init_db` 之前调用。
pub fn run_pending_migration_rollback() -> Result<(), String> {
    let app_data = app_data_dir();
    let marker = app_data.join("migration_pending.txt");
    if !marker.exists() {
        return Ok(());
    }
    let snap = std::path::PathBuf::from(std::fs::read_to_string(&marker).unwrap_or_default());
    // marker 可被第三方改写：只有通过数据本体校验的快照才允许替换数据库。
    // 不合法时删 marker + 落 chat_errors.log(启动错误最终只写到
    // migration_error.log，用户不一定看得到)，然后以 Err 返回让调用方记录。
    let snap = match validate_rollback_snapshot_at(&snap, &app_data) {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_file(&marker);
            crate::commands::chat::log_chat_error(&format!("迁移回滚已取消: {e}"));
            return Err(format!("迁移回滚已取消: {e}"));
        }
    };
    let dest = super::app_db_path();
    let staging = dest.with_file_name(format!(
        "sled_db.rollback-staging-{}-{}",
        unix_secs(),
        std::process::id()
    ));
    // 关键(RS-19):旧实现先 remove_dir_all 再 copy —— 中途失败(断电/磁盘满/
    // 文件被占用)会把唯一的原库连同半份新库一起留下,数据全毁。改为:
    //   快照 → 临时目录(原库不动) → rename 原库到备份名 → rename 临时目录就位
    // 任何一步失败都保留/恢复原库。
    swap_in_snapshot(&snap, &dest, &staging, |src, dst| {
        crate::commands::backup::copy_dir_all(src, dst)
    })?;
    let _ = std::fs::remove_file(&marker);
    Ok(())
}

/// 回滚的原子交换核心(可注入 copy,便于测试中途失败)。
///
/// 前置:`snap` 是完整快照目录。步骤:
/// 1. `copy(snap, staging)` —— 只动临时目录,原库不变;失败则清临时目录返回 Err。
/// 2. 原 `dest` rename 到唯一备份名(同卷,原子)。
/// 3. `staging` rename 到 `dest`;失败则把备份 rename 回 `dest` 后返回 Err。
/// 4. 删除备份。
///
/// 返回 Err 时保证 `dest` 仍是调用前的原库(或根本不存在)。
fn swap_in_snapshot<F>(snap: &Path, dest: &Path, staging: &Path, copy: F) -> Result<(), String>
where
    F: Fn(&Path, &Path) -> Result<(), String>,
{
    // 清理上次失败残留的临时目录(只清理本函数命名空间内的路径)
    if staging.exists() {
        std::fs::remove_dir_all(staging).map_err(|e| format!("清理回滚临时目录失败: {e}"))?;
    }
    if let Err(e) = copy(snap, staging) {
        let _ = std::fs::remove_dir_all(staging);
        return Err(format!("回滚快照拷贝失败,原库未改动: {e}"));
    }

    let backup = dest.with_file_name(format!(
        "{}.rollback-old-{}-{}",
        dest.file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().to_string()),
        unix_secs(),
        std::process::id()
    ));
    let had_dest = dest.exists();
    if had_dest {
        if let Err(e) = std::fs::rename(dest, &backup) {
            let _ = std::fs::remove_dir_all(staging);
            return Err(format!("回滚时挪开原库失败(原库未改动): {e}"));
        }
    }
    if let Err(e) = std::fs::rename(staging, dest) {
        // 恢复原库:把备份 rename 回去
        if had_dest {
            let _ = std::fs::rename(&backup, dest);
        }
        let _ = std::fs::remove_dir_all(staging);
        return Err(format!("回滚交换失败,已恢复原库: {e}"));
    }
    if had_dest {
        let _ = std::fs::remove_dir_all(&backup);
    }
    Ok(())
}

/// 启动预检(DB 打开前):文件版本 < `LATEST` 且 `sled_db` 存在 → 迁移前快照。
/// 必须在 `init_db`(打开 sled)之前调用;失败不阻止启动(迁移幂等,可后续重试)。
pub fn preflight_snapshot() -> Result<(), String> {
    if file_version() >= SCHEMA_VERSION_LATEST {
        return Ok(()); // 已是最新,无需快照/迁移
    }
    if !super::app_db_path().is_dir() {
        return Ok(()); // 全新安装,无旧库
    }
    snapshot_before_migration()?;
    Ok(())
}

/// 主入口:读版本 → 顺序执行迁移 → 写回版本 → flush → 写文件版本。
/// 由 `init_db` 调用(sled 已打开,因此【不在此处做文件快照】——
/// 快照由 `preflight_snapshot` 在 DB 打开前完成)。
/// 迁移失败返回 Err 并保留回滚 marker(下次启动 rollback 后重试)。
pub fn run_migrations() -> Result<(), String> {
    let db = super::db()?;
    if let Err(e) = migrate_db(db) {
        // 除返回值外再落一份文件:setup 的错误最终只会变成启动失败,
        // 用户看不到 stderr;migration_error.log 至少能在排障时读到原因。
        let _ = std::fs::write(app_data_dir().join("migration_error.log"), format!("{e}\n"));
        return Err(e);
    }
    let _ = db.flush();
    clear_migration_marker();
    // 双版本同步:文件侧版本写为 LATEST(下次启动 preflight 跳过快照)
    write_file_version(SCHEMA_VERSION_LATEST);
    Ok(())
}

/// 迁移核心(可单测):读版本 → 检查 → 顺序执行迁移 → 写回版本。
///
/// RS-19:库版本**高于**本程序支持的最新版本时直接 Err。旧实现
/// `if from >= LATEST { return Ok(()) }` 会让旧版程序照常打开新版库、
/// 继续读写成"看似正常"的状态,直到某次写入把新字段/新结构破坏。
/// 现在启动即失败(main.rs setup 返回 Err,应用不进入主界面),错误信息
/// 明确告知"数据由更新版本创建"。
fn migrate_db(db: &Db) -> Result<(), String> {
    let from = current_version(db);
    if from > SCHEMA_VERSION_LATEST {
        return Err(format!(
            "数据库 schema 版本为 {from},高于本程序支持的最新版本 {SCHEMA_VERSION_LATEST};\
             数据可能由更新版本的 my-chat 创建。请升级程序后再打开(已停止迁移与读写,避免损坏数据)。"
        ));
    }
    if from == SCHEMA_VERSION_LATEST {
        return Ok(());
    }
    let mut v = from;
    for (i, m) in MIGRATIONS.iter().enumerate() {
        let target = i as i64 + 2;
        if v < target {
            m(db)?;
            v = target;
            write_version(db, v)?;
        }
    }
    Ok(())
}

// ── 迁移实现 ─────────────────────────────────────────────

/// m2: memories 急切回填 embedding(此前靠 `search_memories` 查询时逐条自愈)。
/// 幂等:已有合法 embedding(len >= 4)的跳过。
fn migrate_1_to_2(db: &Db) -> Result<(), String> {
    let t = db
        .open_tree("memories")
        .map_err(|e| format!("打开 memories: {e}"))?;
    let mut updated = 0usize;
    for (k, v) in scan_prefix(&t, "mem:") {
        let Ok(mut mem) = serde_json::from_slice::<crate::db::memory::Memory>(&v) else {
            continue;
        };
        let ok = mem.embedding.as_ref().is_some_and(|b| b.len() >= 4);
        if ok {
            continue;
        }
        let emb = crate::rag::embedder::keyword_embed(&mem.content);
        mem.embedding = Some(crate::db::memory::encode_embedding(&emb));
        t.insert(
            k,
            serde_json::to_vec(&mem).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("写回: {e}"))?;
        updated += 1;
    }
    if updated > 0 {
        let _ = t.flush();
    }
    Ok(())
}

/// m3: `knowledge_chunks` 回填缺失 embedding(缺失的 chunk 无法参与向量检索)。
/// 幂等:已有合法 embedding 的跳过。
fn migrate_2_to_3(db: &Db) -> Result<(), String> {
    let t = db
        .open_tree("knowledge_chunks")
        .map_err(|e| format!("打开 chunks: {e}"))?;
    let mut updated = 0usize;
    for (k, v) in scan_prefix(&t, "kc:") {
        let Ok(mut chunk) = serde_json::from_slice::<crate::db::knowledge::KnowledgeChunk>(&v)
        else {
            continue;
        };
        let ok = chunk.embedding.as_ref().is_some_and(|b| b.len() >= 4);
        if ok {
            continue;
        }
        let emb = crate::rag::embedder::keyword_embed(&chunk.content);
        chunk.embedding = Some(crate::db::knowledge::encode_embedding(&emb));
        t.insert(
            k,
            serde_json::to_vec(&chunk).map_err(|e| format!("Ser: {e}"))?,
        )
        .map_err(|e| format!("写回: {e}"))?;
        updated += 1;
    }
    if updated > 0 {
        let _ = t.flush();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时 sled 库(测试后自动清理)
    fn temp_db() -> sled::Db {
        let dir = std::env::temp_dir().join(format!("mychat-test-{}", uuid::Uuid::new_v4()));
        let db = sled::open(&dir).expect("open temp db");
        // 清理注册:测试进程退出前删目录
        let d = dir.clone();
        std::mem::forget(std::thread::spawn(move || {
            let _ = std::fs::remove_dir_all(d);
        }));
        db
    }

    #[test]
    fn version_defaults_to_1() {
        let db = temp_db();
        assert_eq!(current_version(&db), 1);
    }

    #[test]
    fn write_and_read_version() {
        let db = temp_db();
        write_version(&db, 3).unwrap();
        assert_eq!(current_version(&db), 3);
    }

    // ── RS-19: 版本高于最新必须拒绝 ───────────────────────

    #[test]
    fn newer_schema_is_rejected() {
        let db = temp_db();
        write_version(&db, SCHEMA_VERSION_LATEST + 1).unwrap();
        let err = migrate_db(&db).expect_err("库版本高于最新时必须拒绝");
        assert!(
            err.contains("更新版本"),
            "错误信息应说明数据由更新版本创建: {err}"
        );
        assert!(
            err.contains(&(SCHEMA_VERSION_LATEST + 1).to_string()),
            "错误信息应带上实际版本号: {err}"
        );
        // 拒绝时不得改写版本号
        assert_eq!(current_version(&db), SCHEMA_VERSION_LATEST + 1);
    }

    #[test]
    fn latest_schema_is_noop() {
        let db = temp_db();
        write_version(&db, SCHEMA_VERSION_LATEST).unwrap();
        assert!(migrate_db(&db).is_ok(), "已是新版应当直接通过");
        assert_eq!(current_version(&db), SCHEMA_VERSION_LATEST);
    }

    // ── RS-19: 回滚中途失败不得损坏原库 ───────────────────

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mychat-test-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// 注入"拷到一半失败":staging 里有半成品,但原库必须毫发无损。
    #[test]
    fn rollback_copy_failure_keeps_original_db() {
        let root = temp_dir("rollback-fail");
        let snap = root.join("snapshot");
        let dest = root.join("sled_db");
        let staging = root.join("sled_db.rollback-staging");
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::write(snap.join("snap.txt"), b"new").unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("original.txt"), b"keep-me").unwrap();

        let err = swap_in_snapshot(&snap, &dest, &staging, |_src, dst| {
            std::fs::create_dir_all(dst).unwrap();
            std::fs::write(dst.join("half.txt"), b"partial").unwrap();
            Err("injected copy failure".to_string())
        })
        .expect_err("注入的拷贝失败必须向上传递");
        assert!(err.contains("injected"), "{err}");

        // 原库原样保留,半成品不得混入
        assert_eq!(
            std::fs::read(dest.join("original.txt")).unwrap(),
            b"keep-me"
        );
        assert!(!dest.join("half.txt").exists(), "半成品不得落进原库");
        assert!(!staging.exists(), "临时目录应被清理");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 正常路径:快照完整替换原库。
    #[test]
    fn rollback_success_swaps_in_snapshot() {
        let root = temp_dir("rollback-ok");
        let snap = root.join("snapshot");
        let dest = root.join("sled_db");
        let staging = root.join("sled_db.rollback-staging");
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::write(snap.join("snap.txt"), b"new").unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("original.txt"), b"old").unwrap();

        swap_in_snapshot(
            &snap,
            &dest,
            &staging,
            crate::commands::backup::copy_dir_all,
        )
        .expect("回滚应当成功");

        assert!(dest.join("snap.txt").exists(), "快照内容应就位");
        assert!(
            !dest.join("original.txt").exists(),
            "旧库内容不应残留(回滚是替换语义)"
        );
        assert!(!staging.exists(), "临时目录应被清理");
        // 唯一备份名目录也不应残留
        let leftovers = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("rollback-old"))
            .count();
        assert_eq!(leftovers, 0, "备份目录应被删除");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ── 回滚 marker 校验：判据必须落在数据本体上 ─────────
    //
    // marker(`migration_pending.txt`)是 app_data_dir 下的普通文本文件，
    // 任意本地进程都能改写。旧实现只查 `is_dir()`，改写成
    // `C:\Users\<me>` 或应用数据目录后，回滚会把它整个拷进 sled_db。
    // 下面四条覆盖：任意目录 / 半份快照 / 应用数据目录自身与祖先 / 合法快照。

    /// 临时 app data 目录（`<temp>/com.my-chat`）。
    fn temp_app_data(tag: &str) -> std::path::PathBuf {
        let app = temp_dir(tag).join("com.my-chat");
        std::fs::create_dir_all(&app).expect("create app data dir");
        app
    }

    #[test]
    fn rollback_rejects_arbitrary_dir_without_prefix() {
        let app = temp_app_data("marker-arbitrary");
        let evil = app.parent().unwrap().join("user-docs");
        std::fs::create_dir_all(&evil).unwrap();
        std::fs::write(evil.join("db"), b"not-a-sled-db").unwrap();

        let err = validate_rollback_snapshot_at(&evil, &app)
            .expect_err("无 migration-snapshot- 前缀的任意目录必须拒绝");
        assert!(err.contains(MIGRATION_SNAPSHOT_PREFIX), "{err}");

        let _ = std::fs::remove_dir_all(app.parent().unwrap());
    }

    #[test]
    fn rollback_rejects_snapshot_without_db_file() {
        let app = temp_app_data("marker-no-db");
        let snap = app
            .parent()
            .unwrap()
            .join(format!("{MIGRATION_SNAPSHOT_PREFIX}123"));
        // 半份拷贝：只有 conf/blobs，没有 sled 的数据文件 db
        std::fs::create_dir_all(snap.join("blobs")).unwrap();
        std::fs::write(snap.join("conf"), b"{}").unwrap();

        let err =
            validate_rollback_snapshot_at(&snap, &app).expect_err("缺 db 文件的半份快照必须拒绝");
        assert!(err.contains("db"), "{err}");

        let _ = std::fs::remove_dir_all(app.parent().unwrap());
    }

    #[test]
    fn rollback_rejects_app_data_itself_and_ancestor() {
        let outer = temp_dir("marker-appdata");
        // 祖先：名字带前缀、也含 db，但应用数据目录在它内部 —— 回滚会连用户数据一起拷走
        let ancestor = outer.join(format!("{MIGRATION_SNAPSHOT_PREFIX}root"));
        std::fs::create_dir_all(&ancestor).unwrap();
        std::fs::write(ancestor.join("db"), b"x").unwrap();
        let nested_app = ancestor.join("com.my-chat");
        std::fs::create_dir_all(&nested_app).unwrap();

        let err = validate_rollback_snapshot_at(&ancestor, &nested_app)
            .expect_err("应用数据目录的祖先必须拒绝");
        assert!(err.contains("上级"), "{err}");

        // 自身：应用数据目录名恰好带前缀且含 db
        let self_app = outer.join(format!("{MIGRATION_SNAPSHOT_PREFIX}self"));
        std::fs::create_dir_all(&self_app).unwrap();
        std::fs::write(self_app.join("db"), b"x").unwrap();

        let err = validate_rollback_snapshot_at(&self_app, &self_app)
            .expect_err("应用数据目录自身必须拒绝");
        assert!(err.contains("自身"), "{err}");

        let _ = std::fs::remove_dir_all(&outer);
    }

    #[test]
    fn rollback_accepts_valid_snapshot() {
        let app = temp_app_data("marker-valid");
        let snap = app.join(format!("{MIGRATION_SNAPSHOT_PREFIX}1700000000"));
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::write(snap.join("db"), b"sled").unwrap();
        std::fs::write(snap.join("conf"), b"{}").unwrap();

        let got = validate_rollback_snapshot_at(&snap, &app).expect("合法快照必须通过");
        assert_eq!(got, std::fs::canonicalize(&snap).unwrap());

        let _ = std::fs::remove_dir_all(app.parent().unwrap());
    }

    #[test]
    fn m2_backfills_memory_embeddings() {
        let db = temp_db();
        // 旧记忆(无 embedding)直接塞 sled
        let t = db.open_tree("memories").unwrap();
        let mem = crate::db::memory::Memory {
            id: "m1".into(),
            content: "用户喜欢简洁回答".into(),
            tags_json: "[]".into(),
            enabled: true,
            created_at: "2026-01-01".into(),
            updated_at: "2026-01-01".into(),
            embedding: None,
            weight: 1.0,
        };
        t.insert(key("mem", "m1"), serde_json::to_vec(&mem).unwrap())
            .unwrap();
        // 执行迁移
        migrate_1_to_2(&db).unwrap();
        // 读回应有 embedding
        let raw = t.get(key("mem", "m1")).unwrap().unwrap();
        let updated: crate::db::memory::Memory = serde_json::from_slice(&raw).unwrap();
        // clippy::map_unwrap_or —— is_some_and 对 None 同样返回 false，语义不变
        assert!(updated.embedding.as_ref().is_some_and(|b| b.len() >= 4));
    }
}
