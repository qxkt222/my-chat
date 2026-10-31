// commands/draw.rs — 图片生成(OpenAI 兼容 / ComfyUI / SD WebUI)
//
// 契约(阶段 2a):
//  - `generate_image(DrawRequest)` 按 `engine` 分派 openai | comfyui | sdwebui;
//  - 返回值改为多图 `Vec<GenImage>`(新引擎一次可能出多张);
//  - 下载必须限大小(32 MiB)、校验 PNG/JPEG 魔数、临时文件 + rename 原子落盘;
//  - URL 归一化统一走 `net::normalize_base_url`。

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// 单张图片的下载上限:超过即中止，防止错误页面/异常大响应写满磁盘。
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;

/// `ComfyUI` 轮询间隔与总 deadline。
const COMFY_POLL_INTERVAL: Duration = Duration::from_secs(1);
const COMFY_TIMEOUT: Duration = Duration::from_mins(10);

/// `ComfyUI` 内置 txt2img 工作流(API 格式)。允许用户粘贴导出的工作流覆盖。
const DEFAULT_COMFY_WORKFLOW: &str = r#"{
  "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "{{model}}" } },
  "5": { "class_type": "EmptyLatentImage", "inputs": { "width": {{width}}, "height": {{height}}, "batch_size": 1 } },
  "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "{{prompt}}", "clip": ["4", 1] } },
  "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "{{negative}}", "clip": ["4", 1] } },
  "3": { "class_type": "KSampler", "inputs": { "seed": {{seed}}, "steps": {{steps}}, "cfg": {{cfg}}, "sampler_name": "{{sampler}}", "scheduler": "normal", "denoise": 1.0, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0] } },
  "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
  "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "my-chat", "images": ["8", 0] } }
}"#;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawRequest {
    pub engine: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    #[serde(default)]
    pub size: String,
    #[serde(default)]
    pub steps: Option<u32>,
    #[serde(default)]
    pub cfg_scale: Option<f32>,
    #[serde(default)]
    pub seed: Option<i64>,
    #[serde(default)]
    pub sampler: Option<String>,
    #[serde(default)]
    pub workflow_json: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenImage {
    pub path: String,
    pub mime: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawServiceInfo {
    pub online: bool,
    pub models: Vec<String>,
    pub samplers: Vec<String>,
}

/// 生成图片并返回落盘后的多图列表。`engine` 为空/未知时按 openai 兼容处理。
#[tauri::command]
pub async fn generate_image(req: DrawRequest) -> Result<Vec<GenImage>, String> {
    match req.engine.trim() {
        "comfyui" => comfyui_generate(&req).await,
        "sdwebui" => sdwebui_generate(&req).await,
        _ => openai_generate(&req).await,
    }
}

// ── OpenAI 兼容(/images/generations) ─────────────────────

fn openai_request_body(req: &DrawRequest) -> Value {
    let mut body = json!({ "prompt": req.prompt, "n": 1 });
    if let Some(model) = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
    {
        body["model"] = json!(model);
    }
    let size = req.size.trim();
    if !size.is_empty() {
        body["size"] = json!(size);
    }
    body
}

async fn openai_generate(req: &DrawRequest) -> Result<Vec<GenImage>, String> {
    let url = crate::net::openai_images_url(&req.base_url);
    let client = crate::net::image_client();
    let body = openai_request_body(req);
    let request = crate::net::with_bearer(
        client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body),
        req.api_key.as_deref().unwrap_or(""),
    );
    let resp = request.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "图片接口错误 {}: {}",
            status.as_u16(),
            crate::net::truncate_for_error(&text)
        ));
    }
    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))?;
    // OpenAI 返回 data[n].url 或 data[n].b64_json
    let items = json["data"]
        .as_array()
        .ok_or_else(|| "响应缺少 data 数组".to_string())?;
    if items.is_empty() {
        return Err("图片接口未返回图片".to_string());
    }
    let mut out = Vec::new();
    for item in items {
        if let Some(remote) = item["url"].as_str().filter(|u| !u.trim().is_empty()) {
            let bytes = download_image(&client, remote).await?;
            out.push(save_image(&bytes)?);
        } else if let Some(b64) = item["b64_json"].as_str() {
            let bytes = decode_b64_image(b64)?;
            out.push(save_image(&bytes)?);
        }
    }
    if out.is_empty() {
        return Err("响应既无 url 也无 b64_json".to_string());
    }
    Ok(out)
}

