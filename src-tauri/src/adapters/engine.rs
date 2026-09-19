// adapters/engine.rs
// Build API URLs

pub fn build_api_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    // Full OpenAI-compatible endpoint — use as-is (custom relay/proxy providers)
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    }
    // Versioned base (v1 / v2) — append the chat path
    else if trimmed.ends_with("/v1") || trimmed.ends_with("/v2") {
        format!("{trimmed}/chat/completions")
    }
    // Bare base — default to the OpenAI v1 path
    else {
        format!("{trimmed}/v1/chat/completions")
    }
}
