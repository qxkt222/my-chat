// net.rs — 全局 HTTP 客户端与 SSE 增量行解码（RS-07 / RS-10）
//
// RS-07：此前全仓 9 个 reqwest 客户端都是 `Client::new()`，既没有超时也没有
// 重定向策略。端点挂起时请求永不返回；SSE 流同样卡死，"停止"按钮也中断不了
// （取消只在收到 chunk 时检查）。这里集中构造两类客户端，全进程复用：
//
//   client()           非流式请求：连接 10s、总超时 120s、不跟随重定向
//   streaming_client() 流式请求：连接 10s、无总超时、不跟随重定向
//                      首字节 180s、后续空闲 60s，由调用方逐片用
//                      `tokio::time::timeout` 控制
//   image_client()     图片生成/下载：连接 10s、总超时 300s、不跟随重定向
//   upload_client()    WebDAV 上传：连接 10s、无总超时、不跟随重定向
//   long_client()      长任务/轮询（本地 LLM、ComfyUI）：连接 10s、无总超时、
//                      不跟随重定向；单请求超时由调用方用 `.timeout()` 覆盖
//
// TLS 校验保持 reqwest 默认（系统根证书），**不**调用
// `danger_accept_invalid_certs` —— 那等于关掉 HTTPS 的全部意义。

use std::sync::LazyLock;
use std::time::Duration;

/// 建连上限：DNS + TCP + TLS 握手。本地模型端点正常 <1s，公网 <3s；
/// 取 10s 是为了容忍慢速代理，同时不让"端点根本没起来"的请求无限等待。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 非流式请求的总超时（含响应体读取）。
pub const REQUEST_TIMEOUT: Duration = Duration::from_mins(2);

/// SSE **首字节**（TTFT）上限：模型冷启动、排队、长 prompt 预填充时，
/// 第一个 token 可能远超普通空闲间隔，因此单独给到 180s。
pub const FIRST_BYTE_TIMEOUT: Duration = Duration::from_mins(3);

/// SSE 首字节之后，相邻两片数据之间的最长等待。
pub const STREAM_IDLE_TIMEOUT: Duration = Duration::from_mins(1);

/// 图片生成 / 图片下载的总超时：出图 + 拉取大图经常超过 2 分钟。
pub const IMAGE_TIMEOUT: Duration = Duration::from_mins(5);

/// 首字节阶段超时给用户看的错误文案。
pub const FIRST_BYTE_TIMEOUT_MESSAGE: &str = "首字节超时（180 秒无响应）";

/// 首字节之后流式读取超时给用户看的错误文案。
pub const STREAM_TIMEOUT_MESSAGE: &str = "响应超时（60 秒无数据）";

/// 公共基础配置：建连超时 + 不跟随重定向。
///
/// 不跟随重定向的原因：请求里带 `Authorization: Bearer <key>`，自动跳转会把
/// 后端配置错误（`http://` → `https://`、路径少斜杠）放大成"悄悄把 key 交给
/// 另一个主机"。禁用后服务端 3xx 直接当错误返回，问题可见可控。
fn base_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
}

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    base_builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .expect("HTTP 客户端初始化失败：TLS 后端不可用")
});

static STREAMING_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    base_builder()
        .build()
        .expect("流式 HTTP 客户端初始化失败：TLS 后端不可用")
});

static IMAGE_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    base_builder()
        .timeout(IMAGE_TIMEOUT)
        .build()
        .expect("图片 HTTP 客户端初始化失败：TLS 后端不可用")
});

static UPLOAD_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    base_builder()
        .build()
        .expect("上传 HTTP 客户端初始化失败：TLS 后端不可用")
});

/// 长任务客户端：本地 LLM 翻译与 `ComfyUI` 轮询可能长时间无响应，
/// 不能套用 `client()` 的 120s 总超时；调用方按请求设置 `.timeout()`。
static LONG_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    base_builder()
        .build()
        .expect("长任务 HTTP 客户端初始化失败：TLS 后端不可用")
});

/// 非流式请求用的共享客户端（连接池复用，克隆是 `Arc` 级开销）。
#[must_use]
pub fn client() -> reqwest::Client {
    CLIENT.clone()
}