// ── ComfyUI(/prompt → /history 轮询 → /view) ─────────────

fn random_seed() -> i64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    (nanos & u128::from(i64::MAX as u64)) as i64
}

fn parse_dim(raw: Option<&str>) -> u32 {
    raw.and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|v| (64..=4096).contains(v))
        .unwrap_or(1024)
}

/// 解析 `1024x1024`；非法/缺省回落到 1024×1024。
#[must_use]
fn parse_size(size: &str) -> (u32, u32) {
    let lower = size.trim().to_ascii_lowercase();
    let mut parts = lower.split('x');
    (parse_dim(parts.next()), parse_dim(parts.next()))
}

/// 把文本转义成可嵌入 JSON 字符串字面量的内容（不含两端引号）。
fn json_escape(value: &str) -> String {
    let quoted = Value::String(value.to_string()).to_string();
    quoted
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value)
        .to_string()
}

/// 替换工作流占位符。文本值做 JSON 转义，避免 prompt 里的引号/换行破坏 JSON。
#[must_use]
fn render_workflow(template: &str, req: &DrawRequest) -> String {
    let (width, height) = parse_size(&req.size);
    let seed = req.seed.unwrap_or_else(random_seed);
    let steps = req.steps.unwrap_or(20);
    let cfg = req.cfg_scale.unwrap_or(7.0);
    let model = req.model.as_deref().unwrap_or("").trim();
    let sampler = req
        .sampler
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("euler");
    let negative = req.negative_prompt.as_deref().unwrap_or("");
    let replacements: [(&str, String); 9] = [
        ("{{prompt}}", json_escape(&req.prompt)),
        ("{{negative}}", json_escape(negative)),
        ("{{model}}", json_escape(model)),
        ("{{sampler}}", json_escape(sampler)),
        ("{{seed}}", seed.to_string()),
        ("{{steps}}", steps.to_string()),
        ("{{width}}", width.to_string()),
        ("{{height}}", height.to_string()),
        ("{{cfg}}", cfg.to_string()),
    ];
    // 单遍扫描替换：插入的 prompt 里即使含有 `{{seed}}` 之类文本也不会被二次替换。
    let mut rendered = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        rendered.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(end) = after.find("}}") else {
            rendered.push_str(after);
            return rendered;
        };
        let token = &after[..end + 2];
        if let Some((_, value)) = replacements
            .iter()
            .find(|(placeholder, _)| *placeholder == token)
        {
            rendered.push_str(value);
        } else {
            rendered.push_str(token);
        }
        rest = &after[end + 2..];
    }
    rendered.push_str(rest);
    rendered
}

fn comfy_workflow(req: &DrawRequest) -> Result<Value, String> {
    let custom = req
        .workflow_json
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if custom.is_none() && req.model.as_deref().map_or("", str::trim).is_empty() {
        return Err("ComfyUI 需要指定模型(checkpoint 名称)".to_string());
    }
    let rendered = render_workflow(custom.unwrap_or(DEFAULT_COMFY_WORKFLOW), req);
    serde_json::from_str(&rendered).map_err(|e| format!("工作流 JSON 解析失败: {e}"))
}

