// commands/docs.rs — 文档解析 / OCR / 文件选择（知识库导入）

use std::io::{Read, Seek};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// document.xml 解压后的上限（T-071）：50MB 的 docx 压缩包可以解出数 GB，
/// 必须在上限处截断并报错，不能让 zip bomb 把内存吃满。
const MAX_DOCX_XML_BYTES: u64 = 100 * 1024 * 1024;
/// docx 条目数上限（T-071）：正常文档几十个条目，上万即可疑。
const MAX_DOCX_ENTRIES: usize = 10_000;
/// OCR 子进程总时限（T-073）；超时即 kill，避免后台永久占住一个阻塞线程。
const OCR_TIMEOUT: Duration = Duration::from_mins(2);
const OCR_POLL_INTERVAL: Duration = Duration::from_millis(100);

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
    // 登记读令牌：后续 read_file / read_file_bytes / extract_document_text
    // 只认这里返回过的路径（10 分钟有效）。
    crate::register_read_token(&path);
    Ok(path.to_string_lossy().to_string())
}

/// 按扩展名提取文档文本：pdf / docx / txt / md / json / csv 直接解析；
/// 图片（png/jpg/jpeg/webp/bmp）走本地 tesseract OCR。
///
/// T-073：PDF 解析 / docx 解包 / OCR 都是同步阻塞重活，必须丢进
/// `spawn_blocking`，否则会占住 Tauri 异步运行时线程，大文件时 UI 卡死。
#[tauri::command]
pub async fn extract_document_text(path: String) -> Result<String, String> {
    // 读侧准入（RS-05）：对话框令牌或应用数据目录内，且 ≤ 50 MB。
    let resolved = crate::resolve_readable_path(&path)?;
    crate::check_read_size(&resolved, crate::MAX_READ_BYTES)?;
    tauri::async_runtime::spawn_blocking(move || extract_document_text_blocking(&resolved))
        .await
        .map_err(|e| format!("文档解析线程错误: {e}"))?
}

fn extract_document_text_blocking(p: &Path) -> Result<String, String> {
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "pdf" => extract_pdf_text(p),
        "docx" => extract_docx_text(p),
        "txt" | "md" | "json" | "csv" | "log" => read_text_file(p),
        // 复用已解析的路径，避免再走一次 token 查询
        "png" | "jpg" | "jpeg" | "webp" | "bmp" => run_ocr(p),
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
    extract_docx_from(file, MAX_DOCX_XML_BYTES, MAX_DOCX_ENTRIES)
}

/// T-071 的可测核心：条目数与解压上限都有界。
fn extract_docx_from<R: Read + Seek>(
    reader: R,
    max_xml: u64,
    max_entries: usize,
) -> Result<String, String> {
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("docx 不是有效的 zip: {e}"))?;
    if archive.len() > max_entries {
        return Err(format!(
            "docx 条目过多（{}，上限 {max_entries}），疑似压缩炸弹，已拒绝",
            archive.len()
        ));
    }
    let entry = archive
        .by_name("word/document.xml")
        .map_err(|e| format!("docx 缺少 word/document.xml: {e}"))?;
    if entry.size() > max_xml {
        return Err(docx_too_large(entry.size(), max_xml));
    }
    let mut xml_bytes = Vec::new();
    // 多读 1 字节即可判断是否超限，避免信任 entry.size()（zip 头可伪造）。
    entry
        .take(max_xml + 1)
        .read_to_end(&mut xml_bytes)
        .map_err(|e| format!("读取 document.xml 失败: {e}"))?;
    if xml_bytes.len() as u64 > max_xml {
        return Err(docx_too_large(xml_bytes.len() as u64, max_xml));
    }
    let xml = String::from_utf8(xml_bytes)
        .map_err(|e| format!("word/document.xml 不是有效 UTF-8: {e}"))?;
    Ok(extract_wt_text(&xml))
}

fn docx_too_large(actual: u64, limit: u64) -> String {
    format!("document.xml 解压后过大（{actual} 字节，上限 {limit} 字节），已拒绝")
}