/// 流式（SSE）请求用的共享客户端：无总超时，避免长回答被一刀切断。
#[must_use]
pub fn streaming_client() -> reqwest::Client {
    STREAMING_CLIENT.clone()
}

/// 图片生成 / 图片下载用的共享客户端：连接 10s、总超时 300s、不跟随重定向。
///
/// 图片接口的响应体是整张图（可能数 MB），`client()` 的 120s 总超时对慢速
/// 出图模型偏紧；同时仍保留禁用重定向，防止 3xx 跳转页被当成图片落盘。
#[must_use]
pub fn image_client() -> reqwest::Client {
    IMAGE_CLIENT.clone()
}

/// `WebDAV` 上传用的共享客户端：连接 10s、**无总超时**、不跟随重定向。
///
/// 2 GiB 的单文件 PUT 在慢速上行链路上可能远超 `client()` 的 120s 总超时；
/// 上传不应被总时长一刀切断，中断保护交给上层取消与 TCP 自身错误。
#[must_use]
pub fn upload_client() -> reqwest::Client {
    UPLOAD_CLIENT.clone()
}

/// 本地 LLM / 出图服务轮询用的共享客户端：连接 10s、**无总超时**、不跟随重定向。
///
/// 本地模型冷启动、ComfyUI 排队都可能远超 `client()` 的 120s；总时长由上层
/// 轮询 deadline 控制，单次请求用 `RequestBuilder::timeout()` 单独限时。
#[must_use]
pub fn long_client() -> reqwest::Client {
    LONG_CLIENT.clone()
}

/// 给请求加 `Bearer` 鉴权；key 为空（Ollama 默认无鉴权）时不加头。
pub fn with_bearer(builder: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
    let key = api_key.trim();
    if key.is_empty() {
        builder
    } else {
        builder.header("Authorization", format!("Bearer {key}"))
    }
}

/// 归一化 `OpenAI` 兼容服务地址：去掉尾部 `/`、`/chat/completions`、尾部 `/vN`。
///
/// 前端历史上自己做字符串手术（`DrawingWorkspace.tsx` / `image-gen.ts`），
/// 只能处理精确后缀；尾斜杠、带路径前缀时拼错。统一在 Rust 侧归一化：
///   `https://api.openai.com/v1/chat/completions` → `https://api.openai.com`
///   `http://localhost:11434/v1/`                → `http://localhost:11434`
///   `https://host/v1beta/openai/`               → `https://host/v1beta/openai`
#[must_use]
pub fn normalize_base_url(raw: &str) -> String {
    let mut base = raw.trim().trim_end_matches('/').to_string();
    if let Some(stripped) = base.strip_suffix("/chat/completions") {
        base = stripped.trim_end_matches('/').to_string();
    }
    if let Some(pos) = base.rfind('/') {
        let segment = &base[pos + 1..];
        let is_version = segment.len() > 1
            && segment.starts_with('v')
            && segment[1..].bytes().all(|b| b.is_ascii_digit());
        if is_version {
            base.truncate(pos);
        }
    }
    base.trim_end_matches('/').to_string()
}

/// 地址（path 部分）里是否已带版本段（`/v1`、`/v1beta` 等）。
///
/// 用于避免给 `.../v1beta/openai` 这类地址再塞一层 `/v1`（T-149）。
fn has_version_segment(base: &str) -> bool {
    base.split('/').any(|seg| {
        seg.len() > 1
            && seg.starts_with('v')
            && seg[1..].bytes().all(|b| b.is_ascii_alphanumeric())
            && seg[1..].bytes().any(|b| b.is_ascii_digit())
    })
}

/// 拼 `OpenAI` 兼容端点：`{base}/v1/{tail}`，base 已含版本段时只追加 `{tail}`。
#[must_use]
pub fn openai_api_url(base_url: &str, tail: &str) -> String {
    let base = normalize_base_url(base_url);
    if has_version_segment(&base) {
        format!("{base}/{tail}")
    } else {
        format!("{base}/v1/{tail}")
    }
}