/// 通用 GET + JSON 解析(错误体截断 ≤300 字)。
async fn get_json(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let request = crate::net::with_bearer(client.get(url).timeout(timeout), api_key);
    let resp = request.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            crate::net::truncate_for_error(&body)
        ));
    }
    serde_json::from_str(&body).map_err(|e| {
        format!(
            "解析响应失败: {e}: {}",
            crate::net::truncate_for_error(&body)
        )
    })
}

async fn comfyui_generate(req: &DrawRequest) -> Result<Vec<GenImage>, String> {
    let base = crate::net::normalize_base_url(&req.base_url);
    if base.is_empty() {
        return Err("未配置 ComfyUI 服务地址(设置 → 绘图)".to_string());
    }
    let workflow = comfy_workflow(req)?;
    let client = crate::net::long_client();
    let api_key = req.api_key.as_deref().unwrap_or("");
    let payload = json!({ "prompt": workflow, "client_id": Uuid::new_v4().to_string() });
    let request = crate::net::with_bearer(
        client
            .post(format!("{base}/prompt"))
            .timeout(Duration::from_mins(1))
            .header("Content-Type", "application/json")
            .json(&payload),
        api_key,
    );
    let resp = request
        .send()
        .await
        .map_err(|e| format!("ComfyUI 提交失败: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "ComfyUI 提交失败 HTTP {}: {}",
            status.as_u16(),
            crate::net::truncate_for_error(&body)
        ));
    }
    let submitted: Value =
        serde_json::from_str(&body).map_err(|e| format!("解析 ComfyUI 响应失败: {e}"))?;
    if let Some(errors) = submitted.get("node_errors") {
        let has_errors = match errors {
            Value::Object(map) => !map.is_empty(),
            Value::Array(items) => !items.is_empty(),
            _ => false,
        };
        if has_errors {
            return Err(format!(
                "ComfyUI 工作流节点错误: {}",
                crate::net::truncate_for_error(&errors.to_string())
            ));
        }
    }
    let prompt_id = submitted["prompt_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            format!(
                "ComfyUI 响应缺少 prompt_id: {}",
                crate::net::truncate_for_error(&body)
            )
        })?
        .to_string();

    let deadline = Instant::now() + COMFY_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            return Err(format!(
                "ComfyUI 出图超时（{} 秒）",
                COMFY_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(COMFY_POLL_INTERVAL).await;
        let history = get_json(
            &client,
            &format!("{base}/history/{prompt_id}"),
            api_key,
            Duration::from_secs(30),
        )
        .await?;
        let Some(entry) = history.get(&prompt_id) else {
            continue;
        };
        if entry["status"]["status_str"].as_str() == Some("error") {
            return Err(format!(
                "ComfyUI 执行失败: {}",
                crate::net::truncate_for_error(&entry["status"].to_string())
            ));
        }
        let refs = comfy_image_refs(entry);
        if refs.is_empty() {
            return Err("ComfyUI 工作流完成但没有输出图片".to_string());
        }
        let image_client = crate::net::image_client();
        let mut out = Vec::new();
        for (filename, subfolder, kind) in refs {
            let bytes =
                comfy_download(&image_client, &base, api_key, &filename, &subfolder, &kind).await?;
            out.push(save_image(&bytes)?);
        }
        return Ok(out);
    }
}

/// 从 history entry 的 `outputs.<node>.images[]` 收集图片引用。
fn comfy_image_refs(entry: &Value) -> Vec<(String, String, String)> {
    let mut refs = Vec::new();
    let Some(outputs) = entry["outputs"].as_object() else {
        return refs;
    };
    for output in outputs.values() {
        let Some(images) = output["images"].as_array() else {
            continue;
        };
        for image in images {
            let Some(filename) = image["filename"].as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            refs.push((
                filename.to_string(),
                image["subfolder"].as_str().unwrap_or("").to_string(),
                image["type"].as_str().unwrap_or("output").to_string(),
            ));
        }
    }
    refs
}

