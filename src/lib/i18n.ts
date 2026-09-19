// lib/i18n.ts — Internationalization (zh/en)
// NOTE: plugin built-in command outputs and model system prompts are "content"
// rather than UI copy — they intentionally stay in their authored language.

import { useCallback } from "react";
import { useAppConfigStore } from "@/stores/useAppConfigStore";

const translations: Record<string, Record<string, string>> = {
  // ── Header ──
  "app.title": { zh: "我的 AI 助手", en: "My AI Chat" },
  "no.model": { zh: "未选择模型", en: "No Model" },
  "header.chat": { zh: "对话", en: "Chat" },
  "header.translate": { zh: "翻译", en: "Translate" },
  "header.draw": { zh: "绘图", en: "Draw" },
  "header.fetchModels": { zh: "从 API 获取最新模型", en: "Fetch latest models from API" },
  "header.providerHint": { zh: "切换服务商（Alt+↑/↓）", en: "Switch provider (Alt+↑/↓)" },
  "header.subModelHint": { zh: "切换子模型（Alt+←/→）", en: "Switch sub-model (Alt+←/→)" },

  // ── Sidebar ──
  "sidebar.search": { zh: "搜索对话...", en: "Search chats..." },
  "sidebar.new": { zh: "新建对话", en: "New Chat" },
  "sidebar.collapse": { zh: "收起侧栏", en: "Collapse" },
  "sidebar.noResults": { zh: "无对话", en: "No chats yet" },
  "sidebar.noSearchResults": { zh: "无匹配的对话", en: "No matching chats" },
  "sidebar.expand": { zh: "展开侧栏", en: "Expand" },
  "sidebar.confirmDelete": {
    zh: "确定删除对话「{title}」？此操作不可撤销。",
    en: 'Delete conversation "{title}"? This cannot be undone.',
  },
  "sidebar.chats": { zh: "会话", en: "Chats" },
  "sidebar.bookmarks": { zh: "书签", en: "Bookmarks" },
  "sidebar.noBookmarks": {
    zh: "悬停消息点 🔖 标记书签,这里一键跳回",
    en: "Hover a message and tap the bookmark icon to pin it here",
  },
  "sidebar.manage": { zh: "批量管理（多选）", en: "Batch select" },
  "sidebar.archive": { zh: "归档", en: "Archive" },
  "sidebar.archived": { zh: "已归档", en: "Archived" },
  "sidebar.unarchive": { zh: "取消归档", en: "Unarchive" },
  "sidebar.selected": { zh: "已选 {n} 项", en: "{n} selected" },
  "sidebar.selectHint": { zh: "点会话多选", en: "Click chats to select" },
  "sidebar.deleteMany": { zh: "批量删除", en: "Delete selected" },
  "sidebar.confirmBatchDelete": {
    zh: "确定删除选中的 {n} 个对话？此操作不可撤销。",
    en: "Delete {n} conversations? This cannot be undone.",
  },
  "sidebar.tasks": { zh: "任务", en: "Tasks" },
  "task.running": { zh: "运行中", en: "Running" },
  "task.done": { zh: "完成", en: "Done" },
  "task.error": { zh: "失败", en: "Error" },
  "task.queued": { zh: "排队", en: "Queued" },
  "task.empty": { zh: "暂无后台任务", en: "No background tasks" },
  "task.clearDone": { zh: "清除已完成", en: "Clear finished" },
  "sidebar.characters": { zh: "角色", en: "Characters" },
  "sidebar.startCharacter": {
    zh: "开始与 {name} 的角色扮演对话",
    en: "Start a roleplay chat with {name}",
  },

  // ── Chat ──
  "chat.welcome": { zh: "欢迎使用 AI 助手", en: "Welcome to AI Chat" },
  "chat.startHint": {
    zh: "新建对话或从左侧选择已有对话开始",
    en: "Start a new conversation or select one from the sidebar",
  },
  "chat.placeholder": {
    zh: "输入消息... Enter 发送, Shift+Enter 换行",
    en: "Message... Enter to send, Shift+Enter for new line",
  },
  "chat.noModel": { zh: "请先在设置中配置模型", en: "Configure a model in settings first" },
  "chat.stop": { zh: "停止", en: "Stop" },
  "chat.regenerate": { zh: "重新生成", en: "Regenerate" },
  "chat.send": { zh: "发送", en: "Send" },
  "chat.export": { zh: "导出", en: "Export" },
  "chat.search": { zh: "搜索", en: "Search" },
  "chat.searchMsg": { zh: "搜索消息...", en: "Search messages..." },
  "chat.tokens": { zh: "tokens", en: "tokens" },
  "chat.ragOn": { zh: "知识库检索已开启", en: "RAG Search On" },
  "chat.ragOff": { zh: "知识库检索已关闭", en: "RAG Search Off" },
  "chat.ragNoKB": { zh: "请先选择知识库", en: "Select a knowledge base first" },
  "chat.copy": { zh: "复制", en: "Copy" },
  "chat.quote": { zh: "引用此消息", en: "Quote this message" },
  "chat.fork": { zh: "从此处分叉新对话", en: "Fork conversation here" },
  "chat.forkSuccess": {
    zh: "已从该消息分叉为新对话（{n} 条消息）",
    en: "Forked into a new conversation ({n} messages)",
  },
  "chat.thinkingProcess": { zh: "思考过程", en: "Thinking" },
  "chat.thinkingChars": { zh: "{n} 字", en: "{n} chars" },
  "chat.requestFailed": { zh: "⚠️ 请求失败", en: "⚠️ Request failed" },
  "chat.you": { zh: "You", en: "You" },
  "chat.ai": { zh: "AI", en: "AI" },
  "chat.compare": { zh: "对比：", en: "Compare:" },
  "chat.compareTitle": { zh: "一问多答 - 多模型对比", en: "Multi-model comparison" },
  "chat.primary": { zh: "（主）", en: " (main)" },
  "chat.compareCount": {
    zh: "发送后 {n} 个模型同时回答",
    en: "{n} models will answer in parallel",
  },
  "chat.skillsLabel": { zh: "技能：", en: "Skills:" },
  "chat.commands": { zh: "命令：", en: "Commands:" },
  "chat.skillPreview": { zh: "技能：{name}", en: "Skill: {name}" },
  "chat.skillNoDesc": { zh: "（无描述）", en: "(no description)" },
  "chat.skillPick": {
    zh: "技能 - 选择技能注入系统提示词",
    en: "Skill - inject a system prompt on send",
  },
  "chat.quoteUser": { zh: "用户", en: "User" },
  "chat.quoteAI": { zh: "AI", en: "AI" },
  "chat.quoteBy": { zh: "引用 @{who}", en: "Quote @{who}" },
  "chat.compress": {
    zh: "压缩上下文（Chatbox）：总结历史并保留摘要，节省 Token",
    en: "Compress context: summarize history and keep a summary",
  },
  "chat.compressing": { zh: "正在压缩上下文…", en: "Compressing context…" },
  "chat.compressFailed": {
    zh: "压缩失败，请检查模型配置",
    en: "Compression failed, check model config",
  },
  "chat.compressSuccess": {
    zh: "上下文已压缩（保留摘要）",
    en: "Context compressed (summary kept)",
  },
  "chat.clearConversation": { zh: "清空会话", en: "Clear chat" },
  "chat.clearConfirm": {
    zh: "确定清空当前对话？所有消息将被删除，此操作不可撤销。",
    en: "Clear the current conversation? All messages will be deleted. This cannot be undone.",
  },
  "chat.clearDone": { zh: "已清空当前对话", en: "Conversation cleared" },
  "chat.rpAs": { zh: "扮演 {name}", en: "Playing as {name}" },
  "chat.translate": { zh: "翻译", en: "Translate" },
  "chat.translation": { zh: "译文", en: "Translation" },
  "chat.swipePrev": { zh: "上一个版本", en: "Previous version" },
  "chat.swipeNext": {
    zh: "下一个版本（到底生成新回复）",
    en: "Next version (or regenerate at end)",
  },
  "chat.cacheHit": {
    zh: "缓存命中 {pct}%（{hit}/{total} tokens）",
    en: "Cache hit {pct}% ({hit}/{total} tokens)",
  },
  "chat.requestFailedToast": { zh: "「{name}」请求失败", en: '"{name}" request failed' },
  "chat.unknownError": {
    zh: "未知错误（详见 AppData\\Roaming\\com.my-chat\\chat_errors.log）",
    en: "Unknown error (see AppData\\Roaming\\com.my-chat\\chat_errors.log)",
  },
  "chat.bookmark": { zh: "书签（关键消息）", en: "Bookmark this message" },
  "chat.edit": { zh: "编辑消息", en: "Edit message" },
  "chat.continue": { zh: "继续生成", en: "Continue" },
  "chat.impersonate": { zh: "以角色身份发言", en: "Impersonate" },
  "chat.retry": { zh: "重试", en: "Retry" },
  "chat.compareConsensus": { zh: "各模型一致", en: "Consensus" },
  "chat.compareConflict": {
    zh: "各模型有分歧,建议核验",
    en: "Models disagree — verify",
  },
  "chat.jumpToBottom": { zh: "回到底部", en: "Jump to bottom" },
  "chat.archiveNote": { zh: "归档为笔记", en: "Archive as note" },
  "chat.archiveNeedKb": {
    zh: "请先选择/创建一个知识库",
    en: "Pick or create a knowledge base first",
  },
  "chat.archived": { zh: "已归档到知识库「{kb}」", en: 'Archived to KB "{kb}"' },
  "mention.knowledgeDesc": { zh: "知识库（开启 RAG）", en: "Knowledge base (enable RAG)" },
  "mention.convDesc": { zh: "引用旧会话（自动压缩）", en: "Reference chat (auto-compressed)" },
  "chat.insertCode": { zh: "插入到输入框", en: "Insert into input" },
  "chat.chainTitle": { zh: "选择工作流（多步串联）", en: "Pick a workflow (multi-step)" },
  "tool.initialize": { zh: "初始化工具…", en: "Initializing tools…" },
  "tool.calling": { zh: "调用工具", en: "Calling tool" },
  "tool.reading": { zh: "读取结果…", en: "Reading results…" },
  "chat.sources": { zh: "来源:", en: "Sources:" },
  "chat.ragMode": { zh: "检索模式:", en: "Search mode:" },
  "chat.ragModeHybrid": { zh: "混合", en: "Hybrid" },
  "chat.ragRerank": { zh: "重排(rerank)", en: "Rerank" },
  "chat.ragRerankHint": {
    zh: "用当前模型对候选片段重排(费 token,结果更准)",
    en: "Re-rank candidates with the current model (costs tokens)",
  },
  "chat.wrapper": { zh: "模型包装器预设", en: "Model wrapper" },
  "chat.wrapperTitle": {
    zh: "选择预设(模型+知识库+指令)",
    en: "Pick a preset (model+KB+instructions)",
  },
  "chat.wrapperEmpty": {
    zh: "暂无预设,在 设置 → 模型 里创建",
    en: "No presets yet — create one in Settings → Models",
  },
  "chat.mcpUsage": {
    zh: "用法：/mcp <服务器> <工具> [参数JSON] :: <工具2> [参数JSON] ...（`{prev}` 引用上一步输出）",
    en: "Usage: /mcp <server> <tool> [argsJson] :: <tool2> [argsJson] ... (`{prev}` references the previous output)",
  },
  "chat.mcpNotFound": {
    zh: "未找到 MCP 服务器「{s}」，可用：{list}",
    en: 'MCP server "{s}" not found. Available: {list}',
  },
  "chat.mcpNoTools": {
    zh: "服务器「{s}」没有工具「{t}」，可用：{list}",
    en: 'Server "{s}" has no tool "{t}". Available: {list}',
  },
  "chat.mcpCallFailed": { zh: "MCP 调用失败：", en: "MCP call failed: " },
  "chat.mcpEmptyResult": { zh: "(空结果)", en: "(empty result)" },
  "chat.mcpNone": { zh: "无", en: "none" },
  "chat.unknownCmd": {
    zh: "未知命令 /{cmd}，可用：{list}",
    en: "Unknown command /{cmd}. Available: {list}",
  },

  // ── Settings ──
  "settings.title": { zh: "设置", en: "Settings" },
  "settings.tavernTitle": { zh: "酒馆设置", en: "Tavern Settings" },
  "settings.simTitle": { zh: "推演设置", en: "Simulation Settings" },
  "settings.simulate": { zh: "推演", en: "Simulation" },
  "settings.budget": { zh: "预算", en: "Budget" },
  "settings.models": { zh: "模型", en: "Models" },
  "settings.general": { zh: "通用", en: "General" },
  "settings.plugins": { zh: "插件", en: "Plugins" },
  "settings.data": { zh: "数据", en: "Data" },
  "settings.adapter": { zh: "适配器", en: "Adapters" },
  "settings.mcp": { zh: "MCP", en: "MCP" },
  "settings.skills": { zh: "技能", en: "Skills" },
  "settings.memory": { zh: "记忆", en: "Memory" },
  "settings.characters": { zh: "角色", en: "Characters" },
  "settings.lore": { zh: "世界书", en: "Lorebook" },
  "settings.translate": { zh: "翻译", en: "Translate" },
  "settings.presets": { zh: "预设", en: "Presets" },
  "settings.save": { zh: "保存", en: "Save" },
  "settings.cancel": { zh: "取消", en: "Cancel" },
  "dialog.confirm": { zh: "确定", en: "OK" },
  "dialog.ok": { zh: "确定", en: "OK" },
  "settings.stoppingStrings": { zh: "停止字符串", en: "Stopping Strings" },
  "settings.stoppingStringsHint": {
    zh: "本地模型(llama.cpp 等)生成到这些串时提前终止;OpenAI 兼容接口走 stop 参数。每行一个,留空不发送。",
    en: "Local models stop generation when hitting these strings. One per line, empty = not sent.",
  },
  "settings.profiles": { zh: "连接档案", en: "Connection Profiles" },
  "settings.profileSave": { zh: "保存当前连接为档案", en: "Save Current Connection" },
  "settings.profileName": { zh: "档案名(如 中转A/直连)", en: "Profile name (e.g. Relay A)" },
  "settings.profileApply": { zh: "应用", en: "Apply" },
  "settings.profileHint": {
    zh: "把一套 API 地址/密钥/模型存成档案,一键应用到当前模型(多套连接快速切换)",
    en: "Save an API URL/key/model as a profile and apply it to the active model in one click.",
  },
  "settings.profileSaved": { zh: "档案已保存", en: "Profile saved" },
  "settings.profileApplied": { zh: "已应用到当前模型", en: "Applied to active model" },
  "settings.profileNeedModel": { zh: "请先选择/添加一个模型", en: "Select a model first" },
  "settings.profileNeedName": { zh: "请填写档案名", en: "Enter a profile name" },
  "settings.addModel": { zh: "添加模型", en: "Add Model" },
  "settings.defaultModel": { zh: "默认模型", en: "Default Model" },
  "settings.name": { zh: "名称", en: "Name" },
  "settings.apiUrl": { zh: "API 地址", en: "API URL" },
  "settings.apiKey": { zh: "密钥", en: "API Key" },
  "settings.model": { zh: "模型名", en: "Model" },
  "settings.temperature": { zh: "温度参数", en: "Temperature" },
  "settings.tempLabel": { zh: "温度", en: "Temp" },
  "settings.maxTokens": { zh: "最大 Token", en: "Max Tokens" },
  "settings.accent": { zh: "主题色", en: "Accent Color" },
  "settings.fontSize": { zh: "字号", en: "Font Size" },
  "settings.language": { zh: "语言", en: "Language" },
  "settings.small": { zh: "小", en: "Small" },
  "settings.medium": { zh: "中", en: "Medium" },
  "settings.large": { zh: "大", en: "Large" },
  "settings.thinking": { zh: "思考模式", en: "Thinking" },
  "settings.thinkingOn": { zh: "开启", en: "On" },
  "settings.thinkingOff": { zh: "关闭", en: "Off" },
  "settings.thinkingHint": {
    zh: "推理模型先思考再回答",
    en: "Reasoning models think before answering",
  },
  "settings.effort": { zh: "思考强度", en: "Effort" },
  "settings.effortHint": {
    zh: "low=快省, max=深思考（如 DeepSeek v4）",
    en: "low=faster/cheaper, max=deeper (e.g. DeepSeek v4)",
  },
  "settings.perModelHint": { zh: "留空则用全局默认", en: "empty = use global default" },
  "settings.multiKeyHint": {
    zh: "提示：多个 API Key 用英文逗号分隔，请求会自动轮询（如 key1,key2）",
    en: "Tip: separate multiple API keys with commas for round-robin (e.g. key1,key2)",
  },
  "settings.workAutoSummarize": { zh: "记忆卡", en: "Memory card" },
  "settings.workAutoSummarizeHint": {
    zh: "历史超 15 条自动摘要注入上下文（不删消息，省 token 保记忆）",
    en: "Auto-summarize after 15 messages (keeps messages, saves tokens)",
  },
  "settings.workTempMode": { zh: "临时会话", en: "Temp session" },
  "settings.workTempModeHint": {
    zh: "开启后完全不读写记忆（ChatGPT 临时对话）",
    en: "Skip all memory read/write (like ChatGPT temp chats)",
  },

  // ── Token 预算 ──
  "budget.title": { zh: "Token 预算", en: "Token Budget" },
  "budget.subtitle": { zh: "(监控 + 手动/自动双模式,跨三模式共用)", en: "(monitor + manual/auto)" },
  "budget.mode": { zh: "模式", en: "Mode" },
  "budget.auto": { zh: "自动", en: "Auto" },
  "budget.manual": { zh: "手动", en: "Manual" },
  "budget.autoHint": {
    zh: "发送前按优先级自动收缩,超限从低优先级砍(历史整段替换为摘要)",
    en: "Auto-shrink by priority before sending",
  },
  "budget.manualHint": { zh: "只监控显示,超限提示不自动砍", en: "Monitor only, no auto-shrink" },
  "budget.usage": { zh: "使用率", en: "Usage" },
  "budget.window": { zh: "上下文窗口", en: "Context window" },
  "budget.estimateHint": {
    zh: "token 为字符级估算(非真实 tokenizer),用于预算判断足够",
    en: "Char-level estimate — good enough for budgeting",
  },
  "budget.currentSession": { zh: "当前会话占用", en: "Current session usage" },
  "budget.history": { zh: "历史消息", en: "History" },
  "budget.total": { zh: "总计", en: "Total" },
  "budget.overAuto": { zh: "超预算——已按优先级自动收缩", en: "Over budget — auto-shrunk" },
  "budget.overManual": {
    zh: "超预算——手动模式未自动收缩,建议削减历史或调高使用率",
    en: "Over budget — manual mode: trim history or raise usage",
  },

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

  // ── Knowledge ──
  "kb.title": { zh: "知识库", en: "Knowledge Bases" },
  "kb.new": { zh: "新建知识库", en: "New KB" },
  "kb.files": { zh: "文件", en: "Files" },
  "kb.select": { zh: "请选择或新建知识库", en: "Select or create a knowledge base" },
  "kb.editing": { zh: "正在编辑", en: "Editing" },
  "kb.import": { zh: "导入", en: "Import" },
  "kb.importing": { zh: "导入中…", en: "Importing…" },
  "kb.importTitle": {
    zh: "导入 PDF/DOCX/TXT/MD 或图片（OCR）",
    en: "Import PDF/DOCX/TXT/MD or images (OCR)",
  },
  "kb.chunks": { zh: "{n} 段", en: "{n} chunks" },
  "kb.indexing": { zh: "索引中…", en: "Indexing…" },
  "kb.notIndexed": { zh: "未索引", en: "Not indexed" },
  "kb.retrievalTest": { zh: "检索测试", en: "Retrieval Test" },
  "kb.testPlaceholder": {
    zh: "输入问题，查看命中的知识片段…",
    en: "Ask a question to see matching chunks…",
  },
  "kb.testing": { zh: "检索中…", en: "Searching…" },
  "kb.test": { zh: "测试", en: "Test" },
  "kb.noHit": { zh: "未命中任何知识片段", en: "No matching chunks" },
  "kb.verified": { zh: "已验证", en: "Verified" },
  "kb.verifiedHint": {
    zh: "已验证来源:答案引用优先带此徽标的知识源",
    en: "Verified source: answers cite this KB first",
  },
  "kb.toggleVerified": { zh: "切换「已验证」标记", en: "Toggle verified badge" },
  "kb.needSelect": { zh: "请先选择知识库", en: "Select a knowledge base first" },
  "kb.noText": { zh: "未提取到文本内容", en: "No text extracted" },
  "kb.imported": { zh: "已导入 {name}（{count} 段）", en: "Imported {name} ({count} chunks)" },
  "kb.importFail": { zh: "导入失败：", en: "Import failed: " },

  // ── Memory ──
  "memory.title": { zh: "长期记忆", en: "Long-term Memory" },
  "memory.subtitle": {
    zh: "(结构化、可编辑；技能绑定标签后注入对话)",
    en: "(structured & editable; injected via skill-bound tags)",
  },
  "memory.contentPlaceholder": {
    zh: "记忆内容，如：用户是前端开发者，偏好 TypeScript…",
    en: "Memory content, e.g. the user is a frontend dev who prefers TypeScript…",
  },
  "memory.tagsPlaceholder": {
    zh: "标签（逗号分隔），如：工作, 用户偏好",
    en: "Tags (comma separated), e.g. work, preferences",
  },
  "memory.add": { zh: "添加记忆", en: "Add Memory" },
  "memory.saveEdit": { zh: "保存修改", en: "Save Changes" },
  "memory.empty": {
    zh: "尚无记忆。添加后可在「技能」里按标签绑定注入。",
    en: "No memories yet. Add one, then bind its tags in Skills.",
  },
  "memory.enabled": { zh: "启用", en: "On" },
  "memory.disabled": { zh: "停用", en: "Off" },
  "memory.edit": { zh: "编辑", en: "Edit" },
  "memory.delete": { zh: "删除", en: "Delete" },

  // ── Persona(用户自己的角色扮演)──
  "persona.title": { zh: "我的角色", en: "My Persona" },
  "persona.subtitle": {
    zh: "(你扮演的身份:名称+描述+头像,{{user}} 宏即此名)",
    en: "(who you play as: name + description + avatar; {{user}} = this name)",
  },
  "persona.new": { zh: "新建人设", en: "New Persona" },
  "persona.empty": {
    zh: "尚无 Persona。创建一个,在角色扮演中你就是 TA。",
    en: "No personas yet. Create one to be that character in roleplay.",
  },
  "persona.name": { zh: "名称", en: "Name" },
  "persona.descPlaceholder": {
    zh: "描述你的身份、外貌、背景…（对话中会注入提示词，支持 {{char}}/{{user}} 宏）",
    en: "Describe who you are… (injected into prompts; supports {{char}}/{{user}} macros)",
  },
  "persona.avatar": { zh: "更换头像", en: "Change avatar" },
  "persona.activate": { zh: "设为当前扮演", en: "Set as active" },

  // ── Character cards(角色卡)──
  "char.title": { zh: "角色卡", en: "Character Cards" },
  "char.subtitle": {
    zh: "(酒馆 SillyTavern 兼容:JSON / PNG 导入)",
    en: "(SillyTavern compatible: JSON / PNG import)",
  },
  "char.new": { zh: "新建角色", en: "New Character" },
  "char.edit": { zh: "编辑角色", en: "Edit Character" },
  "char.import": { zh: "导入", en: "Import" },
  "char.importFail": {
    zh: "导入失败：无法解析该文件（JSON 或 PNG 角色卡）",
    en: "Import failed: could not parse file (JSON or PNG card)",
  },
  "char.imported": { zh: "已导入角色「{name}」", en: 'Imported character "{name}"' },
  "char.importHint": {
    zh: "支持 .json（V1/V2/V3）与 .png（尾部嵌入 JSON 的酒馆卡片）",
    en: "Supports .json (V1/V2/V3) and .png (SillyTavern cards with trailing JSON)",
  },
  "char.exportJson": { zh: "导出 JSON", en: "Export JSON" },
  "char.exportPng": { zh: "导出 PNG（需头像）", en: "Export PNG (needs avatar)" },
  "char.exportNeedAvatar": {
    zh: "导出 PNG 需要角色头像（请先上传头像）",
    en: "Exporting PNG requires an avatar (upload one first)",
  },
  "char.exported": { zh: "已导出到 {path}", en: "Exported to {path}" },
  "char.saved": { zh: "角色已保存", en: "Character saved" },
  "char.empty": {
    zh: "暂无角色卡。导入酒馆角色卡或新建一个开始扮演。",
    en: "No character cards yet. Import one or create your own.",
  },
  "char.name": { zh: "名称", en: "Name" },
  "char.tags": { zh: "标签", en: "Tags" },
  "char.preset": { zh: "提示词预设", en: "Prompt Preset" },
  "char.presetNone": { zh: "（默认：经典 Char）", en: "(default: Classic Char)" },
  "char.lorebookBind": { zh: "绑定独立世界书", en: "Bind lorebooks" },
  "char.lorebookBindNone": {
    zh: "暂无独立世界书,去 设置 → 世界书 导入",
    en: "No lorebooks yet — import in Settings → Lorebook",
  },
  "char.description": { zh: "角色描述", en: "Description" },
  "char.personality": { zh: "性格", en: "Personality" },
  "char.scenario": { zh: "场景", en: "Scenario" },
  "char.firstMes": { zh: "开场白", en: "First Message" },
  "char.alternateGreetings": {
    zh: "备用开场白（--- 分隔）",
    en: "Alternate Greetings (--- separated)",
  },
  "char.mesExample": { zh: "示例对话", en: "Example Messages" },
  "char.systemPrompt": { zh: "自定义系统提示词", en: "Custom System Prompt" },
  "char.postHistory": { zh: "后置指令（Post-History）", en: "Post-History Instructions" },
  "char.depthPromptDepth": { zh: "深度(第N条)", en: "Depth (Nth msg)" },
  "char.depthPrompt": { zh: "深度提示词（V3）", en: "Depth Prompt (V3)" },
  "char.depthPromptPlaceholder": {
    zh: "对话进行到第 N 条消息时自动注入此提示（如中段转折指令）",
    en: "Injected when the chat reaches message N (e.g. mid-chat directives)",
  },
  "char.loreEmbedded": {
    zh: "内嵌世界书（每行：关键词1,关键词2:内容）",
    en: "Embedded Lorebook (one per line: key1,key2:content)",
  },
  "char.avatar": { zh: "上传头像", en: "Upload avatar" },
  "char.convertPersona": { zh: "转为人设", en: "Convert to Persona" },
  "char.convertPersonaDone": {
    zh: "已创建同名 Persona（可在「我的角色」中查看）",
    en: 'Persona created (see "My Persona")',
  },
  "char.emotions": { zh: "表情图片（酒馆 Expressions）", en: "Emotion Images (Expressions)" },
  "char.noEmotions": {
    zh: "此卡无表情数据（extensions.emotions）；带表情的卡会自动出现可上传",
    en: "No emotion data on this card; cards with emotions will show upload slots",
  },
  "char.emotionUpload": { zh: "上传表情 {key}", en: "Upload emotion {key}" },
  "char.emotionSaved": { zh: "表情 {key} 已保存", en: "Emotion {key} saved" },

  // ── Lorebook(世界书)──
  "lore.title": { zh: "世界书（Lorebook）", en: "Lorebook" },
  "lore.subtitle": {
    zh: "(关键词命中自动注入世界观设定)",
    en: "(world settings auto-injected on keyword match)",
  },
  "lore.new": { zh: "新建条目", en: "New Entry" },
  "lore.keys": { zh: "关键词（逗号分隔）", en: "Keywords (comma separated)" },
  "lore.constant": { zh: "常驻", en: "Constant" },
  "lore.content": {
    zh: "条目内容（出现关键词时注入）",
    en: "Entry content (injected when keys match)",
  },
  "lore.order": { zh: "插入顺序（大=靠后）", en: "Insertion order (larger = later)" },
  "lore.empty": {
    zh: "尚无世界书条目。新建条目，对话中出现关键词时自动注入设定。",
    en: "No lore entries yet. Add one to auto-inject setting when keywords appear.",
  },
  "lore.import": { zh: "导入", en: "Import" },
  "lore.importHint": {
    zh: "导入酒馆世界书 JSON(独立 Lorebook 或角色卡内嵌 character_book)",
    en: "Import tavern lorebook JSON (standalone or embedded character_book)",
  },
  "lore.imported": { zh: "已导入世界书（{n} 条）", en: "Lorebook imported ({n} entries)" },
  "lore.importedFromCard": {
    zh: "已从角色卡提取世界书（{n} 条）",
    en: "Extracted lorebook from character card ({n} entries)",
  },
  "lore.importFail": {
    zh: "世界书导入失败：无法解析",
    en: "Lorebook import failed: could not parse",
  },
  "lore.main": { zh: "主世界书", en: "Main Lorebook" },
  "lore.mainProtected": {
    zh: "主世界书不可删除（可清空条目）",
    en: "Main lorebook cannot be deleted (entries can be cleared)",
  },
  "lore.newBook": { zh: "新建世界书名…", en: "New lorebook name…" },
  "lore.personaBind": { zh: "我的角色（Persona）绑定世界书", en: "Bind lorebooks to my persona" },
  "lore.personaNone": {
    zh: "暂无 Persona，先到「角色」创建",
    en: "No persona yet — create one in Characters",
  },
  "lore.noBind": { zh: "（不绑定）", en: "(none)" },
  "lore.noBooks": {
    zh: "（尚无独立世界书，先导入）",
    en: "(no standalone lorebooks yet — import one)",
  },
  "lore.enabledBooks": {
    zh: "启用的世界书（多选，同时生效）",
    en: "Enabled lorebooks (multi-select, all active)",
  },
  "lore.caseSensitive": { zh: "大小写敏感", en: "Case sensitive" },
  "lore.recursive": { zh: "递归激活", en: "Recursive" },
  "lore.regex": { zh: "正则关键词", en: "Regex keys" },
  "lore.probability": { zh: "概率", en: "Probability" },
  "lore.position": { zh: "位置", en: "Position" },
  "lore.positionBefore": { zh: "角色定义前", en: "Before char" },
  "lore.positionAfter": { zh: "角色定义后", en: "After char" },
  "lore.scanDepth": { zh: "扫描深度", en: "Scan depth" },
  "lore.tokenBudget": { zh: "注入预算", en: "Token budget" },
  "lore.budgetHint": { zh: "缺省 8 / 1500", en: "default 8 / 1500" },

  // ── 采样器(API 响应配置)──
  "settings.sampler": { zh: "采样器", en: "Samplers" },
  "sampler.title": { zh: "AI 响应配置（采样器）", en: "AI Response (Samplers)" },
  "sampler.subtitle": {
    zh: "(酒馆 Sliders:温度/top_p/top_k/重复惩罚…)",
    en: "(tavern sliders: temp / top_p / top_k / repetition…)",
  },
  "sampler.extendedHint": {
    zh: "扩展字段（Top K / Repetition Penalty / Min P）对本地后端（vLLM、llama.cpp）生效；OpenAI 官方端点用标准字段",
    en: "Extended fields (top_k / repetition_penalty / min_p) apply to local backends; OpenAI endpoints use standard fields",
  },
  "sampler.activeFor": { zh: "当前生效模型", en: "Applied to" },
  "sampler.noModel": { zh: "请先选择模型", en: "Select a model first" },
  "sampler.applied": { zh: "已应用到 {name}", en: "Applied to {name}" },
  "sampler.reset": { zh: "重置（用全局默认）", en: "Reset to global default" },
  "sampler.savePreset": { zh: "保存为预设", en: "Save as preset" },
  "sampler.presetName": { zh: "预设名称…", en: "Preset name…" },
  "sampler.presetSaved": { zh: "采样器预设已保存", en: "Sampler preset saved" },
  "sampler.applyModel": { zh: "应用到当前模型", en: "Apply to current model" },
  "sampler.presets": { zh: "采样器预设", en: "Sampler presets" },
  "sampler.load": { zh: "载入", en: "Load" },
  "sampler.loaded": { zh: "已载入预设 {name}", en: "Loaded preset {name}" },
  "sampler.local": {
    zh: "本地后端(DRY / Mirostat,仅 llama.cpp 生效)",
    en: "Local backend (DRY / Mirostat, llama.cpp only)",
  },

  // ── Regex 样式后处理 ──
  "settings.regex": { zh: "样式", en: "Style" },
  "regex.title": { zh: "AI 回复样式(Regex)", en: "AI Reply Style (Regex)" },
  "regex.subtitle": {
    zh: "(渲染前正则替换,不改原始数据,历史也生效)",
    en: "(regex on display, original data untouched)",
  },
  "regex.hint": {
    zh: "内置规则:去 OOC 注释 / 去全大写括号指令 / 引号转换;自定义规则用 JS 正则(替换串支持 $1 捕获)",
    en: "Built-in: strip OOC, ALL-CAPS brackets, quotes; custom rules use JS regex ($1 captures supported)",
  },
  "regex.new": { zh: "新建规则", en: "New Rule" },
  "regex.name": { zh: "规则名", en: "Name" },
  "regex.pattern": { zh: "正则 pattern", en: "Regex pattern" },
  "regex.replacement": { zh: "替换为", en: "Replacement" },
  "regex.preview": { zh: "实时预览(输入文本看规则效果)", en: "Live preview (type text to test)" },
  "regex.result": { zh: "处理后", en: "After" },

  // ── 缓存诊断 ──
  "settings.cache": { zh: "缓存", en: "Cache" },
  "cache.title": { zh: "DeepSeek 缓存诊断", en: "DeepSeek Cache" },
  "cache.subtitle": {
    zh: "(命中率验证三段式优化)",
    en: "(verifies the 3-part prompt optimization)",
  },
  "cache.clear": { zh: "清空记录", en: "Clear" },
  "cache.noData": { zh: "暂无数据——发几条消息后自动统计", en: "No data yet — send some messages" },
  "cache.avg": { zh: "平均命中率（最近 {n} 次请求）", en: "Average hit rate (last {n} requests)" },
  "cache.trend": { zh: "最近趋势", en: "Recent trend" },
  "cache.tipsTitle": { zh: "提升命中率的提示", en: "Tips to raise hit rate" },
  "cache.tip1": {
    zh: "世界书已统一注入消息尾部（稳定前缀 + 可变尾部）——长对话命中率自然冲高",
    en: "Lorebook is now injected at the tail — long chats get high prefix hits",
  },
  "cache.tip2": {
    zh: "避免自定义预设使用 {{time}}（每轮全量失效）",
    en: "Avoid {{time}} in custom presets (kills the prefix)",
  },
  "cache.tip3": {
    zh: "世界书条目概率 <100 会牺牲缓存确定性,建议设 100",
    en: "Lorebook probability <100 hurts cache determinism — use 100",
  },

  // ── 酒馆助手 ──
  "settings.assistant": { zh: "助手", en: "Assistant" },
  "assistant.title": { zh: "酒馆助手", en: "Tavern Assistant" },
  "assistant.subtitle": {
    zh: "(AI 创作:角色卡/世界书/预设,基于当前模型)",
    en: "(AI creation: cards / lorebooks / presets)",
  },
  "assistant.cacheHint": { zh: "发消息后自动统计", en: "auto-tracked on replies" },
  "assistant.target": { zh: "对象", en: "Target" },
  "assistant.noContext": { zh: "（不附带上下文）", en: "(no context)" },
  "assistant.actCard": { zh: "帮我写角色卡", en: "Write a card" },
  "assistant.actLore": { zh: "生成世界书条目", en: "Generate lore" },
  "assistant.actPreset": { zh: "优化我的预设", en: "Optimize preset" },
  "assistant.actExplain": { zh: "解释设置项", en: "Explain settings" },
  "assistant.inputPlaceholder": {
    zh: "输入创作要求…（也可直接点上方快捷动作）",
    en: "Describe what to create… (or use quick actions)",
  },
  "assistant.send": { zh: "生成", en: "Generate" },
  "assistant.busy": { zh: "生成中…", en: "Working…" },
  "assistant.noLoreLines": {
    zh: "未识别到「关键词:内容」格式的行,请复制手动添加",
    en: "No key:content lines detected — copy manually",
  },
  "assistant.loreApplied": {
    zh: "已把 {n} 条生成条目写入世界书",
    en: "Added {n} entries to lorebook",
  },
  "assistant.applyLore": { zh: "写入世界书", en: "Add to lorebook" },
  "assistant.applyPreset": { zh: "保存为新预设", en: "Save as preset" },
  "assistant.presetApplied": {
    zh: "已保存为新预设（可在「预设」查看）",
    en: "Saved as new preset",
  },

  // ── 预设管理 ──
  "preset.title": { zh: "提示词预设", en: "Prompt Presets" },
  "preset.subtitle": {
    zh: "(酒馆预设：主提示词/叙事风格/NSFW/Jailbreak…)",
    en: "(tavern presets: main prompt / style / NSFW / jailbreak…)",
  },
  "preset.import": { zh: "导入预设", en: "Import" },
  "preset.importHint": {
    zh: "导入酒馆预设 JSON（单条或 Freaky 等完整导出，自动拆成「默认组合」+ 各独立段，角色编辑里可选）",
    en: "Import tavern preset JSON (single or full export like Freaky; splits into default combo + individual sections)",
  },
  "preset.imported": { zh: "已导入 {n} 个预设", en: "Imported {n} presets" },
  "preset.importFail": {
    zh: "预设导入失败：无法解析",
    en: "Preset import failed: could not parse",
  },
  "preset.isLorebook": {
    zh: "这是世界书，已自动导入到「世界书」",
    en: "That's a lorebook — auto-imported to Lorebook",
  },
  "preset.isCharacter": {
    zh: "这是角色卡，请到「角色」tab 导入",
    en: "That's a character card — import it in the Characters tab",
  },
  "preset.new": { zh: "新建", en: "New" },
  "preset.name": { zh: "预设名称", en: "Preset name" },
  "preset.templatePlaceholder": {
    zh: "提示词模板（支持 {{char}}/{{user}}/{{description}}/{{lorebook}} 等宏）",
    en: "Prompt template ({{char}}/{{user}}/{{description}}/{{lorebook}}…)",
  },
  "preset.saved": { zh: "预设已保存", en: "Preset saved" },
  "preset.view": { zh: "查看/编辑条目", en: "View / edit" },

  // ── MCP ──
  "mcp.title": { zh: "MCP 服务器", en: "MCP Servers" },
  "mcp.titleHint": {
    zh: "(外部工具：数据库 / 文件 / GitHub 等)",
    en: "(external tools: DB / files / GitHub…)",
  },
  "mcp.namePlaceholder": { zh: "名称（如 filesystem）", en: "Name (e.g. filesystem)" },
  "mcp.commandPlaceholder": {
    zh: "命令（如 npx 或 C:\\path\\server.exe）",
    en: "Command (e.g. npx or C:\\path\\server.exe)",
  },
  "mcp.argsPlaceholder": {
    zh: "参数（空格分隔，如 -y @modelcontextprotocol/server-filesystem C:\\data）",
    en: "Args (space separated, e.g. -y @modelcontextprotocol/server-filesystem C:\\data)",
  },
  "mcp.envPlaceholder": {
    zh: "环境变量（每行 KEY=VALUE，如 API_KEY=sk-xxx）",
    en: "Env vars (one per line KEY=VALUE, e.g. API_KEY=sk-xxx)",
  },
  "mcp.add": { zh: "添加服务器", en: "Add Server" },
  "mcp.securityTitle": { zh: "权限 / 授权 / 审计", en: "Permissions / Grants / Audit" },
  "mcp.securityHint": {
    zh: "(allow/ask/deny 策略 + 带过期授权 + 调用回放)",
    en: "(allow/ask/deny + expiring grants + call replay)",
  },
  "mcp.refreshSecurity": { zh: "刷新", en: "Refresh" },
  "mcp.permissions": { zh: "权限策略", en: "Permission policies" },
  "mcp.clearPermission": { zh: "清除策略", en: "Clear policy" },
  "mcp.grants": { zh: "临时授权", en: "Temporary grants" },
  "mcp.grantServer": { zh: "服务器…", en: "Server…" },
  "mcp.grantMinutes": { zh: "授权分钟数(0=长期)", en: "Minutes (0 = permanent)" },
  "mcp.grantNeedServer": { zh: "请先选择服务器", en: "Pick a server first" },
  "mcp.grantAdd": { zh: "授权", en: "Grant" },
  "mcp.grantAdded": { zh: "已添加临时授权", en: "Grant added" },
  "mcp.noGrants": { zh: "暂无临时授权", en: "No grants yet" },
  "mcp.revoke": { zh: "撤销授权", en: "Revoke" },
  "mcp.audit": { zh: "调用审计(最近 30 条)", en: "Call audit (last 30)" },
  "mcp.noAudit": { zh: "暂无调用记录", en: "No calls yet" },
  "mcp.import": { zh: "导入配置", en: "Import Config" },
  "mcp.importTitle": {
    zh: "导入标准 MCP 配置 JSON（mcpServers 格式）",
    en: "Import standard MCP config JSON (mcpServers format)",
  },
  "mcp.nameRequired": { zh: "名称和命令必填", en: "Name and command are required" },
  "mcp.added": { zh: "已添加 MCP 服务器", en: "MCP server added" },
  "mcp.empty": {
    zh: "尚未添加 MCP 服务器。示例：`npx -y @modelcontextprotocol/server-filesystem D:\\docs`",
    en: "No MCP servers yet. Example: `npx -y @modelcontextprotocol/server-filesystem D:\\docs`",
  },
  "mcp.enabled": { zh: "启用", en: "Enabled" },
  "mcp.disabled": { zh: "禁用", en: "Disabled" },
  "mcp.loadTools": { zh: "加载工具", en: "Load tools" },
  "mcp.delete": { zh: "删除", en: "Delete" },
  "mcp.calling": { zh: "调用中…", en: "Calling…" },
  "mcp.call": { zh: "调用", en: "Call" },
  "mcp.argsJsonPlaceholder": { zh: "参数 JSON，如 {example}", en: "Args JSON, e.g. {example}" },
  "mcp.noTools": {
    zh: "该服务器没有可用工具（或未加载）",
    en: "No tools available on this server (or not loaded)",
  },
  "mcp.importPrompt": {
    zh: '粘贴 MCP 配置 JSON（格式：{"mcpServers":{"名称":{"command":"...","args":[...],"env":{...}}}}）：',
    en: 'Paste MCP config JSON (format: {"mcpServers":{"name":{"command":"...","args":[...],"env":{...}}}}):',
  },
  "mcp.jsonFail": { zh: "JSON 解析失败", en: "Invalid JSON" },
  "mcp.missingMcpServers": { zh: "缺少 mcpServers 对象", en: "Missing mcpServers object" },
  "mcp.noneToImport": { zh: "没有要导入的服务器", en: "Nothing to import" },
  "mcp.skipped": { zh: "「{name}」缺少 command，已跳过", en: '"{name}" has no command, skipped' },
  "mcp.importFail": { zh: "「{name}」导入失败: {e}", en: '"{name}" import failed: {e}' },
  "mcp.imported": { zh: "已导入 {n} 个 MCP 服务器", en: "Imported {n} MCP servers" },
  "mcp.notEnabled": { zh: "{name} 未启用", en: "{name} is not enabled" },
  "mcp.invalidJson": { zh: "参数不是合法 JSON", en: "Args are not valid JSON" },
  "mcp.emptyResult": { zh: "(空结果)", en: "(empty result)" },
  "mcp.error": { zh: "错误: {e}", en: "Error: {e}" },

  // ── Data / Backup ──
  "data.localBackup": { zh: "本地备份", en: "Local Backup" },
  "data.backupDirPlaceholder": { zh: "备份目录（默认 {dir}）", en: "Backup dir (default {dir})" },
  "data.backingUp": { zh: "备份中…", en: "Backing up…" },
  "data.backupNow": { zh: "立即备份", en: "Backup Now" },
  "data.refresh": { zh: "刷新列表", en: "Refresh list" },
  "data.upload": { zh: "上传", en: "Upload" },
  "data.uploadWebdav": { zh: "上传到 WebDAV", en: "Upload to WebDAV" },
  "data.restore": { zh: "恢复", en: "Restore" },
  "data.noBackups": {
    zh: "尚无备份。填好目录点「立即备份」。",
    en: 'No backups yet. Set a directory and click "Backup Now".',
  },
  "data.webdavTitle": { zh: "WebDAV 云端备份", en: "WebDAV Cloud Backup" },
  "data.webdavUrlPlaceholder": {
    zh: "WebDAV 地址，如 https://dav.example.com/remote.php/dav/files/user/ai-backup",
    en: "WebDAV URL, e.g. https://dav.example.com/remote.php/dav/files/user/ai-backup",
  },
  "data.username": { zh: "账号", en: "Username" },
  "data.password": { zh: "密码", en: "Password" },
  "data.webdavHint": {
    zh: "先创建本地备份，再点某条备份的「上传」。目标目录需已在 WebDAV 服务端建好。",
    en: 'Create a local backup first, then click "Upload" on it. The target directory must exist on the WebDAV server.',
  },
  "data.listFail": { zh: "读取备份列表失败：", en: "Failed to read backup list: " },
  "data.backupDone": { zh: "备份完成：", en: "Backup created: " },
  "data.backupFail": { zh: "备份失败：", en: "Backup failed: " },
  "data.restoreConfirm": {
    zh: "确定用「{name}」覆盖当前数据？建议先备份。",
    en: 'Restore "{name}" over current data? Consider backing up first.',
  },
  "data.restoreFail": { zh: "恢复失败：", en: "Restore failed: " },
  "data.uploadNeedConfig": {
    zh: "请先填写 WebDAV 地址和账号",
    en: "Fill in the WebDAV URL and username first",
  },
  "data.uploaded": { zh: "已上传 {name} 到 WebDAV", en: "Uploaded {name} to WebDAV" },
  "data.uploadFail": { zh: "上传失败：", en: "Upload failed: " },

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

  // ── Command palette ──
  "palette.placeholder": { zh: "搜索对话、消息、命令…", en: "Search chats, messages, commands…" },
  "palette.noResults": { zh: "无结果", en: "No results" },
  "palette.newChat": { zh: "新建对话", en: "New Chat" },
  "palette.openTranslate": { zh: "打开翻译工作区", en: "Open Translation Workspace" },
  "palette.openDraw": { zh: "打开绘图工作区", en: "Open Drawing Workspace" },
  "palette.openSettings": { zh: "打开设置", en: "Open Settings" },
  "palette.switchModel": { zh: "切换到模型：{name}", en: "Switch to model: {name}" },
  "palette.convSub": { zh: "对话", en: "Conversation" },

  // ── Shortcuts ──
  "shortcut.closeTab": { zh: "关闭当前标签", en: "Close current tab" },
  "shortcut.nextTab": { zh: "切换标签", en: "Next tab" },
  "shortcut.prevTab": { zh: "切换标签（反向）", en: "Previous tab" },
  "shortcut.nextProvider": { zh: "下一个服务商", en: "Next provider" },
  "shortcut.prevProvider": { zh: "上一个服务商", en: "Previous provider" },
  "shortcut.nextSubModel": { zh: "下一个子模型", en: "Next sub-model" },

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

  // ── App ──
  "app.loading": { zh: "加载中...", en: "Loading..." },

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
  "tavern.title": { zh: "酒馆", en: "Tavern" },
  "tavern.manage": { zh: "管理角色/世界书/人设", en: "Manage characters / lorebook / personas" },
  "tavern.searchChar": { zh: "搜索角色…", en: "Search characters…" },
  "tavern.characters": { zh: "角色", en: "Characters" },
  "tavern.noChars": {
    zh: "暂无角色卡。点右上 ⚙ 管理导入酒馆卡片。",
    en: "No character cards. Open ⚙ to import tavern cards.",
  },
  "tavern.start": { zh: "开始与 {name} 的角色扮演", en: "Start roleplay with {name}" },
  "tavern.chats": { zh: "RP 会话", en: "RP Chats" },
  "tavern.searchChats": { zh: "搜索会话/角色…", en: "Search chats / characters…" },
  "tavern.emptyChats": { zh: "选一个角色开始扮演", en: "Pick a character to start" },
  "tavern.noPersona": { zh: "无 Persona(以 User 身份)", en: "No persona (play as User)" },
  "tavern.welcome": { zh: "欢迎来到酒馆", en: "Welcome to the Tavern" },
  "tavern.hint": {
    zh: "左侧选择角色开始角色扮演,会话与工作模式完全隔离",
    en: "Pick a character on the left to start roleplay — chats are isolated from work mode",
  },
  "tavern.inputPlaceholder": { zh: "对角色说…", en: "Say something…" },
  "tavern.model": { zh: "模型", en: "Model" },
  "tavern.modelGlobal": { zh: "跟随全局 {name}", en: "Follow global ({name})" },
  "tavern.sampler": { zh: "采样器预设", en: "Sampler preset" },
  "tavern.samplerDefault": { zh: "跟随模型/全局", en: "Follow model/global" },
  "tavern.lorebooks": { zh: "会话世界书", en: "Chat lorebooks" },
  "tavern.lorebooksHint": {
    zh: "(聊天级绑定,可多选,与全局/角色/Persona 合并)",
    en: "(chat-level, multi-select, merged with global/char/persona)",
  },
  "tavern.autoSummarize": { zh: "自动记忆", en: "Auto memory" },
  "tavern.autoSummarizeHint": {
    zh: "酒馆 Summarize:对话超 15 条自动总结,省 token 保记忆(注入「对话摘要」)",
    en: "Summarize chats over 15 msgs to save tokens & keep memory",
  },
  "tavern.groupNew": { zh: "新建群聊", en: "New Group Chat" },
  "tavern.groupSection": { zh: "群聊", en: "Group Chats" },
  "tavern.variables": { zh: "消息变量（{{var::name}}）", en: "Message Variables ({{var::name}})" },
  "tavern.attachments": { zh: "数据银行 / 聊天附件（发送时注入）", en: "Data Bank / Attachments (injected on send)" },
  "tavern.groupHint": {
    zh: "(≥2 个角色;可选手动指定发言或 AI 自动轮转)",
    en: "(≥2 chars; pick who replies or let AI auto-respond)",
  },
  "tavern.groupCreate": { zh: "创建群聊", en: "Create Group" },
  "tavern.groupNeed2": { zh: "至少选 2 个角色", en: "Select at least 2 characters" },
  "tavern.groupActiveChar": { zh: "当前发言角色（手动模式）", en: "Active speaker (manual)" },
  "tavern.groupAuto": { zh: "自动回应", en: "Auto-respond" },
  "tavern.groupAutoHint": {
    zh: "开:AI 自选角色回复(回复以【角色名】开头);关:手动指定",
    en: "On: AI picks who replies; Off: you pick",
  },
  "tavern.autoTranslate": { zh: "自动翻译", en: "Auto-translate" },
  "tavern.autoTranslateHint": {
    zh: "AI 回复完成后自动翻译成目标语言",
    en: "Auto-translate each AI reply to the target language",
  },
  "tavern.targetLang": { zh: "翻译目标语言", en: "Translate target language" },
  "tavern.memPanel": {
    zh: "记忆面板（作者注/钉住/软重置）",
    en: "Memory panel (note/pin/soft reset)",
  },
  "tavern.authorNote": {
    zh: "作者注（靠近生成处,当前指令）",
    en: "Author's Note (near generation)",
  },
  "tavern.authorNoteHint": {
    zh: "短程控制:如「当前氛围紧张,动作描写多些」",
    en: "Short-term control, e.g. current scene tone",
  },
  "tavern.pinned": { zh: "钉住区（常驻上下文）", en: "Pinned (always in context)" },
  "tavern.pinnedHint": {
    zh: "关键承诺/伏笔/人物关系,始终携带",
    en: "Key promises/foreshadowing/relations, always on",
  },
  "tavern.softReset": { zh: "软重置（新章节）", en: "Soft reset" },
  "tavern.softResetHint": {
    zh: "清空对话历史,保留摘要/世界书/人设/时间线",
    en: "Clear history, keep summary/lore/persona/timeline",
  },
  "context.title": { zh: "上下文查看器", en: "Context Viewer" },
  "context.subtitle": { zh: "实际发给模型的 prompt 拼装", en: "What the model actually receives" },
  "context.stable": {
    zh: "稳定前缀（角色/人设/模板）",
    en: "Stable prefix (card/persona/template)",
  },
  "context.lorebook": { zh: "世界书命中", en: "Lorebook hits" },
  "context.summary": { zh: "对话摘要", en: "Summary" },
  "context.depth": { zh: "深度提示词（第 {n} 条后）", en: "Depth prompt (after msg {n})" },
  "context.copy": { zh: "复制全部", en: "Copy all" },
  "qr.name": { zh: "名称", en: "Name" },
  "qr.template": { zh: "模板(支持 {{char}}/[roll]/[ask])", en: "Template ({{char}}/[roll]/[ask])" },
  "qr.add": { zh: "添加快捷按钮", en: "Add quick button" },
  "graph.title": { zh: "记忆图谱", en: "Memory Graph" },
  "graph.empty": {
    zh: "暂无关系图数据(对话中提及名字/关系句后自动生成)",
    en: "No graph yet (appears as names/relations are mentioned)",
  },

  // ── 推演模式(酒馆子模式)──
  "sim.title": { zh: "推演", en: "Simulation" },
  "sim.manage": { zh: "推演设置", en: "Simulation settings" },
  "sim.new": { zh: "新建推演", en: "New Simulation" },
  "sim.newHint": {
    zh: "(选形态/状态/节奏,会话内可随时改)",
    en: "(pick a type; editable inside the session)",
  },
  "sim.search": { zh: "搜索推演会话…", en: "Search simulations…" },
  "sim.emptyChats": { zh: "点「新建推演」开始", en: 'Click "New Simulation" to start' },
  "sim.deleteConfirm": { zh: "删除该推演会话?", en: "Delete this simulation?" },
  "sim.welcome": { zh: "欢迎来到推演室", en: "Welcome to the Simulation Room" },
  "sim.hint": {
    zh: "左侧新建推演:设定世界观,每轮输入行动/事件,AI 推演剧情与世界演化",
    en: "Create a simulation: set a world, act each turn — AI narrates the story & evolves the world",
  },
  "sim.inputPlaceholder": { zh: "输入你的行动 / 指令…", en: "Your action / command…" },
  "sim.aiName": { zh: "推演", en: "Narrator" },
  "sim.autoSummarize": { zh: "自动记忆", en: "Auto memory" },
  "sim.type.story": { zh: "剧情推演", en: "Story" },
  "sim.type.sandbox": { zh: "世界沙盒", en: "Sandbox" },
  "sim.type.tactical": { zh: "战术行动", en: "Tactical" },
  "sim.typeDesc.story": {
    zh: "互动叙事:你设定背景与人物,每轮输入行动/决策,AI 推演剧情发展与后果,多分支多结局。",
    en: "Interactive narrative: you act, AI narrates consequences — branching stories.",
  },
  "sim.typeDesc.sandbox": {
    zh: "宏观演化:设定世界(文明/势力/资源/科技),按时间步推进,随时注入事件或命令。",
    en: "Macro world evolution: time-steps, inject events, watch civilizations rise & fall.",
  },
  "sim.typeDesc.tactical": {
    zh: "数值裁定:兵力/资源/士气/成功率,AI 结算数值变化,可掷骰(🎲)决定成败。",
    en: "Numerical adjudication: dice rolls, success rates, tracked stats.",
  },
  "sim.stateModeLabel": { zh: "状态跟踪", en: "State tracking" },
  "sim.stateMode.text": { zh: "轻状态·状态文本", en: "Light — state text" },
  "sim.stateMode.table": { zh: "重状态·结构化表", en: "Heavy — state table" },
  "sim.stateMode.none": { zh: "纯叙事不跟踪", en: "None — narrative only" },
  "sim.pacingLabel": { zh: "推演节奏", en: "Pacing" },
  "sim.pacing.turn": { zh: "回合制+可连续", en: "Turn-based + auto" },
  "sim.pacing.time": { zh: "时间步进", en: "Time-step" },
  "sim.pacing.auto": { zh: "自动连续推演", en: "Auto-run" },
  "sim.stateUpdateLabel": { zh: "状态更新策略", en: "State update" },
  "sim.stateUpdate.every": { zh: "每轮自动更新", en: "Every turn" },
  "sim.stateUpdate.lazy": { zh: "惰性(手动/每5轮)", en: "Lazy (manual/5 turns)" },
  "sim.stateUpdate.inline": { zh: "内嵌解析(省token)", en: "Inline parse (cheap)" },
  "sim.autoRounds": { zh: "自动推演轮数", en: "Auto rounds" },
  "sim.advanced": { zh: "高级选项", en: "Advanced" },
  "sim.setupLabel": {
    zh: "世界观设定（推演指令始终携带）",
    en: "World setup (always in the prompt)",
  },
  "sim.setupPlaceholder": {
    zh: "例:维多利亚伦敦,侦探追查连环案件;或:三个王国争夺大陆,龙族沉睡千年…",
    en: "e.g. Victorian London, a detective on a case; or three kingdoms, sleeping dragons…",
  },
  "sim.create": { zh: "创建推演", en: "Create" },
  "sim.statePanel": { zh: "世界状态", en: "World state" },
  "sim.stateNone": {
    zh: "纯叙事模式:不维护状态,由对话历史承载连续性",
    en: "Narrative-only: no tracked state",
  },
  "sim.worldStatePlaceholder": { zh: "当前世界状态…", en: "Current world state…" },
  "sim.saveState": { zh: "保存", en: "Save" },
  "sim.tableKey": { zh: "键（势力/资源）", en: "Key (faction/resource)" },
  "sim.tableValue": { zh: "值", en: "Value" },
  "sim.tableAdd": { zh: "添加行", en: "Add row" },
  "sim.timelinePanel": { zh: "事件时间线", en: "Timeline" },
  "sim.timelineEmpty": { zh: "暂无事件记录", en: "No events yet" },
  "sim.timelineTime": { zh: "时间", en: "Time" },
  "sim.timelineEvent": { zh: "事件…", en: "Event…" },
  "sim.sync": { zh: "更新状态", en: "Sync" },
  "sim.syncHint": {
    zh: "用独立流重新提取世界状态与时间线",
    en: "Re-extract world state & timeline via a dedicated stream",
  },
  "sim.continue": { zh: "继续推演", en: "Continue" },
  "sim.continueHint": {
    zh: "自动连续推演 N 轮(可随时停止)",
    en: "Auto-run N rounds (stop anytime)",
  },
  "sim.rounds": { zh: "轮", en: "rounds" },
  "sim.timeStepPlaceholder": { zh: "时间跨度(如 3 天/1 年)…", en: "Time span (3 days / 1 year)…" },
  "sim.timeStepGo": { zh: "时间推进", en: "Advance" },
  "sim.dice": { zh: "掷骰", en: "Roll" },
  "sim.diceThreshold": { zh: "阈值(成功率)", en: "DC (success rate)" },
  "sim.diceHint": {
    zh: "前端随机数掷骰;填阈值时判定通过/失败,AI 按结果结算",
    en: "Random dice roll; with a DC, judge pass/fail — AI adjudicates by it",
  },
  "sim.settingsTitle": { zh: "推演玩法说明", en: "How Simulation works" },
  "sim.settingsSubtitle": {
    zh: "(各会话的形态/状态/节奏在创建时选择)",
    en: "(per-session settings at creation)",
  },
  "sim.settingsStateLabel": { zh: "状态跟踪:", en: "State:" },
  "sim.settingsStateDesc": {
    zh: "轻状态=世界状态文本(每轮自动更新);重状态=结构化键值表(势力/资源);纯叙事=不跟踪。",
    en: "Light = state text; Heavy = structured table; None = narrative only.",
  },
  "sim.settingsPacingLabel": { zh: "节奏:", en: "Pacing:" },
  "sim.settingsPacingDesc": {
    zh: "回合制=你发指令 AI 推演一步(可连续);时间步进=指定跨度推演简报;自动连续=AI 自主推进可打断。",
    en: "Turn = step-by-step; Time-step = advance by span; Auto = AI keeps going until interrupted.",
  },
  "sim.settingsUpdateLabel": { zh: "状态更新:", en: "State update:" },
  "sim.settingsUpdateDesc": {
    zh: "每轮=独立流精确刷新(费token);惰性=手动或每5轮;内嵌=推演输出自带【状态】段解析(省token)。",
    en: "Every turn = precise but costs tokens; Lazy = manual/5 turns; Inline = parse from output (cheap).",
  },
  "sim.observer": { zh: "旁观", en: "Observe" },
  "sim.observerHint": {
    zh: "旁观模式:AI 自主推进世界演化,玩家只观察(观察/干预双通道)",
    en: "Observer mode: AI advances the world autonomously, you watch",
  },
  "sim.anchorHint": {
    zh: "漂移回锚:把已确立事实钉入上下文,防 AI 跑偏(每 10 条自动)",
    en: "Anchor facts to prevent AI drift (auto every 10 msgs)",
  },

  // ── 翻译引擎(非 AI)──
  "translate.title": { zh: "翻译引擎", en: "Translate Engine" },
  "translate.subtitle": {
    zh: "(专业翻译服务,不消耗对话模型)",
    en: "(dedicated translation service, does not use chat models)",
  },
  "translate.engine": { zh: "引擎", en: "Engine" },
  "translate.engineGoogle": { zh: "Google(免费,无需 Key)", en: "Google (free, no key)" },
  "translate.engineDeepl": { zh: "DeepL(需 API Key)", en: "DeepL (needs API key)" },
  "translate.engineLibre": { zh: "LibreTranslate(自托管)", en: "LibreTranslate (self-hosted)" },
  "translate.engineHint": {
    zh: "酒馆的逐条/自动翻译与测试面板均用此引擎",
    en: "Used by tavern manual/auto translation and this test panel",
  },
  "translate.deeplKey": { zh: "DeepL Key", en: "DeepL Key" },
  "translate.libreUrl": { zh: "服务地址", en: "Server URL" },
  "translate.proxy": { zh: "代理", en: "Proxy" },
  "translate.proxyHint": {
    zh: "国内访问 Google/DeepL 必需(同 SearXNG 的代理);留空直连",
    en: "Required in CN for Google/DeepL; empty = direct",
  },
  "translate.testHint": {
    zh: "测试翻译(默认 Google 免费接口,即时生效)",
    en: "Test translation (uses current engine)",
  },
  "translate.test": { zh: "翻译测试", en: "Translate" },
  "translate.testing": { zh: "翻译中…", en: "Translating…" },

  // ── Plugins ──
  "plugins.title": { zh: "插件管理", en: "Plugins" },
  "plugins.active": { zh: "已启用", en: "Active" },
  "plugins.inactive": { zh: "未启用", en: "Inactive" },
  "plugins.empty": { zh: "暂无插件", en: "No plugins installed" },

  // ── Adapters ──
  "adapter.title": { zh: "API 适配器", en: "API Adapters" },
  "adapter.create": { zh: "新建适配器", en: "Create Custom" },
  "adapter.import": { zh: "导入 JSON", en: "Import JSON" },
  "adapter.templates": { zh: "我的模板", en: "My Templates" },
  "adapter.presets": { zh: "预设", en: "Presets" },

  // ── Error ──
  "error.title": { zh: "出错了", en: "Something went wrong" },
  "error.reload": { zh: "重新加载", en: "Reload" },

  // ── Onboarding ──
  "onboarding.step1": { zh: "① 点击右上角 ⚙ 进入设置", en: "Step 1: Click ⚙ to open Settings" },
  "onboarding.step2": {
    zh: "② 添加 AI 模型（名称、API地址、密钥）",
    en: "Step 2: Add an AI model (name, API URL, key)",
  },
  "onboarding.step3": { zh: "③ 新建对话，开始聊天！", en: "Step 3: Start a new chat and talk!" },
};

/** Non-reactive lookup — safe outside React (stores, event handlers) */
export function t(key: string, vars?: Record<string, string | number>): string {
  const locale = useAppConfigStore.getState?.()?.locale || "zh";
  let s = translations[key]?.[locale] || translations[key]?.en || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}

// Hook version for reactive components (stable reference — safe in memo/useMemo deps)
export function useT() {
  const locale = useAppConfigStore((s) => s.locale);
  return useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let s = translations[key]?.[locale] || translations[key]?.en || key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }
      return s;
    },
    [locale]
  );
}
