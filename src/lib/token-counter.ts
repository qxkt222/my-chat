// lib/token-counter.ts — Approximate token counter

// GPT tokenization is complex (tiktoken), so we use a simple heuristic:
// English: ~4 chars/token, Chinese: ~1.5 chars/token, code: ~3 chars/token

export function countTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(char)) {
      tokens += 0.6; // CJK character ≈ 0.6 tokens
    } else if (/\s/.test(char)) {
      tokens += 0.25; // Whitespace
    } else {
      tokens += 0.25; // ASCII character
    }
  }
  return Math.max(1, Math.round(tokens));
}

export function countConversationTokens(messages: { content: string }[]): number {
  return messages.reduce((sum, m) => sum + countTokens(m.content), 0);
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}
