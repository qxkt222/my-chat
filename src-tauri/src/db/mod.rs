// db/mod.rs — Sled embedded database (pure Rust, zero C deps)
use sled::Db;
use std::path::PathBuf;

pub mod conversations;
pub mod encryption;
pub mod import;
pub mod knowledge;
pub mod memory;
pub mod migration;
pub mod settings;
pub mod skills;

/// 恢复流程留下的待导入文件（与 `sled_db` 同级，即 `app_data/sled_import.pending.json`）。
/// 内容是一份 `SledExport` 的 JSON —— 而不是 sled 的物理文件：运行中的 sled 持有
/// 字节范围锁，物理复制必然 `os error 33`。
pub const SLED_IMPORT_PENDING: &str = "sled_import.pending.json";

/// sled 逻辑导出的**物化**形式：`(collection_type, collection_name, [[key, value], ...])`。
///
/// `sled::Db::export()` 的第三项是惰性迭代器，必须先收集才能跨函数传递 / 序列化。
/// 注意 `Vec<u8>` 经 `serde_json` 会写成数字数组，体积约为原始数据的数倍（实测见
/// `commands::backup` 的 `backup_export_size_ratio`），换来的是与 sled 物理格式解耦。
pub type SledExport = Vec<(Vec<u8>, Vec<u8>, Vec<Vec<Vec<u8>>>)>;

/// 把整个库导出为可 JSON 序列化的物化结构（只读，不 flush、不改库）。
pub fn export_all(db: &Db) -> SledExport {
    db.export()
        .into_iter()
        .map(|(collection_type, name, iter)| (collection_type, name, iter.collect()))
        .collect()
}

/// 解析并校验导出数据，**不触碰数据库**。
///
/// 恢复流程在删掉现有 `sled_db` 之前先用它验证文件可解析：否则坏文件会让用户
/// 既没了旧库、也没导入新库。
pub fn parse_export(bytes: &[u8]) -> Result<SledExport, String> {
    let export: SledExport =
        serde_json::from_slice(bytes).map_err(|e| format!("sled 导出数据无法解析: {e}"))?;
    validate_collections(&export)?;
    Ok(export)
}

/// `sled::Db::import` 遇到未知 collection type 会 `panic!`（db.rs:384），
/// 所以手工构造 / 被篡改的备份必须在进入 import 之前就被拒绝。
fn validate_collections(export: &SledExport) -> Result<(), String> {
    for (collection_type, name, _) in export {
        if collection_type.as_slice() != b"tree" {
            return Err(format!(
                "未知集合类型 {:?}（tree {}），已拒绝导入",
                String::from_utf8_lossy(collection_type),
                String::from_utf8_lossy(name)
            ));
        }
    }
    Ok(())
}

/// 导入目标必须是空库：`sled::Db::import` 对已存在的 key 会
/// `assert!(old.is_none())` **panic**（db.rs:381-384）。
///
/// 用 `export()` 直接判断「是否还有任何键」——与 import 实际遍历的集合完全一致，
/// 不依赖 sled 内部文件布局。
fn ensure_db_empty(db: &Db) -> Result<(), String> {
    for (_collection_type, name, mut iter) in db.export() {
        if iter.next().is_some() {
            return Err(format!(
                "目标数据库非空（tree {}），已取消导入以免覆盖已有数据",
                String::from_utf8_lossy(&name)
            ));
        }
    }
    Ok(())
}

/// 把导出数据导入**空库**并落盘。拒绝（Err）而非 panic 的所有情况都在这里前置判断。
pub fn import_export_into(db: &Db, export: SledExport) -> Result<(), String> {
    validate_collections(&export)?;
    ensure_db_empty(db)?;
    // import 要求第三项是**同一个**具体迭代器类型；Vec::into_iter 满足。
    let rebuilt = export
        .into_iter()
        .map(|(collection_type, name, kvs)| (collection_type, name, kvs.into_iter()))
        .collect::<Vec<_>>();
    db.import(rebuilt);
    db.flush().map_err(|e| format!("导入后 flush 失败: {e}"))?;
    Ok(())
}

/// 启动时（sled 已打开、`run_migrations` 之前）执行：若存在待导入文件，导入空库。
///
/// 顺序很关键：迁移要读库里的 schema 版本，所以导入必须先于迁移完成。
/// 任何一步失败都**保留**待导入文件（数据不丢），但库非空时绝不进入
/// `sled::Db::import` —— 那条路是 panic。
pub fn run_pending_import(db: &Db) -> Result<(), String> {
    let pending = app_db_path().with_file_name(SLED_IMPORT_PENDING);
    if !pending.exists() {
        return Ok(());
    }
    let bytes = std::fs::read(&pending).map_err(|e| {
        format!(
            "读取待导入数据失败（文件已保留）: {} ({e})",
            pending.display()
        )
    })?;
    let export = parse_export(&bytes)?;
    import_export_into(db, export)?;
    std::fs::remove_file(&pending).map_err(|e| {
        format!(
            "导入成功但删除待导入文件失败: {} ({e})；请手动删除，否则下次启动会被「非空库」保护拦住",
            pending.display()
        )
    })?;
    Ok(())
}

static DB_INSTANCE: std::sync::LazyLock<Result<Db, String>> = std::sync::LazyLock::new(|| {
    let path = app_db_path();
    let _ = std::fs::create_dir_all(&path);
    let db = sled::open(&path).map_err(|e| format!("Open DB: {e}"))?;
    // 恢复流程留下的逻辑导出：必须在迁移之前导入（迁移按库里的版本号决定动作）。
    // 导入失败（例如库非空）让整个启动失败，但绝不 panic、也绝不覆盖已有数据。
    run_pending_import(&db)?;
    Ok(db)
});