/// 轻量扫描 XML：<w:t …>text</w:t> 取内容，</w:p> 换行。
/// 不做完整 XML 解析（docx 结构固定，够用）。
///
/// 按字节扫描而不是先转 `Vec<char>`：100MB 的 XML 转成 char 会膨胀到
/// 400MB，失去「内存有界」的意义；这里只额外分配输出文本。
fn extract_wt_text(xml: &str) -> String {
    let bytes = xml.as_bytes();
    let n = bytes.len();
    let mut out: Vec<u8> = Vec::new();
    let mut i = 0usize;
    while i < n {
        // 段落结束 → 换行
        if bytes[i] == b'<' && bytes[i..].starts_with(b"</w:p>") {
            out.push(b'\n');
            i += 6;
            continue;
        }
        // w:t 开始标签（可能是 <w:t> 或 <w:t xml:space="preserve">）
        if bytes[i] == b'<' && bytes[i..].starts_with(b"<w:t") {
            // 跳到标签结束的 '>'
            let mut j = i;
            while j < n && bytes[j] != b'>' {
                j += 1;
            }
            if j >= n {
                break;
            }
            i = j + 1;
            // 读内容直到 </w:t>
            while i < n && !bytes[i..].starts_with(b"</w:t>") {
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
    // 源文本是合法 UTF-8，且切片只落在 ASCII 标记边界，输出必定仍是 UTF-8。
    let text = String::from_utf8_lossy(&out);
    // 压缩多余空行（连续 2+ 换行 → 1）
    text.split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// T-072：UTF-8 优先；失败时按 GB18030（GBK 的超集）解码。
/// Windows 记事本另存为「ANSI」的中文 txt 就是 GBK。
fn read_text_file(p: &Path) -> Result<String, String> {
    let bytes = std::fs::read(p).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(decode_text_bytes(&bytes))
}

fn decode_text_bytes(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.trim_start_matches('\u{feff}').to_string();
    }
    let (decoded, _, _) = encoding_rs::GB18030.decode(bytes);
    decoded.trim_start_matches('\u{feff}').to_string()
}

/// 本地 OCR：spawn `tesseract <img> stdout -l chi_sim --psm 6`。
/// tesseract 未安装时返回带安装指引的错误（仅图片导入受影响）。
///
/// T-073：命令层已放进 `spawn_blocking`；这里再加**超时 + kill**，
/// 防止 tesseract 卡死时永久占住阻塞线程。
#[tauri::command]
pub async fn ocr_image(path: String) -> Result<String, String> {
    // 与 extract_document_text 同一准入口径：tesseract 读的也是这个文件。
    let resolved = crate::resolve_readable_path(&path)?;
    crate::check_read_size(&resolved, crate::MAX_READ_BYTES)?;
    tauri::async_runtime::spawn_blocking(move || run_ocr(&resolved))
        .await
        .map_err(|e| format!("OCR 线程错误: {e}"))?
}

fn run_ocr(path: &Path) -> Result<String, String> {
    run_ocr_with("tesseract", path)
}

/// 可注入程序名的 OCR 实现（测试用不存在的程序验证安装指引）。
fn run_ocr_with(program: &str, path: &Path) -> Result<String, String> {
    if Command::new(program).arg("--version").output().is_err() {
        return Err(format!(
            "未检测到 {program}。请先安装：`winget install UB-Mannheim.TesseractOCR`（勾选 chi_sim 中文语言包）或 `winget install tesseract-ocr.tesseract` 并单独安装 chi_sim 语言包"
        ));
    }
    let mut child = Command::new(program)
        .arg(path)
        .arg("stdout")
        .arg("-l")
        .arg("chi_sim")
        .arg("--psm")
        .arg("6")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("运行 tesseract 失败: {e}"))?;

    // 先常驻读取管道，避免大图输出填满管道缓冲导致子进程阻塞、双方互等。
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_reader = std::thread::spawn(move || read_all(stdout));
    let err_reader = std::thread::spawn(move || read_all(stderr));

    let deadline = Instant::now() + OCR_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待 OCR 进程失败: {e}"));
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("OCR 超时（{} 秒），已取消", OCR_TIMEOUT.as_secs()));
        }
        std::thread::sleep(OCR_POLL_INTERVAL);
    };

    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    if !status.success() {
        let err = String::from_utf8_lossy(&stderr);
        return Err(format!("OCR 失败: {}", err.trim()));
    }
    let text = String::from_utf8_lossy(&stdout).trim().to_string();
    if text.is_empty() {
        return Err("OCR 未识别到文字（图片可能是空白或语言包缺失 chi_sim）".to_string());
    }
    Ok(text)
}