/// 拼 `OpenAI` 兼容图片生成端点；传入完整端点（旧前端）时原样保留。
#[must_use]
pub fn openai_images_url(base_url: &str) -> String {
    let base = normalize_base_url(base_url);
    if base.ends_with("/images/generations") {
        base
    } else {
        openai_api_url(&base, "images/generations")
    }
}

/// HTTP 错误体截断：最多 300 个字符（按 char 边界，避免切碎中文）。
#[must_use]
pub fn truncate_for_error(body: &str) -> String {
    const LIMIT: usize = 300;
    let trimmed = body.trim();
    if trimmed.chars().count() <= LIMIT {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(LIMIT).collect();
    format!("{head}…")
}

/// 日志脱敏：去掉 URL 的 query / fragment，并遮蔽 userinfo 里的密码。
///
/// T-067：失败日志会同时落到 `%APPDATA%` 与 exe 同级目录；`api_url` 的
/// query 里常带 `?key=` / `?token=`，原样写日志等于把密钥抄到磁盘上。
/// 保留 scheme/host/path，排障时仍能看出请求打到了哪个端点。
#[must_use]
pub fn redact_url(raw: &str) -> String {
    let trimmed = raw.trim();
    let no_fragment = &trimmed[..trimmed.find('#').unwrap_or(trimmed.len())];
    let no_query = &no_fragment[..no_fragment.find('?').unwrap_or(no_fragment.len())];
    redact_userinfo(no_query)
}

/// 遮蔽 `scheme://user:password@host/...` 里的密码部分（只留用户名）。
fn redact_userinfo(url: &str) -> String {
    let Some(scheme_pos) = url.find("://") else {
        return url.to_string();
    };
    let authority_start = scheme_pos + 3;
    let rest = &url[authority_start..];
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let Some(at) = authority.rfind('@') else {
        return url.to_string();
    };
    let userinfo = &authority[..at];
    let Some(colon) = userinfo.find(':') else {
        return url.to_string();
    };
    format!(
        "{}{}:***@{}{}",
        &url[..authority_start],
        &userinfo[..colon],
        &authority[at + 1..],
        &rest[authority_end..]
    )
}

/// 把一段任意文本里的 URL 逐个脱敏（用于上游/reqwest 的错误正文）。
///
/// `reqwest::Error` 的 Display 会带完整请求 URL；只脱敏 `url=` 字段还不够，
/// 错误文本里的 query token 同样会进日志（T-067）。
#[must_use]
pub fn redact_urls_in_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = next_url_start(rest) {
        out.push_str(&rest[..pos]);
        let candidate = &rest[pos..];
        let end = candidate
            .find(|c: char| {
                c.is_whitespace()
                    || matches!(
                        c,
                        ')' | '(' | '"' | '\'' | '<' | '>' | ']' | '[' | ',' | ';'
                    )
            })
            .unwrap_or(candidate.len());
        out.push_str(&redact_url(&candidate[..end]));
        rest = &candidate[end..];
    }
    out.push_str(rest);
    out
}

fn next_url_start(text: &str) -> Option<usize> {
    ["http://", "https://"]
        .iter()
        .filter_map(|prefix| text.find(prefix))
        .min()
}

/// 需要代理的非流式客户端（翻译的 `Google` / `DeepL` 在国内必需代理）。
///
/// 冻结接口只有前两个；代理地址由用户配置、每个请求可能不同，无法放进
/// 全局单例，所以额外暴露这一个共享同一套超时/重定向策略的构造器。
///
/// # Errors
/// 代理 URL 非法或 TLS 后端初始化失败时返回错误文案。
pub fn client_with_proxy(proxy_url: &str) -> Result<reqwest::Client, String> {
    let proxy = proxy_url.trim();
    let mut builder = base_builder().timeout(REQUEST_TIMEOUT);
    if !proxy.is_empty() {
        builder =
            builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| format!("代理配置错误: {e}"))?);
    }
    builder.build().map_err(|e| format!("客户端创建失败: {e}"))
}

/// 单条 SSE 行的字节上限（1 MiB）。
///
/// 上游若一直不发换行（半开连接、错误网关），无上限缓冲会把整进程内存吃光；
/// 超过上限即按流错误中止（T-064）。
pub const MAX_SSE_LINE_BYTES: usize = 1024 * 1024;

