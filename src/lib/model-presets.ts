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

// Fetch models via API (OpenAI-compatible /v1/models endpoint)
export async function fetchModelsFromAPI(apiUrl: string, apiKey: string): Promise<string[]> {
  const base = apiUrl.replace(/\/+$/, "");
  const url = `${base}/v1/models`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as { data?: { id?: string }[] };
  return (data.data || [])
    .map((m) => m.id || "")
    .filter(Boolean)
    .sort();
}

// Cache: localStorage key
const CACHE_KEY = "fetched_models_cache";

export function getCachedModels(provider: string): string[] | null {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    const entry = cache[provider];
    if (entry && Date.now() - entry.ts < 86400000) return entry.models; // 24h cache
  } catch {}
  return null;
}

export function setCachedModels(provider: string, models: string[]) {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    cache[provider] = { models, ts: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {}
}
