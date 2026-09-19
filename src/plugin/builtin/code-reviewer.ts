// plugin/builtin/code-reviewer.ts — Built-in code review plugin

import type { ChatPlugin } from "../types";

export const codeReviewerPlugin: ChatPlugin = {
  manifest: {
    id: "builtin-code-reviewer",
    name: "Code Reviewer",
    version: "1.0.0",
    description: "Review and suggest improvements for code snippets",
    author: "Built-in",
  },
  hooks: {
    beforeSend: (content) => {
      // Detect if message contains code (triple backticks or common patterns)
      if (
        content.includes("```") ||
        content.includes("function ") ||
        content.includes("class ") ||
        content.includes("import ") ||
        content.includes("const ") ||
        content.includes("let ")
      ) {
        return `${content}\n\n[Please review the code above for issues, improvements, and best practices.]`;
      }
      return content;
    },
  },
  enabled: false,
};
