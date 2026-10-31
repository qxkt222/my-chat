// release 构建不带控制台窗口 —— 必须是 crate 级内部属性（带 !），且必须出现在
// 任何条目之前。原先写成挂在 fn main 上的外部属性，rustc 报 unused_attributes：
// 它作用于函数而非 crate，实际不生效。这条只在 release 构建时出现，
// clippy --all-targets（dev profile）看不到它 —— 所以只有真跑 release 才暴露。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adapters;
mod commands;
mod db;
mod net;
mod rag;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

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
/// 读类命令走 `resolve_readable_path`：应用数据目录内，或用户刚在原生
/// 文件对话框里选过的路径（10 分钟令牌）。导入仍需读桌面/任意盘的文件，
/// 但不再允许前端凭一段字符串读取任意文件。
pub(crate) fn guard_path(raw: &str) -> Result<PathBuf, String> {
    match guard_path_within(&app_data_dir(), raw) {
        Ok(p) => Ok(p),
        Err(msg) => {
            crate::commands::chat::log_chat_error(&msg);
            Err(msg)
        }
    }
}

/// 守卫的纯函数核心：root 可注入，便于用临时目录单测。
///
/// 关键点（RS-13）：目标**不存在**时不能退回纯词法路径 ——
/// `app_data/link-out/new.txt`（`link-out` 是指向外部的目录联接）整串不存在，
/// 词法检查会放行，写入却落到根外。这里改为 canonicalize「最近存在的祖先」
/// 再拼回不存在的尾部，前缀判断始终基于真实路径。
fn guard_path_within(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("应用数据目录不可用: {e}"))?;
    // ⚠️ Windows 的 canonicalize 返回 `\\?\C:\...` 形式的 verbatim 路径，
    //    与普通路径做前缀比较会**假失败**（实测踩过：根内的合法路径被判成越界，
    //    而只测「越界被拒」的话它会假绿通过）。两侧统一剥掉此前缀。
    let root = strip_verbatim(&root);

    // 词法规范化：消掉 "." 与 ".."。不能只靠 `canonicalize` ——
    // `create_dir` 的目标必然不存在，`canonicalize` 会直接失败。
    let norm = lexical_normalize(Path::new(raw));

    let resolved = resolve_via_existing_ancestor(&norm)
        .ok_or_else(|| format!("无法解析路径: {}", norm.display()))?;
    if !resolved.starts_with(&root) {
        return Err(format!(
            "拒绝越界路径（只允许应用数据目录内）: {}",
            norm.display()
        ));
    }
    Ok(norm)
}

/// 词法规范化：消掉 `.` 与 `..`（不访问文件系统）。
fn lexical_normalize(p: &Path) -> PathBuf {
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
    norm
}

/// 把「最近存在的祖先目录」canonicalize（解掉符号链接 / 目录联接），
/// 再把尚不存在的尾部原样拼回去。返回的是**真实**路径。
fn resolve_via_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    loop {
        if let Ok(canonical) = std::fs::canonicalize(&cur) {
            let mut resolved = strip_verbatim(&canonical);
            for seg in tail.iter().rev() {
                resolved.push(seg);
            }
            return Some(resolved);
        }
        let name = cur.file_name()?.to_os_string();
        if !cur.pop() {
            return None;
        }
        tail.push(name);
    }
}

/// 写入后复核：写入目标 canonicalize 后再与根比一次，越界就删掉。
///
/// 守卫 + 写入之间仍有 TOCTOU 窗口（祖先目录被换成联接），这一步兜底。
pub(crate) fn verify_write_inside_app_dir(p: &Path) -> Result<(), String> {
    let root =
        std::fs::canonicalize(app_data_dir()).map_err(|e| format!("应用数据目录不可用: {e}"))?;
    let root = strip_verbatim(&root);
    let actual = std::fs::canonicalize(p).map_err(|e| format!("写入后复核失败: {e}"))?;
    let actual = strip_verbatim(&actual);
    if actual.starts_with(&root) {
        return Ok(());
    }
    // 越界：先删真实目标（万一 p 是链接），再删 p 本身。
    let _ = std::fs::remove_file(&actual);
    let _ = std::fs::remove_file(p);
    let msg = format!("写入目标越界，已删除: {}", p.display());
    crate::commands::chat::log_chat_error(&msg);
    Err(msg)
}

