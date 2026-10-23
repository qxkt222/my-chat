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

/// SSE 增量行缓冲：**只在出现完整换行时才解码**。
///
/// RS-10 的根因是 `String::from_utf8_lossy(&chunk)` 对每片 HTTP 字节单独解码：
/// 一个中文字符的 3 个字节被 TCP/HTTP 分片切开时，前半片解出 `�`，后半片再解出
/// `�`，并且立即写进 UI 和数据库。这里改为保留原始字节，遇到 `\n` 才切出整行
/// 解码 —— 跨分片的半个字符会留在缓冲里等下一片补齐。
#[derive(Debug, Default)]
pub struct SseLineBuffer {
    buf: Vec<u8>,
}

impl SseLineBuffer {
    #[must_use]
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// 追加一片 HTTP 字节，返回本次凑齐的所有完整行。
    ///
    /// 行尾 `\n` 与 `\r` 已去掉，返回的行已 `trim()`（与旧实现的处理一致）。
    /// 没有换行的残余（含半个 UTF-8 字符）继续留在缓冲里。
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut consumed = 0;
        for (i, &b) in self.buf.iter().enumerate() {
            if b == b'\n' {
                let line = String::from_utf8_lossy(&self.buf[consumed..i]);
                lines.push(line.trim().to_string());
                consumed = i + 1;
            }
        }
        if consumed > 0 {
            self.buf.drain(..consumed);
        }
        lines
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
        let line = String::from_utf8_lossy(&raw).trim().to_string();
        if line.is_empty() {
            None
        } else {
            Some(line)
        }
    }
}

#[cfg(test)]
mod sse_line_buffer_tests {
    use super::SseLineBuffer;

    #[test]
    fn utf8_char_split_across_two_chunks_is_decoded_whole() {
        let mut buf = SseLineBuffer::new();
        // "data: 中\n" — "中" = E4 B8 AD；在 8 字节处切开（"data: " 6 字节 + E4 B8）
        let full = "data: 中\n".as_bytes();
        let (head, tail) = full.split_at(8);
        assert!(
            buf.push(head).is_empty(),
            "没有换行时必须把半个字符留在缓冲里，不能先解码"
        );
        let lines = buf.push(tail);
        assert_eq!(lines, vec!["data: 中".to_string()]);
        assert!(
            !lines[0].contains('\u{FFFD}'),
            "跨分片的中文不能变成替换字符"
        );
    }

    #[test]
    fn lines_split_across_many_chunks_keep_order_and_content() {
        let mut buf = SseLineBuffer::new();
        assert!(buf.push(b"da").is_empty());
        assert!(buf.push(b"ta: hel").is_empty());
        let lines = buf.push(b"lo\nsecond\n");
        assert_eq!(lines, vec!["data: hello".to_string(), "second".to_string()]);

        // 一次给两行 + 一行空行 + CRLF 行尾
        let lines = buf.push(b"third\r\n\nfourth\n");
        assert_eq!(
            lines,
            vec!["third".to_string(), String::new(), "fourth".to_string()],
            "一次收到多行时顺序与去 CR 都要正确"
        );
    }

    #[test]
    fn flush_emits_trailing_line_without_newline() {
        let mut buf = SseLineBuffer::new();
        let lines = buf.push(b"data: tail-without-newline");
        assert!(lines.is_empty(), "无换行时不应提前吐行");
        assert_eq!(buf.flush(), Some("data: tail-without-newline".to_string()));
        assert_eq!(buf.flush(), None, "flush 后缓冲应清空");
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
