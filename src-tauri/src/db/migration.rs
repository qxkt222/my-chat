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
    let snap = app_data_dir().join(format!("migration-snapshot-{}", unix_secs()));
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

/// 启动时(DB 打开前)执行:若上次迁移失败留下 marker,把 `sled_db` 回滚到迁移前快照。
/// main.rs 在 `run_pending_restore` 之后、`preflight_snapshot`/`init_db` 之前调用。
pub fn run_pending_migration_rollback() -> Result<(), String> {
    let marker = app_data_dir().join("migration_pending.txt");
    if !marker.exists() {
        return Ok(());
    }
    let snap = std::path::PathBuf::from(std::fs::read_to_string(&marker).unwrap_or_default());
    if !snap.is_dir() {
        let _ = std::fs::remove_file(&marker);
        return Err(format!("迁移快照不存在,已取消回滚: {}", snap.display()));
    }
    // 清空当前 sled_db 目录再拷快照回来(避免残留文件)
    let dest = super::app_db_path();
    let _ = std::fs::remove_dir_all(&dest);
    crate::commands::backup::copy_dir_all(&snap, &dest)?;
    let _ = std::fs::remove_file(&marker);
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
    let from = current_version(db);
    if from >= SCHEMA_VERSION_LATEST {
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
    let _ = db.flush();
    clear_migration_marker();
    // 双版本同步:文件侧版本写为 LATEST(下次启动 preflight 跳过快照)
    write_file_version(SCHEMA_VERSION_LATEST);
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