/// SSE 增量行缓冲：**只在出现完整换行时才解码**。
///
/// RS-10 的根因是 `String::from_utf8_lossy(&chunk)` 对每片 HTTP 字节单独解码：
/// 一个中文字符的 3 个字节被 TCP/HTTP 分片切开时，前半片解出 `�`，后半片再解出
/// `�`，并且立即写进 UI 和数据库。这里改为保留原始字节，遇到 `\n` 才切出整行
/// 解码 —— 跨分片的半个字符会留在缓冲里等下一片补齐。
///
/// T-064：旧实现每次 `push` 都从缓冲头部重扫，上游不发换行时整体 O(n²)；
/// 现在用 `scan_pos` 记录已扫描偏移，只扫描新追加的字节。
#[derive(Debug, Default)]
pub struct SseLineBuffer {
    buf: Vec<u8>,
    /// `buf` 中 `[0, scan_pos)` 已经扫描过换行符，无需重扫。
    scan_pos: usize,
}

impl SseLineBuffer {
    #[must_use]
    pub fn new() -> Self {
        Self {
            buf: Vec::new(),
            scan_pos: 0,
        }
    }

    /// 追加一片 HTTP 字节，返回本次凑齐的所有完整行。
    ///
    /// 行尾 `\n` 与 `\r` 已去掉，返回的行已 `trim()`（与旧实现的处理一致）。
    /// 没有换行的残余（含半个 UTF-8 字符）继续留在缓冲里。
    ///
    /// # Errors
    /// 单行超过 [`MAX_SSE_LINE_BYTES`] 时返回可读错误，并清空缓冲 ——
    /// 调用方必须中止整条流，不能继续累积内存。
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        self.buf.extend_from_slice(chunk);
        let scanned_to = self.buf.len();
        let mut lines = Vec::new();
        let mut consumed = 0;
        let mut i = self.scan_pos;
        while i < scanned_to {
            if self.buf[i] == b'\n' {
                if i - consumed > MAX_SSE_LINE_BYTES {
                    self.buf.clear();
                    self.scan_pos = 0;
                    return Err(oversized_line_error());
                }
                let line = String::from_utf8_lossy(&self.buf[consumed..i]);
                lines.push(line.trim().to_string());
                consumed = i + 1;
            }
            i += 1;
        }
        if consumed > 0 {
            self.buf.drain(..consumed);
        }
        self.scan_pos = self.buf.len();
        if self.buf.len() > MAX_SSE_LINE_BYTES {
            self.buf.clear();
            self.scan_pos = 0;
            return Err(oversized_line_error());
        }
        Ok(lines)
    }

    /// 流结束时取出末尾没有换行的残行；空缓冲或纯空白返回 `None`。
    ///
    /// 这里才允许 `from_utf8_lossy` 兜底：真正的流末尾若仍留着半个字符，
    /// 那是上游发坏了，替换字符只影响最后一行，不会污染此前的正文。
    pub fn flush(&mut self) -> Option<String> {
        if self.buf.is_empty() {
            return None;
        }
        let raw = std::mem::take(&mut self.buf);
        self.scan_pos = 0;
        let line = String::from_utf8_lossy(&raw).trim().to_string();
        if line.is_empty() {
            None
        } else {
            Some(line)
        }
    }
}

fn oversized_line_error() -> String {
    format!(
        "SSE 单行超过上限（{} MiB），已中止解析（上游可能未发送换行）",
        MAX_SSE_LINE_BYTES / (1024 * 1024)
    )
}

#[cfg(test)]
mod sse_line_buffer_tests {
    use super::{SseLineBuffer, MAX_SSE_LINE_BYTES};

    #[test]
    fn utf8_char_split_across_two_chunks_is_decoded_whole() {
        let mut buf = SseLineBuffer::new();
        // "data: 中\n" — "中" = E4 B8 AD；在 8 字节处切开（"data: " 6 字节 + E4 B8）
        let full = "data: 中\n".as_bytes();
        let (head, tail) = full.split_at(8);
        assert!(
            buf.push(head).expect("push").is_empty(),
            "没有换行时必须把半个字符留在缓冲里，不能先解码"
        );
        let lines = buf.push(tail).expect("push");
        assert_eq!(lines, vec!["data: 中".to_string()]);
        assert!(
            !lines[0].contains('\u{FFFD}'),
            "跨分片的中文不能变成替换字符"
        );
    }

