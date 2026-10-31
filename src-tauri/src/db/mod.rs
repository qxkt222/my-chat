// db/mod.rs — Sled embedded database (pure Rust, zero C deps)
use sled::Db;
use std::path::{Path, PathBuf};

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
/// 对同一 (tree, key) 的第二次插入还会 `assert!(old.is_none())` panic
/// （db.rs:381）——两类输入都必须在进入 import 之前返回可读 Err。
///
/// 同一棵 tree 可能被拆成多个条目出现在导出里，因此去重键是
/// `(tree 名, key)` 且跨条目累计；键值项不是 `[key, value]` 两条时同样
/// 会让 sled 的 `kv[0] / kv[1]` 越界 panic，一并前置拒绝。
fn validate_collections(export: &SledExport) -> Result<(), String> {
    use std::collections::HashSet;

    let mut seen: HashSet<(&[u8], &[u8])> = HashSet::new();
    for (collection_type, name, kvs) in export {
        if collection_type.as_slice() != b"tree" {
            return Err(format!(
                "未知集合类型 {:?}（tree {}），已拒绝导入",
                String::from_utf8_lossy(collection_type),
                String::from_utf8_lossy(name)
            ));
        }
        for kv in kvs {
            let [k, _v] = kv.as_slice() else {
                return Err(format!(
                    "tree {} 中有格式非法的键值项（长度 {}，应为 2）",
                    String::from_utf8_lossy(name),
                    kv.len()
                ));
            };
            if !seen.insert((name.as_slice(), k.as_slice())) {
                return Err(format!(
                    "导出数据中存在重复键（tree {}，key {}），导入会触发 sled panic，已拒绝",
                    String::from_utf8_lossy(name),
                    String::from_utf8_lossy(k)
                ));
            }
        }
    }
    Ok(())
}