pub fn app_db_path() -> PathBuf {
    let base = std::env::var("APPDATA").map_or_else(
        |_| {
            PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
                .join("AppData")
                .join("Roaming")
        },
        PathBuf::from,
    );
    base.join("com.my-chat").join("sled_db")
}

pub fn init_db() -> Result<(), String> {
    let _ = db()?;
    // Schema 迁移:读版本 → 顺序执行 → 写回版本(幂等;失败保留回滚 marker,
    // 下次启动 run_pending_migration_rollback 恢复快照)
    migration::run_migrations()?;
    Ok(())
}

pub fn db() -> Result<&'static Db, String> {
    match DB_INSTANCE.as_ref() {
        Ok(db) => Ok(db),
        Err(e) => Err(e.clone()),
    }
}

pub fn tree(name: &str) -> Result<sled::Tree, String> {
    db()?
        .open_tree(name)
        .map_err(|e| format!("Tree '{name}': {e}"))
}

pub fn key(prefix: &str, id: &str) -> Vec<u8> {
    format!("{prefix}:{id}").into_bytes()
}

pub fn scan_prefix(tree: &sled::Tree, prefix: &str) -> Vec<(Vec<u8>, Vec<u8>)> {
    tree.scan_prefix(prefix.as_bytes())
        .filter_map(std::result::Result::ok)
        .map(|(k, v)| (k.to_vec(), v.to_vec()))
        .collect()
}

#[cfg(test)]
mod export_tests {
    use super::*;

    /// 临时 sled 库。字段顺序不重要 —— `Drop` 里显式先关库再删目录，
    /// 否则 Windows 上 db 还开着，删目录会静默失败留下垃圾。
    struct TempDb {
        dir: PathBuf,
        db: Option<Db>,
    }

    impl TempDb {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("mychat-dbexport-{tag}-{}", uuid::Uuid::new_v4()));
            let _ = std::fs::remove_dir_all(&dir);
            let db = sled::open(&dir).expect("打开临时 sled");
            Self { dir, db: Some(db) }
        }

        fn db(&self) -> &Db {
            self.db.as_ref().expect("db 存活")
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            drop(self.db.take());
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn seed(db: &Db) {
        let conv = db.open_tree("conversations").expect("建树");
        conv.insert(b"c:1", b"hello").expect("写 key");
        conv.insert(b"c:2", b"world").expect("写 key");
        db.open_tree("settings")
            .expect("建树")
            .insert(b"s:x", b"7")
            .expect("写 key");
        db.flush().expect("flush");
    }

    /// 写 key → export → JSON → import 到**空**临时库 → 键值与全库校验和一致。
    #[test]
    fn export_import_roundtrip_preserves_kv() {
        let src = TempDb::new("rt-src");
        seed(src.db());

        let bytes = serde_json::to_vec(&export_all(src.db())).expect("序列化导出");
        let decoded = parse_export(&bytes).expect("导出的 JSON 应可解析");

        let dst = TempDb::new("rt-dst");
        import_export_into(dst.db(), decoded).expect("空库导入应成功");

        assert_eq!(
            dst.db()
                .open_tree("conversations")
                .expect("建树")
                .get(b"c:1")
                .expect("读 key")
                .as_deref(),
            Some(&b"hello"[..])
        );
        assert_eq!(
            dst.db()
                .open_tree("conversations")
                .expect("建树")
                .get(b"c:2")
                .expect("读 key")
                .as_deref(),
            Some(&b"world"[..])
        );
        assert_eq!(
            dst.db()
                .open_tree("settings")
                .expect("建树")
                .get(b"s:x")
                .expect("读 key")
                .as_deref(),
            Some(&b"7"[..])
        );
        assert_eq!(
            src.db().checksum().expect("src checksum"),
            dst.db().checksum().expect("dst checksum"),
            "全库校验和必须一致"
        );
    }

    /// 非空库导入：必须返回 Err，而不是走进 sled 的 `assert!(old.is_none())` panic。
    #[test]
    fn import_into_non_empty_db_returns_err_and_keeps_data() {
        let src = TempDb::new("guard-src");
        src.db()
            .open_tree("conversations")
            .expect("建树")
            .insert(b"c:1", b"new")
            .expect("写 key");
        let decoded = parse_export(&serde_json::to_vec(&export_all(src.db())).expect("序列化"))
            .expect("解析");

        let dst = TempDb::new("guard-dst");
        let tree = dst.db().open_tree("conversations").expect("建树");
        tree.insert(b"c:1", b"existing").expect("写 key");
        tree.flush().expect("flush");

        let err = import_export_into(dst.db(), decoded).expect_err("非空库必须拒绝导入");
        assert!(err.contains("非空"), "错误应说明库非空: {err}");
        assert_eq!(
            tree.get(b"c:1").expect("读 key").as_deref(),
            Some(&b"existing"[..]),
            "原有数据不得被覆盖"
        );
    }

    /// `sled::import` 对未知 collection type 会 panic；必须在进入前拒绝。
    #[test]
    fn unknown_collection_type_is_rejected() {
        let dst = TempDb::new("bad-ct");
        let bad: SledExport = vec![(b"bogus".to_vec(), b"t".to_vec(), Vec::new())];
        let err = import_export_into(dst.db(), bad).expect_err("未知集合类型必须拒绝");
        assert!(err.contains("未知集合类型"), "{err}");
    }

    /// 坏 JSON 不得被当成可导入数据。
    #[test]
    fn malformed_export_json_is_rejected() {
        let err = parse_export(b"{not json").expect_err("坏 JSON 必须拒绝");
        assert!(err.contains("无法解析"), "{err}");
    }
}