async fn comfy_download(
    client: &reqwest::Client,
    base: &str,
    api_key: &str,
    filename: &str,
    subfolder: &str,
    kind: &str,
) -> Result<Vec<u8>, String> {
    let request = crate::net::with_bearer(
        client
            .get(format!("{base}/view"))
            .query(&[
                ("filename", filename),
                ("subfolder", subfolder),
                ("type", kind),
            ])
            .timeout(Duration::from_mins(2)),
        api_key,
    );
    let resp = request
        .send()
        .await
        .map_err(|e| format!("下载 ComfyUI 图片失败: {e}"))?;
    read_image_response(resp).await
}

// ── SD WebUI(A1111 / Forge /sdapi/v1/txt2img) ────────────

fn sdwebui_request_body(req: &DrawRequest) -> Value {
    let (width, height) = parse_size(&req.size);
    let sampler = req
        .sampler
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Euler a");
    json!({
        "prompt": req.prompt,
        "negative_prompt": req.negative_prompt.as_deref().unwrap_or(""),
        "width": width,
        "height": height,
        "steps": req.steps.unwrap_or(20),
        "cfg_scale": req.cfg_scale.unwrap_or(7.0),
        "sampler_name": sampler,
        "seed": req.seed.unwrap_or(-1),
        "n": 1
    })
}

async fn sdwebui_generate(req: &DrawRequest) -> Result<Vec<GenImage>, String> {
    let base = crate::net::normalize_base_url(&req.base_url);
    if base.is_empty() {
        return Err("未配置 SD WebUI 服务地址(设置 → 绘图)".to_string());
    }
    let client = crate::net::image_client();
    let request = crate::net::with_bearer(
        client
            .post(format!("{base}/sdapi/v1/txt2img"))
            .header("Content-Type", "application/json")
            .json(&sdwebui_request_body(req)),
        req.api_key.as_deref().unwrap_or(""),
    );
    let resp = request.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "SD WebUI 错误 {}: {}",
            status.as_u16(),
            crate::net::truncate_for_error(&text)
        ));
    }
    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))?;
    let images = json["images"]
        .as_array()
        .ok_or_else(|| "SD WebUI 响应缺少 images 数组".to_string())?;
    if images.is_empty() {
        return Err("SD WebUI 未返回图片".to_string());
    }
    let mut out = Vec::new();
    for image in images {
        let raw = image
            .as_str()
            .ok_or_else(|| "SD WebUI 图片条目不是字符串".to_string())?;
        let bytes = decode_b64_image(raw)?;
        out.push(save_image(&bytes)?);
    }
    Ok(out)
}

// ── 探测 ─────────────────────────────────────────────────

/// 探测出图服务：返回在线状态、模型列表、采样器列表。
///
/// 服务离线时返回 `Ok(DrawServiceInfo { online: false, .. })` 而不是 Err，
/// 让 UI 可以把「未启动」与「请求参数错误」区分开；地址为空才是配置错误。
#[tauri::command]
pub async fn probe_draw_service(
    engine: String,
    base_url: String,
    api_key: String,
) -> Result<DrawServiceInfo, String> {
    let base = crate::net::normalize_base_url(&base_url);
    if base.is_empty() {
        return Err("未配置绘图服务地址(设置 → 绘图)".to_string());
    }
    let client = crate::net::long_client();
    let info = match engine.trim() {
        "comfyui" => probe_comfyui(&client, &base, &api_key).await,
        "sdwebui" => probe_sdwebui(&client, &base, &api_key).await,
        _ => probe_openai(&client, &base, &api_key).await,
    };
    Ok(info)
}

fn strings_at(value: &Value, pointer: &str) -> Vec<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

