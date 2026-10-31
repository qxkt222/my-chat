// adapters/sse_parser.rs
// SSE stream parsing utilities

pub struct AdapterConfig {
    pub data_prefix: String,
    pub done_marker: String,
    pub content_path: Vec<String>,
}

impl AdapterConfig {
    pub fn openai_compatible() -> Self {
        Self {
            data_prefix: "data: ".to_string(),
            done_marker: "[DONE]".to_string(),
            content_path: vec![
                "choices".to_string(),
                "0".to_string(),
                "delta".to_string(),
                "content".to_string(),
            ],
        }
    }

    pub fn custom(data_prefix: String, done_marker: String, content_path: Vec<String>) -> Self {
        Self {
            data_prefix,
            done_marker,
            content_path,
        }
    }
}

/// 去掉 SSE 数据前缀（T-059）。
///
/// SSE 规范里字段名后的空格是**可选**分隔符：`data:{...}` 与 `data: {...}`
/// 等价。默认配置 `data_prefix = "data: "`，旧实现只认带空格的形式，
/// `data:{...}` 会被当成整行 JSON 去解析而失败，最终表现为「空回答」。
///
/// 先按配置的完整前缀匹配；只有配置前缀以空白结尾时，才允许退回到
/// 去掉尾部空白的短前缀并 `trim_start`。自定义前缀（如 `DATA|`）不受影响。
#[must_use]
pub fn strip_data_prefix<'a>(prefix: &str, line: &'a str) -> &'a str {
    if prefix.is_empty() {
        return line;
    }
    if let Some(rest) = line.strip_prefix(prefix) {
        return rest;
    }
    let bare = prefix.trim_end();
    if bare.len() < prefix.len() {
        if let Some(rest) = line.strip_prefix(bare) {
            return rest.trim_start();
        }
    }
    line
}

/// Parse a single SSE line and return `(content, done)`.
///
/// `Err` carries a readable message when the payload is a stream-level error
/// event (`{"error": ...}`) — gateways/relays such as `OpenRouter` or `one-api`
/// can answer HTTP 200 and then report the failure inside the stream. Callers
/// must abort the request instead of treating it as an empty delta.
pub fn parse_sse_chunk(
    config: &AdapterConfig,
    line: &str,
) -> Result<Option<(String, bool)>, String> {
    // Strip the provider prefix first so the checks below see the payload.
    let data = strip_data_prefix(&config.data_prefix, line);

    // Skip empty or comment lines
    if data.is_empty() || data.starts_with(':') {
        return Ok(None);
    }

    // Parse JSON before the done check: an error event whose message happens
    // to contain the done marker must still be reported as an error. A real
    // done marker is not JSON, so it falls through to the check below.
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
        if let Some(message) = top_level_error_message(&json) {
            return Err(message);
        }
        let content = extract_path(&json, &config.content_path)
            .and_then(|v| v.as_str())
            .map(std::string::ToString::to_string)
            .unwrap_or_default();
        return Ok(Some((content, false)));
    }

    if !config.done_marker.is_empty() && data.trim() == config.done_marker {
        return Ok(Some((String::new(), true)));
    }

    Ok(None)
}

/// Read a top-level `error` field into a user-facing message.
///
/// Gateways send either `{"error": {"message": "..."}}` or `{"error": "..."}`.
/// `null` and empty values are not failures.
fn top_level_error_message(json: &serde_json::Value) -> Option<String> {
    let error = json.get("error")?;
    let detail = match error {
        serde_json::Value::String(s) => s.trim().to_string(),
        serde_json::Value::Object(map) => map
            .get("message")
            .and_then(serde_json::Value::as_str)
            .map_or_else(
                || serde_json::to_string(error).unwrap_or_default(),
                |message| message.trim().to_string(),
            ),
        _ => return None,
    };
    let detail = detail.trim();
    if detail.is_empty() || detail == "{}" {
        None
    } else {
        Some(format!("流内错误: {detail}"))
    }
}

