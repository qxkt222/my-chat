import type { ApiTemplate, Message } from "@/types";

// ── Template variable rendering ──────────────────────────
export function renderRequestBody(
  template: ApiTemplate,
  variables: {
    model: string;
    messages: Pick<Message, "role" | "content">[];
    temperature: number;
    api_key?: string;
    system_prompt?: string;
    knowledge_context?: string;
  }
): string {
  let body = template.request_body_template;

  // Build messages JSON
  const msgsJson = JSON.stringify(
    variables.messages.map((m) => ({ role: m.role, content: m.content }))
  );

  // Simple variable substitution
  const subs: Record<string, string> = {
    "{{model}}": JSON.stringify(variables.model),
    "{{messages}}": msgsJson,
    "{{temperature}}": String(variables.temperature),
    "{{api_key}}": JSON.stringify(variables.api_key || ""),
    "{{system_prompt}}": JSON.stringify(variables.system_prompt || ""),
    "{{knowledge_context}}": JSON.stringify(variables.knowledge_context || ""),
  };

  for (const [key, val] of Object.entries(subs)) {
    body = body.replace(new RegExp(key.replace(/[{}]/g, "\\$&"), "g"), val);
  }

  return body;
}

// ── Header rendering ─────────────────────────────────────
export function renderHeaders(
  template: ApiTemplate,
  variables: { api_key?: string }
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(template.request_headers)) {
    headers[key] = value.replace("{{api_key}}", variables.api_key || "");
  }
  return headers;
}

// ── SSE chunk parsing ────────────────────────────────────
export function parseSseChunk(
  template: ApiTemplate,
  line: string
): { content: string; done: boolean } | null {
  // Check done marker
  if (template.sse_done_marker && line.includes(template.sse_done_marker)) {
    return { content: "", done: true };
  }

  // Strip prefix
  let data = line;
  if (template.sse_data_prefix && line.startsWith(template.sse_data_prefix)) {
    data = line.slice(template.sse_data_prefix.length);
  }

  // Skip empty or comment lines
  if (!data || data.startsWith(":")) return null;

  // Try JSON parse
  try {
    const json = JSON.parse(data);
    const content = extractJsonPath(json, template.sse_content_path) || "";
    return { content: String(content), done: false };
  } catch {
    return null;
  }
}

// ── Simple JSONPath extraction ───────────────────────────
function extractJsonPath(obj: unknown, path: string): unknown {
  if (!path || path === "$") return obj;

  // Remove leading $.
  const clean = path.replace(/^\$\.?/, "");
  const parts = clean.split(".");

  let current: unknown = obj;
  for (const part of parts) {
    // Handle array indices like [0]
    const arrMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) {
      const key = arrMatch[1] ?? "";
      const idx = parseInt(arrMatch[2] ?? "0", 10);
      current = (current as Record<string, unknown>)?.[key];
      current = (current as unknown[] | undefined)?.[idx];
    } else {
      current = (current as Record<string, unknown>)?.[part];
    }
    if (current === undefined || current === null) return null;
  }

  return current;
}

// ── Build full API URL ──────────────────────────────────
export function buildApiUrl(template: ApiTemplate): string {
  const base = template.api_url.replace(/\/+$/, "");
  // OpenAI-compatible endpoints append /v1/chat/completions for simple mode
  if (template.mode === "simple") {
    return `${base}/v1/chat/completions`;
  }
  return base;
}
