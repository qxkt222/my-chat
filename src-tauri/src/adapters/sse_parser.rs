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

/// Parse a single SSE line and return (content, done)
pub fn parse_sse_chunk(config: &AdapterConfig, line: &str) -> Option<(String, bool)> {
    // Check done marker
    if !config.done_marker.is_empty() && line.contains(&config.done_marker) {
        return Some((String::new(), true));
    }

    // Strip prefix
    let data = if !config.data_prefix.is_empty() && line.starts_with(&config.data_prefix) {
        &line[config.data_prefix.len()..]
    } else {
        line
    };

    // Skip empty or comment lines
    if data.is_empty() || data.starts_with(':') {
        return None;
    }

    // Parse JSON and extract content via path
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
        let content = extract_path(&json, &config.content_path)
            .and_then(|v| v.as_str())
            .map(std::string::ToString::to_string)
            .unwrap_or_default();
        return Some((content, false));
    }

    None
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
        assert_eq!(r, Some(("你好".to_string(), false)));
    }

    #[test]
    fn detects_done_marker() {
        let r = parse_sse_chunk(&cfg(), "data: [DONE]");
        assert_eq!(r, Some((String::new(), true)));
    }

    #[test]
    fn skips_comment_and_empty_lines() {
        assert_eq!(parse_sse_chunk(&cfg(), ": keepalive"), None);
        assert_eq!(parse_sse_chunk(&cfg(), ""), None);
    }

    #[test]
    fn custom_prefix_and_path() {
        let c = AdapterConfig::custom(
            "DATA|".to_string(),
            "END".to_string(),
            vec!["result".to_string(), "text".to_string()],
        );
        let r = parse_sse_chunk(&c, r#"DATA|{"result":{"text":"ok"}}"#);
        assert_eq!(r, Some(("ok".to_string(), false)));
        let done = parse_sse_chunk(&c, "DATA|END");
        assert_eq!(done, Some((String::new(), true)));
    }

    #[test]
    fn invalid_json_yields_none() {
        assert_eq!(parse_sse_chunk(&cfg(), "data: not-json"), None);
    }

    #[test]
    fn array_path_indexing() {
        let c = AdapterConfig::custom(
            "data: ".into(),
            "[DONE]".into(),
            vec!["a".into(), "1".into()],
        );
        let r = parse_sse_chunk(&c, r#"data: {"a":["x","y"]}"#);
        assert_eq!(r, Some(("y".to_string(), false)));
    }
}