fn extract_path<'a>(
    value: &'a serde_json::Value,
    path: &[String],
) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for key in path {
        match current {
            serde_json::Value::Object(map) => {
                current = map.get(key)?;
            }
            serde_json::Value::Array(arr) => {
                let idx: usize = key.parse().ok()?;
                current = arr.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> AdapterConfig {
        AdapterConfig::openai_compatible()
    }

    #[test]
    fn parses_openai_sse_delta() {
        let line = r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#;
        let r = parse_sse_chunk(&cfg(), line);
        assert_eq!(r, Ok(Some(("你好".to_string(), false))));
    }

    #[test]
    fn detects_done_marker() {
        let r = parse_sse_chunk(&cfg(), "data: [DONE]");
        assert_eq!(r, Ok(Some((String::new(), true))));
    }

    #[test]
    fn skips_comment_and_empty_lines() {
        assert_eq!(parse_sse_chunk(&cfg(), ": keepalive"), Ok(None));
        assert_eq!(parse_sse_chunk(&cfg(), ""), Ok(None));
    }

    #[test]
    fn custom_prefix_and_path() {
        let c = AdapterConfig::custom(
            "DATA|".to_string(),
            "END".to_string(),
            vec!["result".to_string(), "text".to_string()],
        );
        let r = parse_sse_chunk(&c, r#"DATA|{"result":{"text":"ok"}}"#);
        assert_eq!(r, Ok(Some(("ok".to_string(), false))));
        let done = parse_sse_chunk(&c, "DATA|END");
        assert_eq!(done, Ok(Some((String::new(), true))));
    }

    #[test]
    fn invalid_json_yields_none() {
        assert_eq!(parse_sse_chunk(&cfg(), "data: not-json"), Ok(None));
    }

    #[test]
    fn array_path_indexing() {
        let c = AdapterConfig::custom(
            "data: ".into(),
            "[DONE]".into(),
            vec!["a".into(), "1".into()],
        );
        let r = parse_sse_chunk(&c, r#"data: {"a":["x","y"]}"#);
        assert_eq!(r, Ok(Some(("y".to_string(), false))));
    }

    #[test]
    fn stream_error_object_returns_err_with_readable_message() {
        // 网关/中转在 HTTP 200 之后下发 error 事件：必须上报错误，而不是空 delta。
        let line = r#"data: {"error":{"message":"boom","type":"invalid_request_error"}}"#;
        let err = parse_sse_chunk(&cfg(), line).expect_err("顶层 error 对象必须返回 Err");
        assert!(err.contains("boom"), "错误消息要可读: {err}");
    }

    #[test]
    fn stream_error_string_returns_err() {
        let line = r#"data: {"error":"rate limited"}"#;
        let err = parse_sse_chunk(&cfg(), line).expect_err("字符串 error 必须返回 Err");
        assert!(err.contains("rate limited"), "错误消息要可读: {err}");
    }

    #[test]
    fn null_error_field_is_not_an_error() {
        let line = r#"data: {"error":null,"choices":[{"delta":{"content":"ok"}}]}"#;
        assert_eq!(
            parse_sse_chunk(&cfg(), line),
            Ok(Some(("ok".to_string(), false)))
        );
    }

    #[test]
    fn error_payload_containing_done_marker_is_still_an_error() {
        // 错误信息里带字面量 [DONE] 时不能被当成正常结束（done 判定在 JSON 之后）。
        let line = r#"data: {"error":{"message":"upstream aborted before [DONE]"}}"#;
        let err = parse_sse_chunk(&cfg(), line).expect_err("含 [DONE] 的错误行仍必须是错误");
        assert!(err.contains("upstream aborted"), "错误消息要可读: {err}");
    }

    /// T-058：正文里出现字面量 `[DONE]` 不是结束标记，不能丢后续内容。
    #[test]
    fn content_containing_done_literal_does_not_end_stream() {
        let line = r#"data: {"choices":[{"delta":{"content":"before [DONE] after"}}]}"#;
        assert_eq!(
            parse_sse_chunk(&cfg(), line),
            Ok(Some(("before [DONE] after".to_string(), false))),
            "正文含 [DONE] 必须按普通 delta 返回，不能提前结束"
        );
    }

    /// T-058：非 JSON 行中出现的 `[DONE]` 片段也不能被整行 contains 误判。
    #[test]
    fn non_json_line_with_done_literal_is_ignored() {
        assert_eq!(
            parse_sse_chunk(&cfg(), "data: text [DONE] more"),
            Ok(None),
            "只有 trim 后与 done_marker 完全相等才算结束"
        );
    }

    /// T-059：SSE 规范允许 `data:` 后不带空格。
    #[test]
    fn accepts_data_prefix_without_space() {
        let line = r#"data:{"choices":[{"delta":{"content":"ok"}}]}"#;
        assert_eq!(
            parse_sse_chunk(&cfg(), line),
            Ok(Some(("ok".to_string(), false))),
            "data:{{...}} 必须与 data: {{...}} 一样解析"
        );
    }

    /// T-059：结束标记同样允许无空格前缀。
    #[test]
    fn done_marker_without_space_after_prefix() {
        assert_eq!(
            parse_sse_chunk(&cfg(), "data:[DONE]"),
            Ok(Some((String::new(), true)))
        );
    }

    /// 自定义前缀（不带尾部空白）仍只做精确匹配，不受无空格兼容逻辑影响。
    #[test]
    fn custom_prefix_is_not_trimmed() {
        let c = AdapterConfig::custom("DATA|".to_string(), "END".to_string(), vec![]);
        assert_eq!(
            parse_sse_chunk(&c, "DATA|{\"x\":1}"),
            Ok(Some((String::new(), false)))
        );
    }
}