/// 剥掉 Windows `canonicalize` 产生的 `\\?\` verbatim 前缀。
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\")
        .map_or_else(|| p.to_path_buf(), PathBuf::from)
}

// ── 读令牌（RS-05）───────────────────────────────────────
//
// 读类命令不再接受任意路径：只认「应用数据目录内」或「用户刚在原生文件
// 对话框里选过、10 分钟内有效」的路径。令牌放在进程内，重启即失效。

/// 对话框选中后的可读窗口。
const READ_TOKEN_TTL: Duration = Duration::from_mins(10);
/// 单文件读取上限。
pub(crate) const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;

static READ_TOKENS: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();

fn read_tokens() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    READ_TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 令牌键：能 canonicalize 就用真实路径（同一文件的不同写法归一）。
fn token_key(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).map_or_else(|_| p.to_path_buf(), |c| strip_verbatim(&c))
}

/// 登记一个用户通过文件对话框选中的路径。
pub(crate) fn register_read_token(path: &Path) {
    let key = token_key(path);
    let mut map = read_tokens()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let now = Instant::now();
    map.retain(|_, at| now.saturating_duration_since(*at) < READ_TOKEN_TTL);
    map.insert(key, now);
}

fn read_token_valid_at(path: &Path, now: Instant) -> bool {
    let key = token_key(path);
    // ⚠️ 只读不清理：清理动作放进 `register_read_token`。这里若按传入的
    //    `now` 做 retain，单测用「未来时刻」验证过期时会顺手删掉并发的有效令牌
    //    （实测过：并行跑测试时互相踩）。
    let map = read_tokens()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    map.get(&key)
        .is_some_and(|at| now.saturating_duration_since(*at) < READ_TOKEN_TTL)
}

/// 读侧准入：应用数据目录内，或持有未过期的对话框令牌。
pub(crate) fn resolve_readable_path(raw: &str) -> Result<PathBuf, String> {
    if guard_path_within(&app_data_dir(), raw).is_ok() {
        return Ok(lexical_normalize(Path::new(raw)));
    }
    let p = PathBuf::from(raw);
    if read_token_valid_at(&p, Instant::now()) {
        return Ok(p);
    }
    Err(format!(
        "拒绝读取未授权路径（需经文件对话框选择，或在应用数据目录内）: {}",
        p.display()
    ))
}

/// 读前体积检查（防止一次 IPC 读进超大文件把内存打满）。
pub(crate) fn check_read_size(path: &Path, limit: u64) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Read error: {e}"))?;
    if !meta.is_file() {
        return Err(format!("不是普通文件: {}", path.display()));
    }
    if meta.len() > limit {
        return Err(format!(
            "文件过大: {} 字节（上限 {} MB）",
            meta.len(),
            limit / (1024 * 1024)
        ));
    }
    Ok(())
}