    #[test]
    fn lines_split_across_many_chunks_keep_order_and_content() {
        let mut buf = SseLineBuffer::new();
        assert!(buf.push(b"da").expect("push").is_empty());
        assert!(buf.push(b"ta: hel").expect("push").is_empty());
        let lines = buf.push(b"lo\nsecond\n").expect("push");
        assert_eq!(lines, vec!["data: hello".to_string(), "second".to_string()]);

        // 一次给两行 + 一行空行 + CRLF 行尾
        let lines = buf.push(b"third\r\n\nfourth\n").expect("push");
        assert_eq!(
            lines,
            vec!["third".to_string(), String::new(), "fourth".to_string()],
            "一次收到多行时顺序与去 CR 都要正确"
        );
    }

    #[test]
    fn flush_emits_trailing_line_without_newline() {
        let mut buf = SseLineBuffer::new();
        let lines = buf.push(b"data: tail-without-newline").expect("push");
        assert!(lines.is_empty(), "无换行时不应提前吐行");
        assert_eq!(buf.flush(), Some("data: tail-without-newline".to_string()));
        assert_eq!(buf.flush(), None, "flush 后缓冲应清空");
    }

    /// T-064：增量扫描必须只扫新字节，且跨 push 的分行仍然正确。
    #[test]
    fn incremental_scan_keeps_lines_across_pushes() {
        let mut buf = SseLineBuffer::new();
        assert_eq!(buf.push(b"alpha\nbe").expect("push").len(), 1);
        let lines = buf.push(b"ta\ngamma").expect("push");
        assert_eq!(
            lines,
            vec!["beta".to_string()],
            "上一片扫描过的字节不能影响下一片的分行"
        );
        assert_eq!(buf.flush(), Some("gamma".to_string()));
    }

    /// T-064：上游持续发无换行数据时，内存必须有界并报错。
    #[test]
    fn oversized_line_without_newline_errors_and_frees_buffer() {
        let mut buf = SseLineBuffer::new();
        let big = vec![b'a'; MAX_SSE_LINE_BYTES + 1];
        let err = buf
            .push(&big)
            .expect_err("超过单行上限必须返回流错误，不能继续累积内存");
        assert!(err.contains("上限"), "错误文案要能读懂: {err}");
        assert!(buf.flush().is_none(), "报错后必须清空缓冲，内存有界");
    }

    /// T-064：即使超长行自带换行，也同样拒绝 —— 上限约束的是单行长度。
    #[test]
    fn oversized_line_with_newline_is_rejected() {
        let mut buf = SseLineBuffer::new();
        let mut chunk = vec![b'a'; MAX_SSE_LINE_BYTES + 1];
        chunk.push(b'\n');
        assert!(
            buf.push(&chunk).is_err(),
            "带换行的超长单行同样要拒，否则上限形同虚设"
        );
    }
}

#[cfg(test)]
mod url_redaction_tests {
    use super::{redact_url, redact_urls_in_text};

    #[test]
    fn redact_url_drops_query_fragment_and_password() {
        assert_eq!(
            redact_url("https://gateway.example/v1/chat?token=SECRET#frag"),
            "https://gateway.example/v1/chat"
        );
        assert_eq!(
            redact_url("https://user:pass@gw.example/path?key=k"),
            "https://user:***@gw.example/path"
        );
        assert_eq!(
            redact_url("http://localhost:11434/v1"),
            "http://localhost:11434/v1",
            "无敏感信息时保持原样"
        );
    }

    #[test]
    fn redact_urls_in_text_scrubs_urls_embedded_in_errors() {
        // reqwest 的 Display 会带完整请求 URL，query 里的 token 不能落进日志。
        let msg =
            "error sending request for url (https://gateway.example/v1?token=SECRET): timed out";
        let out = redact_urls_in_text(msg);
        assert!(
            !out.contains("SECRET"),
            "错误正文里的 token 也要脱敏: {out}"
        );
        assert!(
            out.contains("gateway.example/v1"),
            "host/path 要保留以便排障: {out}"
        );
        assert!(out.contains("timed out"), "非 URL 文本要原样保留: {out}");
    }
}

