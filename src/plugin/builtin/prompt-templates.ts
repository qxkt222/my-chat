// plugin/builtin/prompt-templates.ts — Prompt template library

import type { ChatPlugin } from "../types";

const TEMPLATES = [
  { name: "Explain Code", icon: "💻", prompt: "Explain the following code in detail:\n\n" },
  {
    name: "Fix Bug",
    icon: "🐛",
    prompt: "Find and fix the bug in this code. Provide corrected version:\n\n",
  },
  { name: "Translate EN→ZH", icon: "🌐", prompt: "Translate to Simplified Chinese:\n\n" },
  { name: "Translate ZH→EN", icon: "🌍", prompt: "Translate to English:\n\n" },
  { name: "Summarize", icon: "📝", prompt: "Summarize in 3-5 bullet points:\n\n" },
  { name: "Rewrite", icon: "✍️", prompt: "Rewrite to be more professional:\n\n" },
  {
    name: "Explain Concept",
    icon: "📚",
    prompt: "Explain this concept simply, as if teaching a beginner:\n\n",
  },
  { name: "Generate Tests", icon: "🧪", prompt: "Write comprehensive unit tests for:\n\n" },
  {
    name: "Refactor",
    icon: "🔧",
    prompt: "Refactor this code for readability and performance:\n\n",
  },
  { name: "Brainstorm", icon: "💡", prompt: "Brainstorm creative ideas for:\n\n" },
  {
    name: "Role: Expert",
    icon: "🎓",
    prompt: "You are an expert. Answer with deep knowledge:\n\n",
  },
  { name: "Step by Step", icon: "🪜", prompt: "Break down the solution step by step:\n\n" },
];

export const promptTemplatesPlugin: ChatPlugin = {
  manifest: {
    id: "builtin-prompt-templates",
    name: "Prompt Templates",
    version: "1.0.0",
    description: "Quick-insert common prompts for coding, writing, and translation",
    author: "Built-in",
  },
  hooks: {
    onCommand: async (cmd, args) => {
      if (cmd === "prompts")
        return TEMPLATES.map((t, i) => `${i + 1}. ${t.icon} ${t.name}`).join("\n");
      if (cmd === "prompt") {
        const i = parseInt(args) - 1;
        return TEMPLATES[i] ? TEMPLATES[i].prompt : "Invalid number. Use /prompts";
      }
      return null;
    },
  },
  enabled: false,
};

export { TEMPLATES };
