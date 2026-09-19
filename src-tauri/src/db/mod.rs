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

static DB_INSTANCE: std::sync::LazyLock<Result<Db, String>> = std::sync::LazyLock::new(|| {
    let path = app_db_path();
    let _ = std::fs::create_dir_all(&path);
    sled::open(&path).map_err(|e| format!("Open DB: {e}"))
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