/// 导入目标必须是空库：`sled::Db::import` 对已存在的 key 会
/// `assert!(old.is_none())` **panic**（db.rs:381-384）。
///
/// 用 `export()` 直接判断「是否还有任何键」——与 import 实际遍历的集合完全一致，
/// 不依赖 sled 内部文件布局。
///
/// `pub(crate)`：迁移预检（T-038）也要用它区分「全新空库」与「有数据但
/// 版本落后的旧库」——空库没有可丢的数据，不需要回滚快照。
pub(crate) fn ensure_db_empty(db: &Db) -> Result<(), String> {
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

/// 启动错误日志文件名（`app_data/startup_error.log`）。
///
/// release 构建没有控制台，启动失败必须有**用户可读**的现场：本文件与
/// `main.rs` 的原生错误对话框共同承担可见反馈。
pub const STARTUP_ERROR_LOG: &str = "startup_error.log";

/// 把启动期错误追加到 `app_data/startup_error.log`（保留历史，便于排障）。
///
/// 写入失败只忽略 —— 不能让「日志写不进去」掩盖真正的启动错误。
pub fn append_startup_error(app_data: &Path, message: &str) {
    use std::io::Write;
    let line = format!("[{}] {message}\n", unix_millis());
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(app_data.join(STARTUP_ERROR_LOG))
    {
        let _ = f.write_all(line.as_bytes());
    }
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn pending_path(db_dir: &Path) -> PathBuf {
    db_dir.with_file_name(SLED_IMPORT_PENDING)
}

/// 半成品库的隔离目录：与 `sled_db` 同级的 `sled_db.failed-<unix_ms>`。
///
/// **只隔离、不删除**：中断时的库可能仍含用户数据，留给人工抢救。
fn isolated_db_dir(db_dir: &Path) -> PathBuf {
    let name = db_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("sled_db");
    db_dir.with_file_name(format!("{name}.failed-{}", unix_millis()))
}

/// 启动时打开数据库并完成待导入（`DB_INSTANCE` 的唯一初始化入口）。
///
/// 顺序很关键：迁移要读库里的 schema 版本，所以导入必须先于 `run_migrations`。
///
/// 普通路径：库为空 → 导入 pending → 删除 pending。
///
/// 「非空库 + pending」= 上次导入中断（断电/被杀/磁盘满）留下的半成品：
/// 1. 把现有库目录整目录 rename 到 `sled_db.failed-<ms>`（隔离，**不删除**）；
/// 2. 重新打开空库并再次导入 pending，成功后删除 pending；
/// 3. 再次失败则删掉本次新建的半成品、把原库 rename 回原位，pending 原样保留，
///    并把可读原因（含 pending 路径）写进 `startup_error.log` 后返回 Err。
///
/// 因此最坏情况下磁盘状态仍是「原库 + pending」：下次启动会重试同一流程，
/// 即使 `DB_INSTANCE` 缓存了本次的 Err，也不会把用户卡在**不可恢复**状态。
fn open_db_with_pending_at(db_dir: &Path) -> Result<Db, String> {
    open_db_with_pending_using(db_dir, import_export_into)
}

/// [`open_db_with_pending_at`] 的可测核心：`import` 可注入，便于模拟重导失败。
fn open_db_with_pending_using(
    db_dir: &Path,
    import: impl Fn(&Db, SledExport) -> Result<(), String>,
) -> Result<Db, String> {
    std::fs::create_dir_all(db_dir)
        .map_err(|e| format!("创建数据库目录失败: {} ({e})", db_dir.display()))?;
    let db =
        sled::open(db_dir).map_err(|e| format!("打开数据库失败: {} ({e})", db_dir.display()))?;
    let pending = pending_path(db_dir);
    if !pending.exists() {
        return Ok(db);
    }
    let bytes = std::fs::read(&pending).map_err(|e| {
        format!(
            "读取待导入数据失败（文件已保留）: {} ({e})",
            pending.display()
        )
    })?;
    let export = parse_export(&bytes)
        .map_err(|e| format!("待导入数据不可用（文件保留在 {}）: {e}", pending.display()))?;
    // 空库：正常恢复路径（v2 restore 后的首次启动）。失败时 pending 保留，
    // 库可能只写了一半 —— 下次启动会走下面的隔离重导流程。
    if ensure_db_empty(&db).is_ok() {
        import(&db, export)?;
        remove_pending(&pending)?;
        return Ok(db);
    }
    recover_half_import(db_dir, db, &pending, export, &import)
}

fn remove_pending(pending: &Path) -> Result<(), String> {
    std::fs::remove_file(pending).map_err(|e| {
        format!(
            "导入成功但删除待导入文件失败: {} ({e})；请手动删除，否则下次启动会再次尝试导入",
            pending.display()
        )
    })
}

/// 「非空库 + pending」的恢复：隔离原库 → 空库重导。
///
/// 成功时保留隔离目录（不删用户数据）；失败时把原库换回原位。
/// 任何分支都不删除原库目录本身。
fn recover_half_import(
    db_dir: &Path,
    db: Db,
    pending: &Path,
    export: SledExport,
    import: &impl Fn(&Db, SledExport) -> Result<(), String>,
) -> Result<Db, String> {
    let app_data = db_dir.parent().unwrap_or(db_dir);
    let failed = isolated_db_dir(db_dir);
    // Windows 上库打开时目录被锁，rename 前必须先关闭句柄。
    drop(db);
    if let Err(e) = std::fs::rename(db_dir, &failed) {
        let msg = format!(
            "隔离半成品数据库失败（原库未改动，待导入文件保留在 {}）: {} -> {} ({e})",
            pending.display(),
            db_dir.display(),
            failed.display()
        );
        append_startup_error(app_data, &msg);
        return Err(msg);
    }

    let fresh = match sled::open(db_dir) {
        Ok(d) => d,
        Err(e) => {
            let restored = std::fs::rename(&failed, db_dir);
            let note = if restored.is_ok() {
                "原库已恢复".to_string()
            } else {
                format!(
                    "原库隔离目录保留在 {}（恢复失败，请手动改名回 {}）",
                    failed.display(),
                    db_dir.display()
                )
            };
            let msg = format!(
                "隔离后重新打开空库失败: {e}；{note}；待导入文件保留在 {}",
                pending.display()
            );
            append_startup_error(app_data, &msg);
            return Err(msg);
        }
    };

    match import(&fresh, export) {
        Ok(()) => {
            // 成功也要留痕：用户需要知道旧库被隔离到了哪里。
            append_startup_error(
                app_data,
                &format!(
                    "提示: 检测到半成品数据库，已隔离到 {} 并重新导入成功",
                    failed.display()
                ),
            );
            if let Err(e) = std::fs::remove_file(pending) {
                // 数据已经正确导入，不能因为删不掉 pending 就让应用起不来；
                // 下次启动会重复一次隔离导入，但不会丢数据。
                append_startup_error(
                    app_data,
                    &format!(
                        "警告: 半成品库已隔离到 {} 并重新导入成功，但删除待导入文件失败: {} ({e})",
                        failed.display(),
                        pending.display()
                    ),
                );
            }
            Ok(fresh)
        }
        Err(e) => {
            drop(fresh);
            // 新库是本次导入产生的半成品：删掉它才能把原库换回原位。
            if let Err(rm) = std::fs::remove_dir_all(db_dir) {
                let msg = format!(
                    "半成品库重新导入失败: {e}；原库隔离在 {}（未删除），新库残留于 {}（清理失败: {rm}）；待导入文件保留在 {}",
                    failed.display(),
                    db_dir.display(),
                    pending.display()
                );
                append_startup_error(app_data, &msg);
                return Err(msg);
            }
            let msg = match std::fs::rename(&failed, db_dir) {
                Ok(()) => format!(
                    "恢复待导入数据失败（原库已恢复，待导入文件保留在 {}）: {e}",
                    pending.display()
                ),
                Err(restore_err) => format!(
                    "恢复待导入数据失败: {e}；原库恢复失败，隔离目录保留在 {}（待导入文件保留在 {}）: {restore_err}",
                    failed.display(),
                    pending.display()
                ),
            };
            append_startup_error(app_data, &msg);
            Err(msg)
        }
    }
}

static DB_INSTANCE: std::sync::LazyLock<Result<Db, String>> = std::sync::LazyLock::new(|| {
    let path = app_db_path();
    // 恢复流程留下的逻辑导出必须在迁移之前导入（迁移按库里的版本号决定动作）。
    // 非空库 + pending 视为半成品隔离重导，绝不 panic、也绝不删除已有数据。
    open_db_with_pending_at(&path)
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

/// 一次前缀扫描的键值对。
pub type ScanKv = (Vec<u8>, Vec<u8>);

/// 收集一次前缀扫描的结果，**迭代器错误向上传播**（T-037）。
///
/// 旧实现是 `filter_map(Result::ok)`：读到一半 IO 出错时，剩下没读到的键
/// 被无声丢掉，调用方把半份数据当完整结果返回。抽成泛型是为了让单测能
/// 注入「先成功、再报错」的迭代器，验证错误不会被吞掉。
pub fn collect_scan<I>(prefix: &str, iter: I) -> Result<Vec<ScanKv>, String>
where
    I: Iterator<Item = sled::Result<(sled::IVec, sled::IVec)>>,
{
    let mut out = Vec::new();
    for item in iter {
        let (k, v) = item.map_err(|e| format!("扫描前缀 {prefix} 失败: {e}"))?;
        out.push((k.to_vec(), v.to_vec()));
    }
    Ok(out)
}

/// 可失败的 `scan_prefix`：读错误一律返回 `Err`，由调用方决定如何上报。
pub fn try_scan_prefix(tree: &sled::Tree, prefix: &str) -> Result<Vec<ScanKv>, String> {
    collect_scan(prefix, tree.scan_prefix(prefix.as_bytes()))
}

/// 兼容包装（`commands/mcp.rs` 仍用此签名，本轮不在改动范围内）。
///
/// 错误不再静默：落 `chat_errors.log` 后返回**空**结果，而不是把读到的
/// 半份数据当完整结果交出去。db 层内部一律用 [`try_scan_prefix`]。
pub fn scan_prefix(tree: &sled::Tree, prefix: &str) -> Vec<ScanKv> {
    match try_scan_prefix(tree, prefix) {
        Ok(v) => v,
        Err(e) => {
            crate::commands::chat::log_chat_error(&format!("DB_SCAN: {e}"));
            Vec::new()
        }
    }
}

/// 反序列化失败的统一留痕（T-037：坏记录不许静默丢弃）。
pub fn log_corrupt_record(context: &str, key: &[u8], err: &str) {
    crate::commands::chat::log_chat_error(&format!(
        "DB_CORRUPT: {context}: key={} ({err})",
        String::from_utf8_lossy(key)
    ));
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

    // ── T-036：重复 (tree, key) 必须前置拒绝，不能走到 sled 的 assert panic ──

    fn kv(k: &[u8], v: &[u8]) -> Vec<Vec<u8>> {
        vec![k.to_vec(), v.to_vec()]
    }

    /// 同一条目内重复 key。
    #[test]
    fn duplicate_key_in_same_entry_is_rejected() {
        let dst = TempDb::new("dup-same");
        let export: SledExport = vec![(
            b"tree".to_vec(),
            b"conversations".to_vec(),
            vec![kv(b"c:1", b"a"), kv(b"c:1", b"b")],
        )];
        let err = import_export_into(dst.db(), export).expect_err("重复 key 必须返回 Err");
        assert!(err.contains("重复键"), "错误应说明重复键: {err}");
        assert!(
            dst.db()
                .open_tree("conversations")
                .expect("建树")
                .is_empty(),
            "拒绝必须发生在 import 之前，不得写入任何数据"
        );
    }

    /// 同一 tree 被拆成多个条目时也要跨条目查重。
    #[test]
    fn duplicate_key_across_entries_is_rejected() {
        let export: SledExport = vec![
            (
                b"tree".to_vec(),
                b"conversations".to_vec(),
                vec![kv(b"c:1", b"a")],
            ),
            (
                b"tree".to_vec(),
                b"conversations".to_vec(),
                vec![kv(b"c:1", b"b")],
            ),
        ];
        let dst = TempDb::new("dup-cross");
        let err = import_export_into(dst.db(), export).expect_err("跨条目重复 key 必须拒绝");
        assert!(err.contains("重复键"), "{err}");

        // parse_export 同样是入口，也必须拒绝
        let bytes = serde_json::to_vec(&vec![
            (
                b"tree".to_vec(),
                b"conversations".to_vec(),
                vec![kv(b"c:1", b"a")],
            ),
            (
                b"tree".to_vec(),
                b"conversations".to_vec(),
                vec![kv(b"c:1", b"b")],
            ),
        ])
        .expect("序列化");
        assert!(parse_export(&bytes).is_err(), "parse_export 必须同样拒绝");
    }

    /// 键值项不是 [key, value] 时，sled 的 kv[0]/kv[1] 会越界 panic。
    #[test]
    fn malformed_kv_arity_is_rejected() {
        let export: SledExport = vec![(
            b"tree".to_vec(),
            b"conversations".to_vec(),
            vec![vec![b"only-key".to_vec()]],
        )];
        let dst = TempDb::new("bad-arity");
        let err = import_export_into(dst.db(), export).expect_err("非法键值项必须拒绝");
        assert!(err.contains("键值项"), "{err}");
    }
}

#[cfg(test)]
mod scan_tests {
    use super::*;

    /// T-037：迭代器中途报错必须整体返回 Err，不能把前半份数据当结果交出去。
    #[test]
    fn collect_scan_propagates_error_instead_of_partial_data() {
        let items: Vec<sled::Result<(sled::IVec, sled::IVec)>> = vec![
            Ok((sled::IVec::from(&b"k1"[..]), sled::IVec::from(&b"v1"[..]))),
            Err(sled::Error::Io(std::io::Error::other(
                "injected read error",
            ))),
            Ok((sled::IVec::from(&b"k2"[..]), sled::IVec::from(&b"v2"[..]))),
        ];
        let err = collect_scan("p:", items.into_iter()).expect_err("读错误必须向上传播");
        assert!(err.contains("injected read error"), "{err}");
        assert!(err.contains("p:"), "错误应带上扫描前缀便于定位: {err}");
    }

    /// 正常路径：键值按迭代顺序原样收集。
    #[test]
    fn collect_scan_returns_all_items_on_success() {
        let items: Vec<sled::Result<(sled::IVec, sled::IVec)>> = vec![
            Ok((sled::IVec::from(&b"k1"[..]), sled::IVec::from(&b"v1"[..]))),
            Ok((sled::IVec::from(&b"k2"[..]), sled::IVec::from(&b"v2"[..]))),
        ];
        let got = collect_scan("p:", items.into_iter()).expect("无错误时应成功");
        assert_eq!(
            got,
            vec![
                (b"k1".to_vec(), b"v1".to_vec()),
                (b"k2".to_vec(), b"v2".to_vec())
            ]
        );
    }
}

#[cfg(test)]
mod pending_import_tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("mychat-pending-{tag}-{}", uuid::Uuid::new_v4()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("创建临时目录");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn export_with(kvs: &[(&[u8], &[u8])]) -> SledExport {
        vec![(
            b"tree".to_vec(),
            b"conversations".to_vec(),
            kvs.iter()
                .map(|(k, v)| vec![k.to_vec(), v.to_vec()])
                .collect(),
        )]
    }

    /// 在 `db_dir` 建一个「导入中断留下的半成品库」。
    fn seed(db_dir: &Path, key: &[u8], value: &[u8]) {
        std::fs::create_dir_all(db_dir).expect("建库目录");
        let db = sled::open(db_dir).expect("打开库");
        db.open_tree("conversations")
            .expect("建树")
            .insert(key, value)
            .expect("写 key");
        db.flush().expect("flush");
    }

    fn failed_dirs(app_data: &Path) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(app_data) else {
            return Vec::new();
        };
        entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("sled_db.failed-"))
            })
            .collect()
    }

    /// 非空库 + pending（导入途中断电/被杀留下的半成品）：
    /// 原库必须被隔离保留，pending 导入新库后删除。
    #[test]
    fn half_import_is_isolated_and_reimported() {
        let tmp = TempDir::new("isolate");
        let app_data = tmp.path().join("com.my-chat");
        let db_dir = app_data.join("sled_db");
        seed(&db_dir, b"half", b"partial");
        let pending = pending_path(&db_dir);
        std::fs::write(
            &pending,
            serde_json::to_vec(&export_with(&[(b"c:1", b"hello")])).expect("序列化"),
        )
        .expect("写 pending");

        let db = open_db_with_pending_at(&db_dir).expect("隔离后重导应成功");
        let conv = db.open_tree("conversations").expect("建树");
        assert_eq!(
            conv.get(b"c:1").expect("读 key").as_deref(),
            Some(&b"hello"[..]),
            "新库应只含 pending 的数据"
        );
        assert!(
            conv.get(b"half").expect("读 key").is_none(),
            "半成品数据不得混入新库"
        );
        drop(db);

        assert!(!pending.exists(), "导入成功后 pending 必须删除");
        let failed = failed_dirs(&app_data);
        assert_eq!(failed.len(), 1, "必须保留一个隔离目录: {failed:?}");
        let old = sled::open(&failed[0]).expect("隔离库应可打开");
        assert_eq!(
            old.open_tree("conversations")
                .expect("建树")
                .get(b"half")
                .expect("读 key")
                .as_deref(),
            Some(&b"partial"[..]),
            "隔离目录必须原样保留中断时的数据（不得删除）"
        );
    }

    /// 隔离后重导再次失败（模拟磁盘满）：原库换回原位、pending 保留、
    /// 返回可读 Err，并写 `startup_error.log`（含原因与 pending 路径）。
    #[test]
    fn failed_reimport_restores_original_and_keeps_pending() {
        let tmp = TempDir::new("restore");
        let app_data = tmp.path().join("com.my-chat");
        let db_dir = app_data.join("sled_db");
        seed(&db_dir, b"keep", b"original");
        let pending = pending_path(&db_dir);
        std::fs::write(
            &pending,
            serde_json::to_vec(&export_with(&[(b"c:1", b"hello")])).expect("序列化"),
        )
        .expect("写 pending");

        let err = open_db_with_pending_using(&db_dir, |_, _| Err("模拟磁盘满".to_string()))
            .expect_err("再次失败必须返回 Err");
        assert!(err.contains("模拟磁盘满"), "错误应包含真实原因: {err}");
        assert!(
            err.contains(SLED_IMPORT_PENDING),
            "错误应包含待导入文件路径: {err}"
        );
        assert!(pending.exists(), "失败时 pending 必须保留");
        assert!(
            failed_dirs(&app_data).is_empty(),
            "原库应换回原位，不得留下隔离副本"
        );

        let db = sled::open(&db_dir).expect("原库应已恢复");
        assert_eq!(
            db.open_tree("conversations")
                .expect("建树")
                .get(b"keep")
                .expect("读 key")
                .as_deref(),
            Some(&b"original"[..]),
            "原库数据必须完好"
        );
        drop(db);

        let log =
            std::fs::read_to_string(app_data.join(STARTUP_ERROR_LOG)).expect("应写启动错误日志");
        assert!(log.contains("模拟磁盘满"), "日志应含原因: {log}");
        assert!(
            log.contains(SLED_IMPORT_PENDING),
            "日志应含 pending 路径: {log}"
        );
    }
}
