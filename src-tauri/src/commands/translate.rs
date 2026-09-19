// commands/translate.rs — 非 AI 翻译引擎(专业翻译服务,不消耗对话模型)
//
// 用户明确要求:翻译用专业翻译服务而非对话 LLM。
// 引擎:
//  - google:免费免 key 网页接口(client=gtx,2026 仍可用),默认
//  - deepl:官方 API(免费档 500k 字符/月),需 key
//  - libre:LibreTranslate(开源,可自托管或公共实例),需 URL

use reqwest::Client;

#[tauri::command]
pub async fn translate_text(
    text: String,
    target_lang: String,
    engine: String,
    deepl_key: String,
    libre_url: String,
    proxy_url: String,
) -> Result<String, String> {
    match engine.as_str() {
        "deepl" => deepl_translate(&text, &target_lang, &deepl_key, &proxy_url).await,
        "libre" => libre_translate(&text, &target_lang, &libre_url, &proxy_url).await,
        _ => google_translate(&text, &target_lang, &proxy_url).await,
    }
}

/// 构造 HTTP `客户端;proxy_url` 非空时走代理(国内访问 Google 必需,如 <http://127.0.0.1:23385>)
fn build_client(proxy_url: &str) -> Result<Client, String> {
    let mut b = Client::builder();
    let p = proxy_url.trim();
    if !p.is_empty() {
        b = b.proxy(reqwest::Proxy::all(p).map_err(|e| format!("代理配置错误: {e}"))?);
    }
    b.build().map_err(|e| format!("客户端创建失败: {e}"))
}

/// 长文本分块(单请求过长会失败):按段落聚合,每块 ≤ `CHUNK_MAX` 字符
const CHUNK_MAX: usize = 4500;

fn chunk_text(text: &str) -> Vec<String> {
    let paras: Vec<&str> = text.split("\n\n").collect();
    let mut queue: Vec<String> = Vec::new();
    let mut buf = String::new();
    for para in paras {
        if !buf.is_empty() && buf.len() + para.len() + 2 > CHUNK_MAX {
            queue.push(std::mem::take(&mut buf));
        }
        if !buf.is_empty() {
            buf.push_str("\n\n");
        }
        buf.push_str(para);
    }
    if !buf.is_empty() {
        queue.push(buf);
    }
    queue
}

async fn google_translate(text: &str, target: &str, proxy_url: &str) -> Result<String, String> {
    let client = build_client(proxy_url)?;
    let chunks = chunk_text(text);
    if chunks.is_empty() {
        return Ok(String::new());
    }
    let mut out = String::new();
    for (i, q) in chunks.iter().enumerate() {
        let resp = client
            .get("https://translate.googleapis.com/translate_a/single")
            .query(&[
                ("client", "gtx"),
                ("sl", "auto"),
                ("tl", target),
                ("dt", "t"),
                ("q", q.as_str()),
            ])
            .send()
            .await
            .map_err(|e| format!("Google 翻译请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Google 翻译错误 HTTP {}", resp.status().as_u16()));
        }
        let json: serde_json::Value = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;
        // translate_a 响应:[[["译文","原文",...],...],...] — 取 [0][n][0]
        if let Some(segs) = json
            .as_array()
            .and_then(|a| a.first())
            .and_then(|v| v.as_array())
        {
            for seg in segs {
                if let Some(s) = seg
                    .as_array()
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                {
                    out.push_str(s);
                }
            }
        }
        if i + 1 < chunks.len() {
            out.push_str("\n\n");
        }
    }
    Ok(out)
}

async fn deepl_translate(
    text: &str,
    target: &str,
    key: &str,
    proxy_url: &str,
) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("未配置 DeepL API Key(设置 → 翻译)".to_string());
    }
    let client = build_client(proxy_url)?;
    // 免费 key(以 :fx 结尾)走 api-free,否则走 api
    let base = if key.ends_with(":fx") {
        "https://api-free.deepl.com"
    } else {
        "https://api.deepl.com"
    };
    let resp = client
        .post(format!("{base}/v2/translate"))
        .header("Authorization", format!("DeepL-Auth-Key {key}"))
        .json(&serde_json::json!({ "text": [text], "target_lang": target }))
        .send()
        .await
        .map_err(|e| format!("DeepL 请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let json: serde_json::Value = if resp.status().is_success() {
        resp.json().await.map_err(|e| format!("解析失败: {e}"))?
    } else {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("DeepL 错误 HTTP {status}: {body}"));
    };
    json["translations"][0]["text"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| "DeepL 响应无译文".to_string())
}

async fn libre_translate(
    text: &str,
    target: &str,
    url: &str,
    proxy_url: &str,
) -> Result<String, String> {
    let base = url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(
            "未配置 LibreTranslate 服务地址(设置 → 翻译,如自托管 http://localhost:5000 或公共实例)"
                .to_string(),
        );
    }
    let client = build_client(proxy_url)?;
    let resp = client
        .post(format!("{base}/translate"))
        .json(
            &serde_json::json!({ "q": text, "source": "auto", "target": target, "format": "text" }),
        )
        .send()
        .await
        .map_err(|e| format!("LibreTranslate 请求失败: {e}"))?;
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;
    if let Some(err) = json.get("error") {
        return Err(format!("LibreTranslate: {err}"));
    }
    json["translatedText"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| "LibreTranslate 响应无译文".to_string())
}
