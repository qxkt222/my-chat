// commands/docs.rs — 文档解析 / OCR / 文件选择（知识库导入）

use std::io::Read;
use std::path::Path;

/// 原生文件选择对话框，返回用户选中的文件路径。
/// `filter_name` / `filter_exts` 可选（如 ("PDF", ["pdf"])）。
#[tauri::command]
pub fn pick_file(
    filter_name: Option<String>,
    filter_exts: Option<Vec<String>>,
) -> Result<String, String> {
    let mut dlg = rfd::FileDialog::new();
    if let (Some(name), Some(exts)) = (filter_name, filter_exts) {
        dlg = dlg.add_filter(name, &exts);
    }
    let path = dlg.pick_file().ok_or("已取消选择")?;
    Ok(path.to_string_lossy().to_string())
}

/// 按扩展名提取文档文本：pdf / docx / txt / md / json / csv 直接解析；
/// 图片（png/jpg/jpeg/webp/bmp）走本地 tesseract OCR。
#[tauri::command]
pub fn extract_document_text(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "pdf" => extract_pdf_text(p),
        "docx" => extract_docx_text(p),
        "txt" | "md" | "json" | "csv" | "log" => {
            std::fs::read_to_string(p).map_err(|e| format!("读取文件失败: {e}"))
        }
        "png" | "jpg" | "jpeg" | "webp" | "bmp" => ocr_image(path),
        _ => Err(format!("暂不支持的文件类型: .{ext}")),
    }
}

fn extract_pdf_text(p: &Path) -> Result<String, String> {
    // pdf-extract 0.7: extract_text(path) → Result<String>
    pdf_extract::extract_text(p).map_err(|e| format!("PDF 解析失败: {e}"))
}

/// docx 本质是 zip：读 word/document.xml，抽取 <w:t> 文本，<w:p> 之间换行。
fn extract_docx_text(p: &Path) -> Result<String, String> {
    let file = std::fs::File::open(p).map_err(|e| format!("打开 docx 失败: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("docx 不是有效的 zip: {e}"))?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|e| format!("docx 缺少 word/document.xml: {e}"))?
        .read_to_string(&mut xml)
        .map_err(|e| format!("读取 document.xml 失败: {e}"))?;
    Ok(extract_wt_text(&xml))
}

/// 轻量扫描 XML：<w:t …>text</w:t> 取内容，</w:p> 换行。
/// 不做完整 XML 解析（docx 结构固定，够用）。
fn extract_wt_text(xml: &str) -> String {
    let bytes: Vec<char> = xml.chars().collect();
    let n = bytes.len();
    // bytes[i..] 是否以 ASCII 字符串 s 开头（s 全为 ASCII，逐 char 比较即可）
    let starts_at = |i: usize, s: &str| -> bool {
        let sc: Vec<char> = s.chars().collect();
        i + sc.len() <= n && sc.iter().enumerate().all(|(k, &c)| bytes[i + k] == c)
    };

    let mut out = String::new();
    let mut i = 0usize;
    while i < n {
        // 段落结束 → 换行
        if bytes[i] == '<' && starts_at(i, "</w:p>") {
            out.push('\n');
            i += 6;
            continue;
        }
        // w:t 开始标签（可能是 <w:t> 或 <w:t xml:space="preserve">）
        if bytes[i] == '<' && starts_at(i, "<w:t") {
            // 跳到标签结束的 '>'
            let mut j = i;
            while j < n && bytes[j] != '>' {
                j += 1;
            }
            if j >= n {
                break;
            }
            i = j + 1;
            // 读内容直到 </w:t>
            while i < n && !starts_at(i, "</w:t>") {
                out.push(bytes[i]);
                i += 1;
            }
            if i < n {
                i += 6;
            } // 跳过 </w:t>
            continue;
        }
        i += 1;
    }
    // 压缩多余空行（连续 2+ 换行 → 1）
    out.split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 本地 OCR：spawn `tesseract <img> stdout -l chi_sim --psm 6`。
/// tesseract 未安装时返回带安装指引的错误（仅图片导入受影响）。
#[tauri::command]
pub fn ocr_image(path: String) -> Result<String, String> {
    if std::process::Command::new("tesseract")
        .arg("--version")
        .output()
        .is_err()
    {
        return Err(
            "未检测到 tesseract。请先安装：`winget install UB-Mannheim.TesseractOCR`（勾选 chi_sim 中文语言包）或 `winget install tesseract-ocr.tesseract` 并单独安装 chi_sim 语言包".to_string(),
        );
    }
    let out = std::process::Command::new("tesseract")
        .arg(&path)
        .arg("stdout")
        .arg("-l")
        .arg("chi_sim")
        .arg("--psm")
        .arg("6")
        .output()
        .map_err(|e| format!("运行 tesseract 失败: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("OCR 失败: {}", err.trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Err("OCR 未识别到文字（图片可能是空白或语言包缺失 chi_sim）".to_string());
    }
    Ok(text)
}
