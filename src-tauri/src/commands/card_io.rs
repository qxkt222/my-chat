// commands/card_io.rs — Binary file I/O for character cards (avatars / PNG-embedded JSON)
//
// Character-card import/export needs raw bytes (PNG) in and out of the
// frontend. The existing read_file/write_file are UTF-8 text only, so these
// two commands transfer bytes as base64. Parsing (magic-string extraction,
// avatar slicing) lives in the frontend — no new Rust dependencies.
//
// T-078：50MB 上限下 base64 后约 67MB 字符串仍会走 IPC；彻底解决需要分块/
// 流式传输。本轮先把同步磁盘读 + base64 编解码挪进 `spawn_blocking`，至少
// 不再阻塞 Tauri 异步运行时/主线程；IPC 载荷大小维持现状并在报告中标注。

use base64::Engine as _;
use std::path::Path;

fn encode_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn decode_base64(base64_data: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(base64_data.trim())
        .map_err(|e| format!("Base64 decode error: {e}"))
}

/// Read a file as base64. Used to pull a .png character card (avatar image +
/// trailing JSON) into the frontend for parsing.
#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<String, String> {
    // 读侧准入：应用数据目录内，或经文件对话框登记过的路径（RS-05）。
    let p = crate::resolve_readable_path(&path)?;
    crate::check_read_size(&p, crate::MAX_READ_BYTES)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&p).map_err(|e| format!("Read error: {e}"))?;
        Ok(encode_base64(&bytes))
    })
    .await
    .map_err(|e| format!("读取文件线程错误: {e}"))?
}

/// Write a base64 payload to a file. Used to persist extracted avatar PNGs and
/// to export PNG cards (avatar bytes + magic + JSON) built in the frontend.
#[tauri::command]
pub async fn write_file_bytes(path: String, base64_data: String) -> Result<(), String> {
    // 写侧一律过守卫（头像、导出卡都落在应用数据目录内）；
    // 读侧 read_file_bytes 走 resolve_readable_path（目录内或对话框令牌）。
    let p = crate::guard_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || write_bytes_blocking(&p, &base64_data))
        .await
        .map_err(|e| format!("写入文件线程错误: {e}"))?
}

fn write_bytes_blocking(p: &Path, base64_data: &str) -> Result<(), String> {
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Create dir error: {e}"))?;
    }
    let bytes = decode_base64(base64_data)?;
    std::fs::write(p, &bytes).map_err(|e| format!("Write error: {e}"))?;
    crate::verify_write_inside_app_dir(p)
}

#[cfg(test)]
mod tests {
    use super::{decode_base64, encode_base64};

    #[test]
    fn base64_roundtrip_preserves_binary_bytes() {
        let bytes = b"\x89PNG\r\n\x1a\n\x00\xffhello";
        let encoded = encode_base64(bytes);
        assert_eq!(decode_base64(&encoded).expect("合法 base64 应解码"), bytes);
        assert_eq!(decode_base64(&format!("  {encoded}\n")).unwrap(), bytes);
        assert!(decode_base64("not base64!!").is_err());
    }
}