fn read_all<R: Read>(reader: Option<R>) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Some(mut reader) = reader {
        let _ = reader.read_to_end(&mut buf);
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::{decode_text_bytes, extract_docx_from, extract_wt_text, run_ocr_with};
    use std::io::{Cursor, Write};
    use std::path::Path;

    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            for (name, data) in entries {
                writer
                    .start_file(*name, zip::write::SimpleFileOptions::default())
                    .expect("start_file");
                writer.write_all(data).expect("write entry");
            }
            writer.finish().expect("finish zip");
        }
        buffer.into_inner()
    }

    /// T-072 验收：Windows 记事本 GBK txt 可导入；UTF-8 与 BOM 不受影响。
    #[test]
    fn decode_text_bytes_falls_back_to_gb18030() {
        assert_eq!(decode_text_bytes("你好".as_bytes()), "你好");
        // GBK 编码的「你好」
        let gbk = [0xC4u8, 0xE3, 0xBA, 0xC3];
        assert_eq!(decode_text_bytes(&gbk), "你好");
        // UTF-8 BOM 去掉
        assert_eq!(decode_text_bytes(&[0xEF, 0xBB, 0xBF, b'h', b'i']), "hi");
    }

    #[test]
    fn extract_wt_text_keeps_utf8_and_paragraph_breaks() {
        let xml = "<w:p><w:t>你好</w:t></w:p><w:p><w:t xml:space=\"preserve\">world</w:t></w:p>";
        assert_eq!(extract_wt_text(xml), "你好\nworld");
    }

    /// T-071 验收：正常 docx 仍可导入。
    #[test]
    fn docx_extraction_reads_normal_document() {
        let archive = make_zip(&[(
            "word/document.xml",
            b"<w:p><w:t>hello</w:t></w:p>".as_slice(),
        )]);
        let text = extract_docx_from(Cursor::new(archive), 1024, 100).expect("正常 docx 应解析");
        assert_eq!(text, "hello");
    }

    /// T-071 验收：解压后超限的 document.xml 被拒，而不是全量读进内存。
    #[test]
    fn docx_extraction_rejects_zip_bomb() {
        let big_xml = vec![b'a'; 4096];
        let archive = make_zip(&[("word/document.xml", big_xml.as_slice())]);
        let err = extract_docx_from(Cursor::new(archive), 256, 100).expect_err("解压超限必须报错");
        assert!(err.contains("上限"), "{err}");
    }

    /// T-071：条目数上限同样生效。
    #[test]
    fn docx_extraction_limits_entry_count() {
        let archive = make_zip(&[
            ("word/document.xml", b"<w:p/>".as_slice()),
            ("a.txt", b"x".as_slice()),
            ("b.txt", b"y".as_slice()),
        ]);
        let err = extract_docx_from(Cursor::new(archive), 1024, 2).expect_err("条目过多必须报错");
        assert!(err.contains("条目"), "{err}");
    }

    /// T-073：tesseract 缺席时给出可读安装指引（OCR 错误路径可测）。
    #[test]
    fn missing_tesseract_reports_install_hint() {
        let err = run_ocr_with("my-chat-no-such-tesseract", Path::new("x.png"))
            .expect_err("不存在的程序必须报错");
        assert!(err.contains("tesseract"), "{err}");
        assert!(err.contains("winget"), "{err}");
    }
}