#[cfg(test)]
mod timeout_policy_tests {
    use super::{
        image_client, upload_client, Duration, FIRST_BYTE_TIMEOUT, IMAGE_TIMEOUT,
        STREAM_IDLE_TIMEOUT,
    };

    #[test]
    fn timeout_policy_matches_agreed_values() {
        assert_eq!(
            FIRST_BYTE_TIMEOUT,
            Duration::from_mins(3),
            "首字节等待必须是 180 秒"
        );
        assert_eq!(
            STREAM_IDLE_TIMEOUT,
            Duration::from_mins(1),
            "首字节之后每片等待保持 60 秒"
        );
        assert_eq!(
            IMAGE_TIMEOUT,
            Duration::from_mins(5),
            "图片生成/下载总超时必须是 300 秒"
        );
        assert!(
            FIRST_BYTE_TIMEOUT > STREAM_IDLE_TIMEOUT,
            "首字节容忍度必须比后续空闲长"
        );
    }

    #[test]
    fn image_client_can_be_built() {
        // 不实际发请求：只需确认构造链（TLS 后端 + 超时 + 重定向策略）不报错。
        let _client = image_client();
    }

    #[test]
    fn upload_client_can_be_built() {
        // 上传客户端与 streaming 一样是无总超时策略，只需确认可构造。
        let _client = upload_client();
    }
}

#[cfg(test)]
mod url_normalization_tests {
    use super::{normalize_base_url, openai_api_url, openai_images_url, truncate_for_error};

    #[test]
    fn normalize_base_url_strips_chat_completions_version_and_slash() {
        assert_eq!(
            normalize_base_url("https://api.openai.com/v1/chat/completions"),
            "https://api.openai.com"
        );
        assert_eq!(
            normalize_base_url("https://api.openai.com/v1/"),
            "https://api.openai.com"
        );
        assert_eq!(
            normalize_base_url("  http://localhost:11434/v1  "),
            "http://localhost:11434"
        );
        assert_eq!(
            normalize_base_url("http://127.0.0.1:1234/v1/chat/completions/"),
            "http://127.0.0.1:1234"
        );
    }

    #[test]
    fn normalize_base_url_keeps_non_numeric_version_paths() {
        // T-149：v1beta/openai 不能被误当作 `/vN` 尾段剥掉
        assert_eq!(
            normalize_base_url("https://generativelanguage.googleapis.com/v1beta/openai"),
            "https://generativelanguage.googleapis.com/v1beta/openai"
        );
        assert_eq!(
            normalize_base_url("https://host.example.com/some/path/"),
            "https://host.example.com/some/path"
        );
    }

    #[test]
    fn openai_api_url_adds_v1_only_when_missing() {
        assert_eq!(
            openai_api_url("http://localhost:11434/v1", "chat/completions"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            openai_api_url("http://localhost:11434", "chat/completions"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            openai_api_url(
                "https://generativelanguage.googleapis.com/v1beta/openai/",
                "chat/completions"
            ),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        );
    }

    #[test]
    fn openai_images_url_does_not_double_append() {
        assert_eq!(
            openai_images_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/images/generations"
        );
        // 旧前端传完整端点：必须原样保留
        assert_eq!(
            openai_images_url("https://api.openai.com/v1/images/generations"),
            "https://api.openai.com/v1/images/generations"
        );
        assert_eq!(
            openai_images_url("https://generativelanguage.googleapis.com/v1beta/openai"),
            "https://generativelanguage.googleapis.com/v1beta/openai/images/generations"
        );
    }

    #[test]
    fn truncate_for_error_is_char_boundary_safe_and_limited() {
        let long = "中".repeat(400);
        let cut = truncate_for_error(&long);
        assert_eq!(cut.chars().count(), 301, "300 字 + 省略号");
        assert!(cut.ends_with('…'));
        assert_eq!(truncate_for_error(" short "), "short");
    }
}
