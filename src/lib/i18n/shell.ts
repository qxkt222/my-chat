// lib/i18n/shell.ts — 由 i18n.ts 按 key 前缀拆出（自动生成，勿手工搬运 key）
// 条目数：51

export const shellMessages: Record<string, Record<string, string>> = {
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
  "sidebar.characters": { zh: "角色", en: "Characters" },
  "sidebar.startCharacter": {
    zh: "开始与 {name} 的角色扮演对话",
    en: "Start a roleplay chat with {name}",
  },
  "dialog.confirm": { zh: "确定", en: "OK" },
  "dialog.ok": { zh: "确定", en: "OK" },
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
  // ── App ──
  "app.loading": { zh: "加载中...", en: "Loading..." },
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
