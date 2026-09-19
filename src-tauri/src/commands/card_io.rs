// commands/card_io.rs — Binary file I/O for character cards (avatars / PNG-embedded JSON)
//
// Character-card import/export needs raw bytes (PNG) in and out of the
// frontend. The existing read_file/write_file are UTF-8 text only, so these
// two commands transfer bytes as base64. Parsing (magic-string extraction,
// avatar slicing) lives in the frontend — no new Rust dependencies.

use base64::Engine as _;

/// Read a file as base64. Used to pull a .png character card (avatar image +
/// trailing JSON) into the frontend for parsing.
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Read error: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Write a base64 payload to a file. Used to persist extracted avatar PNGs and
/// to export PNG cards (avatar bytes + magic + JSON) built in the frontend.
#[tauri::command]
pub fn write_file_bytes(path: String, base64_data: String) -> Result<(), String> {
    if let Some(parent) = std::path::PathBuf::from(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Create dir error: {e}"))?;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.trim())
        .map_err(|e| format!("Base64 decode error: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("Write error: {e}"))
}