// ── File system commands ──────────────────────────────────
#[tauri::command]
fn get_app_dir() -> String {
    app_data_dir().to_string_lossy().to_string()
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let p = resolve_readable_path(&path)?;
    check_read_size(&p, MAX_READ_BYTES)?;
    std::fs::read_to_string(&p).map_err(|e| format!("Read error: {e}"))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let p = guard_path(&path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Create dir error: {e}"))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("Write error: {e}"))?;
    verify_write_inside_app_dir(&p)
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

// ── Single instance (T-061) ─────────────────────────────
//
// 未注册单实例时，第二次启动会因 sled 独占锁失败 → `init_db` Err →
// setup Err → Tauri 内部 panic；release 带 `windows_subsystem = "windows"`，
// 用户只看到双击无反应。这里用命名 mutex 判重（不新增依赖），第二个实例
// 通过命名事件请第一个实例把主窗口前置，然后弹提示退出。
#[cfg(windows)]
mod single_instance {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateMutexW, OpenEventW, SetEvent, WaitForSingleObject, EVENT_MODIFY_STATE,
        INFINITE,
    };

    /// 命名对象都在当前登录会话内（无 `Global\` 前缀），多用户互不干扰。
    const MUTEX_NAME: &str = "Local\\com.my-chat.single-instance";
    const FOCUS_EVENT_NAME: &str = "Local\\com.my-chat.focus-event";
    /// 第二个实例等第一个实例建好事件的最长时间（冷启动竞态）。
    const NOTIFY_RETRY_TIMES: usize = 40;
    const NOTIFY_RETRY_INTERVAL: Duration = Duration::from_millis(50);

    fn wide(name: &str) -> Vec<u16> {
        OsStr::new(name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// 首个实例持有的内核对象句柄；进程存活期间必须一直持有。
    pub struct InstanceGuard {
        mutex: HANDLE,
        event: HANDLE,
    }

    impl InstanceGuard {
        pub fn event(&self) -> HANDLE {
            self.event
        }
    }

    impl Drop for InstanceGuard {
        fn drop(&mut self) {
            // SAFETY: 句柄由本进程创建，且只在 Drop 里关闭一次。
            unsafe {
                if self.mutex != 0 {
                    CloseHandle(self.mutex);
                }
                if self.event != 0 {
                    CloseHandle(self.event);
                }
            }
        }
    }

    pub enum Instance {
        First(InstanceGuard),
        Second,
    }

    /// 判定本次启动是不是第一个实例。
    ///
    /// mutex 创建失败（极罕见）时降级为放行启动：宁可重复启动，也不要因为
    /// 判重机制本身把用户挡在门外。
    pub fn acquire() -> Instance {
        acquire_named(MUTEX_NAME, FOCUS_EVENT_NAME)
    }

    pub(super) fn acquire_named(mutex_name: &str, event_name: &str) -> Instance {
        let mutex_name = wide(mutex_name);
        let event_name = wide(event_name);
        // SAFETY: 传入合法的以 NUL 结尾的 UTF-16 字符串；句柄由 InstanceGuard 关闭。
        unsafe {
            // ⚠️ 必须先清零 last-error：CreateMutexW **新建**对象时不会设置
            // last-error，上一次调用残留的 ERROR_ALREADY_EXISTS 会造成假阳性。
            SetLastError(0);
            let mutex = CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr());
            if mutex == 0 {
                return Instance::First(InstanceGuard { mutex: 0, event: 0 });
            }
            if GetLastError() == ERROR_ALREADY_EXISTS {
                let _ = CloseHandle(mutex);
                return Instance::Second;
            }
            let event = CreateEventW(std::ptr::null(), 0, 0, event_name.as_ptr());
            Instance::First(InstanceGuard { mutex, event })
        }
    }

    /// 第二个实例：通知第一个实例聚焦主窗口。
    ///
    /// 第一个实例可能还在初始化、尚未创建事件，因此短暂重试。
    pub fn notify_existing() -> bool {
        let name = wide(FOCUS_EVENT_NAME);
        for _ in 0..NOTIFY_RETRY_TIMES {
            // SAFETY: 合法名字指针；OpenEventW 返回的句柄在本函数内关闭。
            unsafe {
                let event = OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr());
                if event != 0 {
                    let ok = SetEvent(event) != 0;
                    let _ = CloseHandle(event);
                    return ok;
                }
            }
            std::thread::sleep(NOTIFY_RETRY_INTERVAL);
        }
        false
    }

    /// 第一个实例：后台等待聚焦事件。
    ///
    /// `event == 0` 说明事件创建失败，静默跳过 —— 单实例判重本身仍然有效。
    pub fn spawn_focus_listener(event: HANDLE, app: tauri::AppHandle) {
        if event == 0 {
            return;
        }
        std::thread::spawn(move || loop {
            // SAFETY: event 句柄由 InstanceGuard 持有，进程退出前一直有效。
            let rc = unsafe { WaitForSingleObject(event, INFINITE) };
            if rc != WAIT_OBJECT_0 {
                return;
            }
            focus_main_window(&app);
        });
    }

    /// 把已有主窗口置前。窗口尚未创建完时短暂重试（第二个实例可能在
    /// 第一个实例初始化期间启动）。
    fn focus_main_window(app: &tauri::AppHandle) {
        use tauri::Manager;
        for _ in 0..100 {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                // Windows 前台锁：置顶再取消是常见的强制前置手段。
                let _ = window.set_always_on_top(true);
                let _ = window.set_always_on_top(false);
                let _ = window.set_focus();
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

#[cfg(windows)]
static SINGLE_INSTANCE_GUARD: OnceLock<single_instance::InstanceGuard> = OnceLock::new();

/// 第二个实例的提示框：说清楚「已在运行」以及窗口已被切到前台。
fn show_already_running_dialog() {
    let _ = rfd::MessageDialog::new()
        .set_title("my-chat 已在运行")
        .set_description("my-chat 已在运行，已为你切换到已打开的窗口。")
        .set_level(rfd::MessageLevel::Info)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

/// 启动失败的最终提示文案：原因 + 日志路径 + 可恢复说明（T-062）。
fn startup_failure_text(detail: &str, log_path: &Path) -> String {
    format!(
        "my-chat 启动失败，应用无法进入主界面。\n\n{detail}\n\n详细信息已写入：\n{}\n\n本次启动未对数据做破坏性修改；修复数据或升级程序后可重新启动。",
        log_path.display()
    )
}

/// 统一的启动失败出口（T-062）：结构化日志 + 失败 marker + 原生对话框。
///
/// release 构建没有控制台，`expect`/panic 只会让进程静默闪退；这里保证
/// 用户能看到可读原因与日志位置，排障也有文件可查。
fn report_startup_failure(detail: &str) {
    let dir = app_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let log_path = dir.join(db::STARTUP_ERROR_LOG);
    db::append_startup_error(&dir, detail);
    // 保留 marker：成功时是 `started=`，失败时是 `failed=`，一眼可辨。
    let one_line = detail.replace(['\r', '\n'], " ");
    let _ = std::fs::write(
        dir.join("startup.marker"),
        format!("failed={} error={one_line}\n", chrono_now_secs()),
    );
    let _ = rfd::MessageDialog::new()
        .set_title("my-chat 启动失败")
        .set_description(startup_failure_text(detail, &log_path))
        .set_level(rfd::MessageLevel::Error)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

// ── Entry point ──────────────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // T-061：第二次启动直接激活已有窗口并退出，避免 sled 独占锁失败
    // → setup Err → Tauri 内部 panic（release 下表现为双击无反应）。
    #[cfg(windows)]
    let focus_event = match single_instance::acquire() {
        single_instance::Instance::Second => {
            single_instance::notify_existing();
            show_already_running_dialog();
            return;
        }
        single_instance::Instance::First(guard) => {
            let event = guard.event();
            // 守卫必须活到进程结束，否则命名对象会随句柄关闭而销毁。
            let _ = SINGLE_INSTANCE_GUARD.set(guard);
            event
        }
    };

    let app = tauri::Builder::default()
        // 内置 llama.cpp 运行时：用户自备 llama-server.exe + GGUF，应用只管生命周期。
        .manage(commands::llama::LlamaState::default())
        // opener：markdown 里的外链改由**系统浏览器**打开。
        // 此前注册的是 shell 插件——前端零引用、capabilities 也没授权，
        // 等于白背一个「能起子进程」的插件，已随本次一并移除。
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            // T-061：第一个实例在后台等「聚焦」事件；第二个实例启动时会发。
            #[cfg(windows)]
            single_instance::spawn_focus_listener(focus_event, app.handle().clone());
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
            // Open the sled database (embedded KV store); runs schema migrations.
            //
            // release 构建带 `windows_subsystem = "windows"`，没有控制台。T-062：
            // setup 返回 Err 会被 Tauri 内部 `panic!("Failed to setup app")`，
            // 用户只看到静默闪退。因此这里**不返回 Err**：写结构化日志 + 失败
            // marker + 原生对话框，然后以非零码正常退出（数据不会被改动）。
            // 覆盖「库版本高于程序」等迁移拒绝场景。
            if let Err(e) = db::init_db() {
                report_startup_failure(&format!("数据库初始化失败: {e}"));
                std::process::exit(1);
            }
            // Startup self-heal: repair/keep model records (never silently delete
            // them), remap active_model. Failures must leave a readable trace.
            if let Err(e) = db::settings::sanitize_models() {
                db::append_startup_error(&dir, &format!("模型配置自愈失败（记录未改动）: {e}"));
            }
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
            commands::rag::rag_delete_document,
            commands::rag::delete_kb,
            import_json_data,
            get_db_status,
            commands::backup::create_backup,
            commands::backup::list_backups,
            commands::backup::restore_backup,
            commands::backup::delete_backup,
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
            commands::mcp::mcp_resolve_permission,
            commands::mcp::mcp_set_lite_tool,
            commands::mcp::mcp_list_lite_tools,
            commands::docs::pick_file,
            commands::docs::extract_document_text,
            commands::docs::ocr_image,
            commands::memory::mem_list,
            commands::memory::mem_save,
            commands::memory::mem_delete,
            commands::memory::mem_search,
            commands::draw::generate_image,
            commands::draw::probe_draw_service,
            commands::card_io::read_file_bytes,
            commands::card_io::write_file_bytes,
            commands::translate::translate_text,
            commands::translate::probe_local_llm,
            commands::llama::llama_start,
            commands::llama::llama_stop,
            commands::llama::llama_status,
        ])
        .build(tauri::generate_context!());
    // T-062：去掉 `expect` —— 构建/插件初始化失败同样要留下可读现场，
    // 而不是 panic 出一条 release 下看不见的 stderr。
    let app = match app {
        Ok(app) => app,
        Err(e) => {
            report_startup_failure(&format!("应用初始化失败: {e}"));
            return;
        }
    };

    // RS-19: 退出时显式把 sled 内存表刷到磁盘。失败只记日志、不 panic ——
    // 退出路径上的 panic 会给用户弹崩溃窗,而这里最坏只是丢掉最后几秒写入。
    // setup 里 `db::init_db()?` 成功才会走到 `run()`,因此 DB 必已初始化;
    // `db::db()` 不会在这里触发一次新的打开。
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // 内置 llama.cpp：退出时确保用户自备的 llama-server 进程树不残留。
            // 退出回调是同步的，这里走同步 taskkill + 轮询回收。
            let llama_state = app_handle.state::<commands::llama::LlamaState>();
            commands::llama::shutdown_blocking(&llama_state);
            match db::db() {
                Ok(db) => {
                    if let Err(e) = db.flush() {
                        crate::commands::chat::log_chat_error(&format!("EXIT_FLUSH: {e}"));
                    }
                }
                Err(e) => {
                    crate::commands::chat::log_chat_error(&format!(
                        "EXIT_FLUSH: 数据库不可用: {e}"
                    ));
                }
            }
        }
    });
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

        let outside = if cfg!(windows) {
            "C:/Windows/System32"
        } else {
            "/etc"
        };
        assert!(
            guard_path(outside).is_err(),
            "应用数据目录之外的绝对路径应被拒绝"
        );

        // 用 .. 从根目录爬出去（app_data_dir/../../.. 落到用户目录）
        let climb = format!("{}/../../..", app_data_dir().to_string_lossy());
        assert!(
            guard_path(&climb).is_err(),
            "含 .. 爬出根目录的路径应被拒绝"
        );
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

    // ── 以下用例一律用临时目录，不碰用户数据 ──────────────

    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let p =
            std::env::temp_dir().join(format!("my-chat-test-{tag}-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&p).expect("创建临时目录");
        p
    }

    /// 目标不存在时，越界仍必须被拒（不能退回纯词法路径）。
    #[test]
    fn guard_rejects_nonexistent_target_outside_root() {
        let root = temp_dir("root-a");
        let outside = temp_dir("outside-a");
        let target = outside.join("nope.txt");
        let result = guard_path_within(&root, target.to_string_lossy().as_ref());
        assert!(result.is_err(), "根外不存在的目标应被拒绝");

        // 根内不存在的目标应放行
        let inside = root.join("sub").join("nope.txt");
        assert!(
            guard_path_within(&root, inside.to_string_lossy().as_ref()).is_ok(),
            "根内不存在的目标应放行"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// 目录联接（junction）指向根外时，即使叶子不存在也必须拒绝（RS-13）。
    #[cfg(windows)]
    #[test]
    fn guard_rejects_junction_escape() {
        let root = temp_dir("root-j");
        let outside = temp_dir("outside-j");
        let link = root.join("link-out");

        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .status();
        let created = matches!(&status, Ok(s) if s.success()) && link.exists();
        if !created {
            // 某些环境禁用了 junction：跳过而不是假绿/假红
            eprintln!("跳过：无法创建目录联接");
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }

        let target = link.join("sub").join("new.txt");
        let result = guard_path_within(&root, target.to_string_lossy().as_ref());
        assert!(result.is_err(), "经目录联接逃出根外的路径必须被拒绝");

        // 先删联接本身（remove_dir 只删 reparse point，不递归目标），再清临时目录
        let _ = std::fs::remove_dir(&link);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// 对话框令牌：登记后可用，过期后失效。只碰临时文件。
    #[test]
    fn read_token_expires() {
        let dir = temp_dir("token");
        let file = dir.join("picked.txt");
        std::fs::write(&file, b"x").expect("写临时文件");

        register_read_token(&file);
        let now = Instant::now();
        assert!(read_token_valid_at(&file, now), "刚登记应有效");

        let later = now
            .checked_add(READ_TOKEN_TTL + Duration::from_secs(1))
            .expect("时间加法");
        assert!(!read_token_valid_at(&file, later), "过期后应失效");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 未登记的根外路径读不到；登记后可读。
    #[test]
    fn resolve_readable_path_requires_token_or_app_dir() {
        let dir = temp_dir("read-gate");
        let file = dir.join("secret.txt");
        std::fs::write(&file, b"secret").expect("写临时文件");

        assert!(
            resolve_readable_path(file.to_string_lossy().as_ref()).is_err(),
            "未登记的根外路径应拒绝"
        );

        register_read_token(&file);
        assert!(
            resolve_readable_path(file.to_string_lossy().as_ref()).is_ok(),
            "登记后应放行"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 50 MB 上限的判定逻辑（用极小阈值测，不生成大文件）。
    #[test]
    fn read_size_limit_is_enforced() {
        let dir = temp_dir("size");
        let file = dir.join("small.txt");
        std::fs::write(&file, b"0123456789").expect("写临时文件");

        assert!(check_read_size(&file, 5).is_err(), "超过上限应拒绝");
        assert!(check_read_size(&file, 100).is_ok(), "未超上限应放行");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// T-062：启动失败提示必须给出原因、日志路径与可重试说明。
#[cfg(test)]
mod startup_failure_tests {
    use super::startup_failure_text;
    use std::path::Path;

    #[test]
    fn failure_text_contains_reason_and_log_path() {
        let text = startup_failure_text(
            "数据库 schema 版本为 9,高于本程序支持的最新版本 8",
            Path::new("C:/data/com.my-chat/startup_error.log"),
        );
        assert!(text.contains("启动失败"), "要明确告知应用没起来: {text}");
        assert!(text.contains("schema 版本"), "要保留具体原因: {text}");
        assert!(
            text.contains("startup_error.log"),
            "必须告诉用户日志落在哪里: {text}"
        );
        assert!(text.contains("可重新启动"), "要说明数据未被破坏、可以重试");
    }
}

/// T-061：命名 mutex 判重（同一进程内第二次获取即视为第二实例）。
#[cfg(all(test, windows))]
mod single_instance_tests {
    use super::single_instance::{acquire_named, Instance};

    fn unique_names(tag: &str) -> (String, String) {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        (
            format!(
                "Local\\my-chat-test-mutex-{tag}-{}-{stamp}",
                std::process::id()
            ),
            format!(
                "Local\\my-chat-test-event-{tag}-{}-{stamp}",
                std::process::id()
            ),
        )
    }

    #[test]
    fn second_acquire_detects_running_instance() {
        let (mutex, event) = unique_names("dup");

        let first = acquire_named(&mutex, &event);
        assert!(
            matches!(&first, Instance::First(_)),
            "第一个实例必须拿到 First"
        );

        let second = acquire_named(&mutex, &event);
        assert!(
            matches!(&second, Instance::Second),
            "命名 mutex 已存在时第二次获取必须识别为 Second"
        );

        drop(first);
        // 所有句柄关闭后命名对象销毁：下次启动应能重新成为第一个实例。
        let third = acquire_named(&mutex, &event);
        assert!(
            matches!(&third, Instance::First(_)),
            "第一个实例退出后应能重新启动"
        );
    }
}