async fn probe_comfyui(client: &reqwest::Client, base: &str, api_key: &str) -> DrawServiceInfo {
    let mut info = DrawServiceInfo::default();
    let timeout = Duration::from_secs(15);
    if let Ok(json) = get_json(
        client,
        &format!("{base}/object_info/CheckpointLoaderSimple"),
        api_key,
        timeout,
    )
    .await
    {
        info.online = true;
        info.models = strings_at(&json, "/CheckpointLoaderSimple/input/required/ckpt_name/0");
    }
    if let Ok(json) = get_json(
        client,
        &format!("{base}/object_info/KSampler"),
        api_key,
        timeout,
    )
    .await
    {
        info.online = true;
        info.samplers = strings_at(&json, "/KSampler/input/required/sampler_name/0");
    }
    info
}

async fn probe_sdwebui(client: &reqwest::Client, base: &str, api_key: &str) -> DrawServiceInfo {
    let mut info = DrawServiceInfo::default();
    let timeout = Duration::from_secs(15);
    if let Ok(json) = get_json(
        client,
        &format!("{base}/sdapi/v1/sd-models"),
        api_key,
        timeout,
    )
    .await
    {
        info.online = true;
        info.models = json
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        item["title"]
                            .as_str()
                            .or_else(|| item["model_name"].as_str())
                            .map(String::from)
                    })
                    .collect()
            })
            .unwrap_or_default();
    }
    if let Ok(json) = get_json(
        client,
        &format!("{base}/sdapi/v1/samplers"),
        api_key,
        timeout,
    )
    .await
    {
        info.online = true;
        info.samplers = json
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item["name"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
    }
    info
}

async fn probe_openai(client: &reqwest::Client, base: &str, api_key: &str) -> DrawServiceInfo {
    let mut info = DrawServiceInfo::default();
    if let Ok(json) = get_json(
        client,
        &crate::net::openai_api_url(base, "models"),
        api_key,
        Duration::from_secs(15),
    )
    .await
    {
        info.online = true;
        info.models = json["data"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item["id"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
    }
    info
}

// ── 下载 / 解码 / 落盘 ───────────────────────────────────

async fn download_image(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载图片失败: {e}"))?;
    // 客户端禁用了重定向(RS-07):3xx 会原样返回，不能把跳转页当成图片。
    if !resp.status().is_success() {
        return Err(format!(
            "下载图片失败: HTTP {}（客户端不跟随重定向）",
            resp.status().as_u16()
        ));
    }
    read_image_response(resp).await
}

/// 流式读取图片响应：状态码 + Content-Type 预检 + 大小上限；
/// 魔数校验在 `save_image` 落盘前完成。
async fn read_image_response(mut resp: reqwest::Response) -> Result<Vec<u8>, String> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "下载图片失败: HTTP {}: {}",
            status.as_u16(),
            crate::net::truncate_for_error(&body)
        ));
    }
    if let Some(content_type) = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    {
        let lowered = content_type.to_ascii_lowercase();
        if lowered.starts_with("text/") || lowered.contains("json") || lowered.contains("html") {
            return Err(format!("响应不是图片(Content-Type: {lowered})"));
        }
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_IMAGE_BYTES as u64 {
            return Err(too_large_message());
        }
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取图片失败: {e}"))?
    {
        append_with_cap(&mut out, &chunk, MAX_IMAGE_BYTES)?;
    }
    if out.is_empty() {
        return Err("下载到的图片为空".to_string());
    }
    Ok(out)
}

fn too_large_message() -> String {
    format!(
        "图片超过大小上限（{} MiB），已中止下载",
        MAX_IMAGE_BYTES / (1024 * 1024)
    )
}

/// 按上限累加一片数据；超限返回错误(测试直接覆盖这条路径)。
fn append_with_cap(buf: &mut Vec<u8>, chunk: &[u8], max: usize) -> Result<(), String> {
    let new_len = buf
        .len()
        .checked_add(chunk.len())
        .ok_or_else(|| "图片大小溢出".to_string())?;
    if new_len > max {
        return Err(too_large_message());
    }
    buf.extend_from_slice(chunk);
    Ok(())
}

fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.starts_with(&PNG_MAGIC) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => "gif",
    }
}

