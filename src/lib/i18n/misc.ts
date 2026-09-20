// lib/i18n/misc.ts — 由 i18n.ts 按 key 前缀拆出（自动生成，勿手工搬运 key）
// 条目数：75

export const miscMessages: Record<string, Record<string, string>> = {
  "tool.initialize": { zh: "初始化工具…", en: "Initializing tools…" },
  "tool.calling": { zh: "调用工具", en: "Calling tool" },
  "tool.reading": { zh: "读取结果…", en: "Reading results…" },
  // ── Theme ──
  "theme.light": { zh: "浅色", en: "Light" },
  "theme.dark": { zh: "深色", en: "Dark" },
  "theme.system": { zh: "跟随系统", en: "System" },
  // ── Status bar ──
  "status.ready": { zh: "就绪", en: "Ready" },
  "status.generating": { zh: "生成中…", en: "Generating…" },
  "status.viewChat": { zh: "对话", en: "Chat" },
  "status.viewTranslate": { zh: "翻译工作区", en: "Translation" },
  "status.viewDraw": { zh: "绘图工作区", en: "Drawing" },
  "status.model": { zh: "模型：", en: "Model: " },
  "status.paletteHint": { zh: "⚡ Ctrl+K 命令面板", en: "⚡ Ctrl+K command palette" },
  // ── Skills ──
  "skills.title": { zh: "技能管理", en: "Skills" },
  "skills.new": { zh: "新建技能", en: "New Skill" },
  "skills.search": { zh: "搜索技能...", en: "Search skills..." },
  "skills.name": { zh: "名称", en: "Name" },
  "skills.desc": { zh: "描述", en: "Description" },
  "skills.prompt": { zh: "系统提示词", en: "System Prompt" },
  "skills.edit": { zh: "编辑技能", en: "Edit Skill" },
  "skills.bindModel": {
    zh: "绑定模型（可空 = 使用当前模型）",
    en: "Bind model (empty = current model)",
  },
  "skills.bindTools": {
    zh: "绑定 MCP 工具（Agent 能力）",
    en: "Bind MCP tools (Agent capability)",
  },
  "skills.noMcp": {
    zh: "无 MCP 服务器（可到设置 → MCP 添加）",
    en: "No MCP servers (add one in Settings → MCP)",
  },
  "skills.bindMemory": {
    zh: "绑定记忆标签（发送时注入长期记忆）",
    en: "Bind memory tags (injected on send)",
  },
  "skills.noMemory": {
    zh: "尚无记忆（到设置 → 记忆添加）",
    en: "No memories yet (add one in Settings → Memory)",
  },
  "skills.toolsCount": { zh: "{n} 工具", en: "{n} tools" },
  // ── Model wizard ──
  "wizard.title1": { zh: "选择 AI 服务商", en: "Choose AI Provider" },
  "wizard.title2": { zh: "填写 API Key", en: "Enter API Key" },
  "wizard.title3": { zh: "自定义服务商", en: "Custom Provider" },
  "wizard.stepOf": { zh: "{n}/3", en: "{n}/3" },
  "wizard.custom": { zh: "自定义服务商", en: "Custom Provider" },
  "wizard.customDesc": {
    zh: "填写任意 OpenAI 兼容 API 地址（支持中转站、代理、本地服务）",
    en: "Any OpenAI-compatible API URL (relays, proxies, local servers)",
  },
  "wizard.name": { zh: "自定义名称", en: "Custom Name" },
  "wizard.apiKey": { zh: "API Key *", en: "API Key *" },
  "wizard.modelName": { zh: "模型名（可选）", en: "Model (optional)" },
  "wizard.saveUse": { zh: "保存并使用此模型", en: "Save & Use This Model" },
  "wizard.multiKey": {
    zh: "提示：多个 API Key 用英文逗号分隔，自动轮询（如 key1,key2）",
    en: "Tip: comma-separated API keys rotate automatically (e.g. key1,key2)",
  },
  "wizard.urlHint": {
    zh: "OpenAI 兼容 API。地址支持三种填法：",
    en: "OpenAI-compatible API. Three URL formats supported:",
  },
  "wizard.urlHint1": {
    zh: "根地址 {code} → 自动补 {code}/v1/chat/completions",
    en: "Base {code} → auto-append {code}/v1/chat/completions",
  },
  "wizard.urlHint2": {
    zh: "版本地址 {code} 或 {code} → 自动补 {code}/chat/completions",
    en: "Versioned {code} or {code} → auto-append {code}/chat/completions",
  },
  "wizard.urlHint3": { zh: "完整地址 {code} → 直接使用", en: "Full {code} → used as-is" },
  "wizard.customName": { zh: "自定义名称 *", en: "Custom Name *" },
  "wizard.apiUrl": { zh: "API 地址 *", en: "API URL *" },
  "wizard.apiKeyOptional": {
    zh: "API Key（可留空，适用于本地/免费服务）",
    en: "API Key (optional for local/free services)",
  },
  "wizard.modelId": { zh: "模型名", en: "Model ID" },
  "wizard.saveUseCustom": { zh: "保存并使用", en: "Save & Use" },
  // ── Workspaces ──
  "trans.title": { zh: "翻译工作区", en: "Translation Workspace" },
  "trans.usingModel": {
    zh: "使用 {name}（翻译独立流，不写入对话）",
    en: "Using {name} (independent stream, not saved to chat)",
  },
  "trans.srcPlaceholder": { zh: "输入要翻译的文本…", en: "Enter text to translate…" },
  "trans.outPlaceholder": { zh: "译文将显示在这里…", en: "Translation will appear here…" },
  "trans.button": { zh: "翻译", en: "Translate" },
  "trans.busy": { zh: "翻译中…", en: "Translating…" },
  "trans.fail": { zh: "⚠️ 翻译失败：", en: "⚠️ Translation failed: " },
  "draw.title": { zh: "绘图工作区", en: "Drawing Workspace" },
  "draw.using": {
    zh: "使用 {name} 的图片生成端点",
    en: "Using {name}'s image generation endpoint",
  },
  "draw.promptPlaceholder": { zh: "描述要生成的图片…", en: "Describe the image to generate…" },
  "draw.resultPlaceholder": {
    zh: "生成结果将显示在这里",
    en: "The generated image will appear here",
  },
  "draw.button": { zh: "生成图片", en: "Generate" },
  "draw.busy": { zh: "生成中…", en: "Generating…" },
  "draw.noImage": {
    zh: "生成接口未返回图片（检查模型是否支持图片生成）",
    en: "No image returned (does the model support image generation?)",
  },
  // ── 双模式(工作 / 酒馆)──
  "appMode.work": { zh: "工作", en: "Work" },
  "appMode.tavern": { zh: "酒馆", en: "Tavern" },
  "appMode.workHint": {
    zh: "工作模式:干活/普通聊天(角色扮演完全隔离)",
    en: "Work mode: work & normal chat (roleplay fully separated)",
  },
  "appMode.tavernHint": {
    zh: "酒馆模式:独立创作空间(会话与工作模式互不干扰)",
    en: "Tavern mode: creative space (chats isolated from work mode)",
  },
  // 酒馆子模式:角色扮演 / 推演
  "appMode.tavernSub.rp": { zh: "角色扮演", en: "Roleplay" },
  "appMode.tavernSub.simulate": { zh: "推演", en: "Simulate" },
  "qr.name": { zh: "名称", en: "Name" },
  "qr.template": { zh: "模板(支持 {{char}}/[roll]/[ask])", en: "Template ({{char}}/[roll]/[ask])" },
  "qr.add": { zh: "添加快捷按钮", en: "Add quick button" },
  "graph.title": { zh: "记忆图谱", en: "Memory Graph" },
  "graph.empty": {
    zh: "暂无关系图数据(对话中提及名字/关系句后自动生成)",
    en: "No graph yet (appears as names/relations are mentioned)",
  },
  // ── Plugins ──
  "plugins.title": { zh: "插件管理", en: "Plugins" },
  "plugins.active": { zh: "已启用", en: "Active" },
  "plugins.inactive": { zh: "未启用", en: "Inactive" },
  "plugins.empty": { zh: "暂无插件", en: "No plugins installed" },
};
