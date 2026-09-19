// plugin/commands.ts — Slash command registry (for the "/" hint bar)
// Kept in sync with the onCommand handlers in src/plugin/builtin/*.

export interface SlashCommandInfo {
  cmd: string;
  plugin: string;
  usage: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandInfo[] = [
  {
    cmd: "translate",
    plugin: "Translator",
    usage: "/translate",
    description: "翻译最后一条消息（中英互译）",
  },
  {
    cmd: "search",
    plugin: "Web Search",
    usage: "/search {query}",
    description: "DuckDuckGo 网页搜索",
  },
  {
    cmd: "prompts",
    plugin: "Prompt Templates",
    usage: "/prompts",
    description: "列出常用提示词模板",
  },
  {
    cmd: "prompt",
    plugin: "Prompt Templates",
    usage: "/prompt {n}",
    description: "插入第 n 个提示词模板",
  },
  {
    cmd: "summarize",
    plugin: "Conversation Summary",
    usage: "/summarize",
    description: "总结当前对话",
  },
  { cmd: "image", plugin: "Image Generation", usage: "/image {prompt}", description: "生成图片" },
  { cmd: "speak", plugin: "Text to Speech", usage: "/speak", description: "朗读最后一条 AI 回复" },
  { cmd: "voice", plugin: "Voice Input", usage: "/voice", description: "语音转文字输入" },
];