/// T-076：UUID 文件名 —— 同一毫秒并发出图也不会互相覆盖。
fn unique_image_name(mime: &str) -> String {
    format!("gen-{}.{}", Uuid::new_v4().simple(), extension_for(mime))
}

/// 校验魔数后以「临时文件 + rename」原子落盘，返回路径与 MIME。
fn save_image(bytes: &[u8]) -> Result<GenImage, String> {
    let mime = sniff_image_mime(bytes)
        .ok_or_else(|| "下载内容不是支持的图片格式(PNG/JPEG/WebP/GIF)".to_string())?;
    let dir = app_generated_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let name = unique_image_name(mime);
    let final_path = dir.join(&name);
    let tmp_path = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp_path, bytes).map_err(|e| format!("写入图片失败: {e}"))?;
    std::fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("写入图片失败: {e}")
    })?;
    Ok(GenImage {
        path: final_path.to_string_lossy().into_owned(),
        mime: mime.to_string(),
    })
}

/// 去掉 `data:image/png;base64,` 前缀(`SD WebUI` 部分分支会带)。
fn strip_data_url(raw: &str) -> &str {
    let trimmed = raw.trim();
    if let Some(idx) = trimmed.find(";base64,") {
        if trimmed[..idx].starts_with("data:") {
            return &trimmed[idx + ";base64,".len()..];
        }
    }
    trimmed
}

fn decode_b64_image(raw: &str) -> Result<Vec<u8>, String> {
    let payload = strip_data_url(raw);
    // 解码前按长度预判:base64 每 4 字符 ≈ 3 字节
    if payload.len() / 4 * 3 > MAX_IMAGE_BYTES {
        return Err(too_large_message());
    }
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("Base64 解码失败: {e}"))
}

fn app_generated_dir() -> PathBuf {
    let base = std::env::var("APPDATA").map_or_else(
        |_| {
            PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
                .join("AppData")
                .join("Roaming")
        },
        PathBuf::from,
    );
    base.join("com.my-chat").join("generated")
}

#[cfg(test)]
mod tests {
    use super::{
        append_with_cap, decode_b64_image, parse_size, render_workflow, sniff_image_mime,
        strip_data_url, unique_image_name, DrawRequest, DEFAULT_COMFY_WORKFLOW,
    };
    use base64::Engine;

    fn request() -> DrawRequest {
        DrawRequest {
            engine: "comfyui".to_string(),
            base_url: "http://127.0.0.1:8188".to_string(),
            api_key: None,
            model: Some("sd_xl_base_1.0.safetensors".to_string()),
            prompt: "a cat".to_string(),
            negative_prompt: Some("blurry".to_string()),
            size: "768x512".to_string(),
            steps: Some(28),
            cfg_scale: Some(6.5),
            seed: Some(42),
            sampler: Some("dpmpp_2m".to_string()),
            workflow_json: None,
        }
    }

    #[test]
    fn append_with_cap_aborts_oversized_stream() {
        let mut buf = Vec::new();
        append_with_cap(&mut buf, &[1, 2, 3], 8).expect("未超限应通过");
        append_with_cap(&mut buf, &[4, 5, 6, 7, 8], 8).expect("恰好 8 字节应通过");
        let err = append_with_cap(&mut buf, &[9], 8).expect_err("第 9 字节必须中止");
        assert!(
            err.contains("32") || err.contains("上限"),
            "错误需说明大小上限"
        );
        assert_eq!(buf.len(), 8, "超限片不能写进缓冲");
    }

