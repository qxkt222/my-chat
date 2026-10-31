// lib/model-presets.ts — Sub-model presets + API fetch

export const SUB_MODELS: Record<string, string[]> = {
  "preset-openai": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo"],
  "preset-ollama": ["llama3.2", "llama3.1", "qwen2.5", "mistral", "gemma3", "deepseek-r1"],
  "preset-deepseek": ["deepseek-chat", "deepseek-coder", "deepseek-reasoner"],
  "preset-gemini": ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
  "preset-claude": [
    "claude-3-5-sonnet-20241022",
    "claude-3-opus-20240229",
    "claude-3-haiku-20240307",
  ],
  "preset-mistral": ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
  "preset-wenxin": ["ernie-4.0-turbo-8k", "ernie-3.5-8k"],
  "preset-tongyi": ["qwen-turbo", "qwen-plus", "qwen-max"],
  "preset-cohere": ["command-r-plus", "command-r", "command"],
  "preset-openrouter": ["openai/gpt-4o", "anthropic/claude-3.5-sonnet", "deepseek/deepseek-chat"],
  "preset-siliconflow": [
    "Qwen/Qwen2.5-7B-Instruct",
    "deepseek-ai/DeepSeek-V3",
    "Qwen/Qwen2.5-72B-Instruct",
  ],
  "preset-moonshot": ["kimi-k2-0711-preview", "moonshot-v1-8k", "moonshot-v1-32k"],
  "preset-zhipu": ["glm-4-plus", "glm-4-flash", "glm-4-air"],
  "preset-lingyi": ["yi-lightning", "yi-large"],
  "preset-minimax": ["MiniMax-Text-01", "abab6.5s-chat"],
  "preset-groq": ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
};

export function getSubModels(provider: string): string[] {
  return SUB_MODELS[provider] || [];
}

/**
 * 由 api_url 推导「模型列表」地址（OpenAI 兼容 /models）。
 *
 * T-113:旧实现无条件拼 `${base}/v1/models`,当用户填的 api_url 已经带 /v1
 * (如 `https://api.deepseek.com/v1`)会变成 `/v1/v1/models` → 404,
 * 填完整 chat 端点(`.../chat/completions`)同样 404。
 * 这里与 Rust `adapters::engine::build_api_url` 的三形态保持一致:
 *   · 完整 chat 端点 `…/chat/completions` → 同级 `…/models`
 *   · 已带版本段 `…/v1` / `…/v2`        → `…/v1/models`
 *   · 裸 base                           → `…/v1/models`
 * 另外 `…/models` 原样返回(幂等,便于直接填列表端点)。
 */
export function buildModelsUrl(apiUrl: string): string {
  const base = apiUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("api_url 为空,无法拉取模型列表");
  if (base.endsWith("/models")) return base;
  if (base.endsWith("/chat/completions")) {
    return `${base.slice(0, -"/chat/completions".length)}/models`;
  }
  if (base.endsWith("/v1") || base.endsWith("/v2")) return `${base}/models`;
  return `${base}/v1/models`;
}

// Fetch models via API (OpenAI-compatible /models endpoint)
export async function fetchModelsFromAPI(apiUrl: string, apiKey: string): Promise<string[]> {
  const url = buildModelsUrl(apiUrl);
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!resp.ok) {
    // 失败不再只抛一个裸状态码:带上实际请求的 URL 与响应体片段,
    // 调用方即便回退静态列表,日志/错误里也能看出是拼接错还是鉴权失败。
    const body = await resp.text().catch(() => "");
    const detail = body.trim().slice(0, 200);
    throw new Error(`HTTP ${resp.status} ${url}${detail ? ` — ${detail}` : ""}`);
  }
  const data = (await resp.json()) as { data?: { id?: string }[] };
  return (data.data || [])
    .map((m) => m.id || "")
    .filter(Boolean)
    .sort();
}

// Cache: localStorage key
const CACHE_KEY = "fetched_models_cache";

/** 缓存结构 —— 显式声明，避免 JSON.parse 的 any 一路传播（no-unsafe-member-access） */
interface FetchedModelsCache {
  [provider: string]: { models: string[]; ts: number } | undefined;
}

export function getCachedModels(provider: string): string[] | null {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") as FetchedModelsCache;
    const entry = cache[provider];
    if (entry && Date.now() - entry.ts < 86400000) return entry.models; // 24h cache
  } catch {
    // 有意静默：缓存不是功能。localStorage 被禁用（隐私模式）或缓存 JSON 坏了，
    // 降级成「没有缓存」即可，调用方会去远端重新拉一次。
  }
  return null;
}

export function setCachedModels(provider: string, models: string[]) {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") as FetchedModelsCache;
    cache[provider] = { models, ts: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 有意静默：写缓存失败（配额满 / 禁用）只影响下次是否复用，功能不受影响。
  }
}
