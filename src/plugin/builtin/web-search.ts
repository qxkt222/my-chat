// plugin/builtin/web-search.ts — Web search plugin (本机 SearXNG)
//
// 弃用废弃的 DuckDuckGo Instant Answer API,改接本机 SearXNG 栈
// (本机 SearXNG 栈,默认端口 8888,走代理)。搜索失败时回退
// DuckDuckGo HTML 接口,尽量保证可用。

import type { ChatPlugin } from "../types";

const SEARXNG_URL = "http://localhost:8888/search";

interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
}

/** 从本机 SearXNG JSON API 拉取结果 */
async function searchViaSearxng(query: string): Promise<string | null> {
  const params = new URLSearchParams({ q: query, format: "json", language: "zh-CN", safesearch: "0" });
  const resp = await fetch(`${SEARXNG_URL}?${params.toString()}`, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { results?: SearxResult[] };
  const results = (data.results || []).slice(0, 6);
  if (results.length === 0) return null;
  return (
    `Web search results for: "${query}"\n\n` +
    results
      .map((r, i) => `${i + 1}. [${r.title || "Untitled"}](${r.url || "#"})\n${r.content || ""}`)
      .join("\n\n")
  );
}

/** 回退:DuckDuckGo HTML 接口(旧 JSON 接口已废弃) */
async function searchViaDuckDuckGo(query: string): Promise<string> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .slice(0, 6)
    .map((m) => ({ href: m[1], text: (m[2] || "").replace(/<[^>]+>/g, "").trim() }));
  const snips = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
    .slice(0, 6)
    .map((m) => (m[1] || "").replace(/<[^>]+>/g, "").trim());
  if (links.length === 0) return "No results found.";
  return (
    `Web search results for: "${query}"\n\n` +
    links
      .map((l, i) => `${i + 1}. [${l.text || "Untitled"}](${l.href})\n${snips[i] || ""}`)
      .join("\n\n")
  );
}

export const webSearchPlugin: ChatPlugin = {
  manifest: {
    id: "builtin-web-search",
    name: "Web Search",
    version: "1.1.0",
    description: "Search the web and inject results into conversation (SearXNG)",
    author: "Built-in",
  },
  hooks: {
    onCommand: async (cmd, args, _ctx) => {
      if (cmd !== "search") return null;
      if (!args) return "Usage: /search {query}";

      try {
        // 优先本机 SearXNG(需先启动 start-searxng.bat)
        const viaSearxng = await searchViaSearxng(args);
        if (viaSearxng) return viaSearxng;
        // 回退 DuckDuckGo HTML
        return await searchViaDuckDuckGo(args);
      } catch (e) {
        return `Search failed: ${e}`;
      }
    },
  },
  enabled: false,
};