    /// T-076 验收：并发同毫秒不覆盖（UUID 名互不相同），扩展名跟随真实格式。
    #[test]
    fn unique_image_name_never_collides_and_matches_mime() {
        fn extension(name: &str) -> String {
            std::path::Path::new(name)
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("")
                .to_string()
        }
        let first = unique_image_name("image/png");
        let second = unique_image_name("image/png");
        assert_ne!(first, second, "两次落盘名必须不同");
        assert!(first.starts_with("gen-"), "{first}");
        assert!(extension(&first).eq_ignore_ascii_case("png"), "{first}");
        assert!(extension(&unique_image_name("image/jpeg")).eq_ignore_ascii_case("jpg"));
        assert!(extension(&unique_image_name("image/webp")).eq_ignore_ascii_case("webp"));
        assert!(extension(&unique_image_name("image/gif")).eq_ignore_ascii_case("gif"));
    }

    #[test]
    fn sniff_image_mime_detects_png_jpeg_and_rejects_html() {
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00];
        assert_eq!(sniff_image_mime(&png), Some("image/png"));
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00];
        assert_eq!(sniff_image_mime(&jpeg), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(b"<html>oops</html>"), None);
        assert_eq!(sniff_image_mime(b""), None);
    }

    #[test]
    fn strip_data_url_removes_prefix_variants() {
        assert_eq!(
            strip_data_url("data:image/png;base64,iVBORw0KGgo="),
            "iVBORw0KGgo="
        );
        assert_eq!(strip_data_url(" iVBORw0KGgo= "), "iVBORw0KGgo=");
        assert_eq!(
            strip_data_url("data:text/plain,hello"),
            "data:text/plain,hello"
        );
    }

    #[test]
    fn decode_b64_image_roundtrips_png_header() {
        let bytes = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        let decoded = decode_b64_image(&format!("data:image/png;base64,{encoded}"))
            .expect("合法 base64 必须解码成功");
        assert_eq!(decoded, bytes);
        assert!(decode_b64_image("not base64!!").is_err());
    }

    #[test]
    fn parse_size_parses_and_falls_back() {
        assert_eq!(parse_size("1024x768"), (1024, 768));
        assert_eq!(parse_size("512X512"), (512, 512));
        assert_eq!(parse_size("garbage"), (1024, 1024));
        assert_eq!(parse_size("99999x10"), (1024, 1024));
    }

    #[test]
    fn render_workflow_escapes_prompt_and_stays_valid_json() {
        let mut req = request();
        req.prompt = "quote \" newline\n brace } {{seed}}".to_string();
        let rendered = render_workflow(DEFAULT_COMFY_WORKFLOW, &req);
        let parsed: serde_json::Value =
            serde_json::from_str(&rendered).expect("替换后必须仍是合法 JSON");
        assert_eq!(parsed["6"]["inputs"]["text"], req.prompt);
        assert_eq!(parsed["7"]["inputs"]["text"], "blurry");
        assert_eq!(parsed["5"]["inputs"]["width"], 768);
        assert_eq!(parsed["5"]["inputs"]["height"], 512);
        assert_eq!(parsed["3"]["inputs"]["seed"], 42);
        assert_eq!(parsed["3"]["inputs"]["steps"], 28);
        assert_eq!(parsed["3"]["inputs"]["sampler_name"], "dpmpp_2m");
        assert_eq!(
            parsed["4"]["inputs"]["ckpt_name"],
            "sd_xl_base_1.0.safetensors"
        );
    }

    #[test]
    fn draw_request_deserializes_camel_case() {
        let json = serde_json::json!({
            "engine": "sdwebui",
            "baseUrl": "http://127.0.0.1:7860",
            "apiKey": "",
            "model": null,
            "prompt": "cat",
            "negativePrompt": "dog",
            "size": "512x512",
            "steps": 20,
            "cfgScale": 7.0,
            "seed": -1,
            "sampler": "Euler a",
            "workflowJson": null
        });
        let req: DrawRequest = serde_json::from_value(json).expect("camelCase 契约必须可反序列化");
        assert_eq!(req.engine, "sdwebui");
        assert_eq!(req.base_url, "http://127.0.0.1:7860");
        assert_eq!(req.negative_prompt.as_deref(), Some("dog"));
        assert_eq!(req.cfg_scale, Some(7.0));
    }
}
