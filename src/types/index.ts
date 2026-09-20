// ── Message ──────────────────────────────────────────────
export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  /** Model name that produced this message (empty for user/system) — used for multi-model comparison */
  model?: string | undefined;
  /** Thinking/reasoning text from reasoning models (e.g. DeepSeek v4) */
  reasoning?: string | undefined;
  /** Monotonic per-conversation insertion order — stabilizes ordering of same-ms messages */
  seq?: number | undefined;
  /** Stream/request error of a failed assistant message — rendered as a banner,
   *  kept separate from `content` so failures don't pollute the body */
  error?: string | undefined;
  /** 错误分类（错误命名化）：rate_limit / timeout / auth / overload / rejected / unknown */
  errorKind?: string | undefined;
  /** 消息书签：长会话内标记关键消息，侧栏「书签」面板一键跳回 */
  bookmarked?: boolean | undefined;
  /** 酒馆模式内置翻译:AI 回复的中文/目标语言译文(独立于原文保存) */
  translation?: string | undefined;
  /** Swipe 滑卡:该回复的历史版本(第一版 = 首次生成;开场白含 alternate_greetings) */
  variants?: string[] | undefined;
  /** 当前显示的版本下标(默认 0) */
  variantIndex?: number | undefined;
}

// ── Model / API ──────────────────────────────────────────
export interface ModelConfig {
  name: string;
  provider: string; // adapter id
  api_url: string;
  api_key: string;
  model: string;
  parameters?: ModelParameters;
}

export interface ModelParameters {
  temperature?: number;
  max_tokens?: number;
  /** 模型上下文窗口(token 预算系统:总量 = context_window × usage_pct;缺省保守 8192) */
  context_window?: number;
  top_p?: number;
  top_k?: number;
  /** 本地后端(vLLM/llama.cpp)扩展采样器 */
  repetition_penalty?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  min_p?: number;
  /** DRY / Mirostat (llama.cpp 本地端点) */
  mirostat?: number; // 0=关 1/2=开
  mirostat_tau?: number; // 默认 5.0
  mirostat_eta?: number; // 默认 0.1
  dry_multiplier?: number; // 默认 0.8
  dry_base?: number; // 默认 1.75
  dry_allowed_length?: number; // 默认 2
  dry_penalty_last_n?: number; // 默认 -1(全部)
}

/** 采样器预设(酒馆 API 响应配置存档):温度/top_p/top_k/重复惩罚等 */
export interface SamplerPreset {
  id: string;
  name: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  min_p?: number;
  mirostat?: number;
  mirostat_tau?: number;
  mirostat_eta?: number;
  dry_multiplier?: number;
  dry_base?: number;
  dry_allowed_length?: number;
  dry_penalty_last_n?: number;
}

/** 模型包装器预设:模型 + 知识库 + 工具集 + 人设 打包成可切换预设(Open WebUI 式) */
export interface ModelWrapper {
  id: string;
  name: string;
  description: string;
  modelName: string;
  kbId?: string;
  systemPrompt?: string;
  created_at: string;
}

/** 三层指令作用域:项目级指令(全局 < 项目/知识库 < 会话) */
export interface ProjectInstruction {
  id: string;
  name: string;
  kbId?: string;
  instruction: string;
  created_at: string;
}

/** Token 预算系统配置:监控 + 手动/自动双模式(默认自动) */
export interface BudgetConfig {
  /** auto = 发送前按优先级自动收缩;manual = 只监控提示不自动砍 */
  mode: "auto" | "manual";
  /** 上下文窗口使用率(%)——总量 = context_window × usage_pct / 100 */
  usage_pct: number;
  /** 缺省上下文窗口(模型未配置 context_window 时用) */
  default_context_window: number;
}

/** 连接配置档案(酒馆 Connection Profiles):一套 API 连接信息,一键应用到当前模型 */
export interface ConnectionProfile {
  id: string;
  name: string;
  api_url: string;
  api_key: string;
  model: string;
  created_at: string;
}

// ── Conversation ─────────────────────────────────────────
export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  model_name: string;
  messages: Message[];
  system_prompt?: string | undefined;
  /** Bound character card id (角色扮演). Empty for normal chats. */
  character_id?: string | undefined;
  /** Bound persona id (用户扮演). Empty = use the global active persona. */
  persona_id?: string | undefined;
  /** 会话级世界书绑定/摘要(RP 会话,与 tavern 对齐) */
  lorebookIds?: string[] | undefined;
  summary?: string | undefined;
  /** 自动记忆(工作模式):摘要时的消息数记账,距上次总结新增消息数判定 */
  summary_msg_count?: number | undefined;
}

// ── Character cards (角色扮演 / 酒馆风格) ────────────────
export interface LoreEntry {
  /** Trigger keywords (case-insensitive substring match against recent chat) */
  keys: string[];
  /** Optional secondary keys (AND/NOT refinement) — kept for card compatibility */
  keyssecondary?: string[] | undefined;
  content: string;
  /** Always injected regardless of keywords */
  constant?: boolean | undefined;
  /** Only injected when secondary keys also match */
  selective?: boolean | undefined;
  /** Numeric insertion order — larger = injected later */
  insertion_order?: number | undefined;
  /** before_char | after_char — kept for card compatibility */
  position?: string | undefined;
  enabled?: boolean | undefined;
  comment?: string | undefined;
  /** 关键词大小写敏感(酒馆 Case Sensitive) */
  case_sensitive?: boolean | undefined;
  /** 命中后按概率注入,0-100(酒馆 Probability);缺省/100 = 恒注入 */
  probability?: number | undefined;
  /** 递归激活:条目内容引用其他条目关键词时连锁拉入(酒馆 Recursion) */
  recursive?: boolean | undefined;
  /** 关键词按正则匹配(酒馆 World Info regex;编译失败回退字面量) */
  regex?: boolean | undefined;
  /** 关键词全词匹配(酒馆 Match Whole Words):ASCII 词按词边界匹配;中文无词边界退化为包含 */
  match_whole_words?: boolean | undefined;
  /** 最小激活次数(酒馆 Min Activations):关键词在扫描文本出现 ≥ N 次才注入,缺省 1 */
  min_activations?: number | undefined;
  /** 常驻(酒馆 Timed WI sticky):命中后保持常驻上下文,直到软重置/手动清除 */
  sticky?: boolean | undefined;
  /** 冷却(酒馆 Timed WI cooldown):命中后接下来 N 轮不重复注入 */
  cooldown?: number | undefined;
}

export interface CharacterBook {
  name?: string | undefined;
  description?: string | undefined;
  scan_depth?: number | undefined;
  token_budget?: number | undefined;
  entries: LoreEntry[];
}

export interface CharacterCard {
  id: string;
  /** spec version detected on import: "" (V1 flat) | "2" | "3" */
  specVersion: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  tags: string[];
  creator: string;
  character_version: string;
  character_book?: CharacterBook | undefined;
  /** 酒馆扩展数据(含 emotions 表情配置:extensions.emotions.{key}.{name,source}) */
  extensions?: Record<string, unknown> | undefined;
  /** V3 扩展:深度提示词(酒馆 Depth Prompt)——对话进行到第 N 条消息时注入
   *  该提示(如中段作者注/转折指令);对话未到深度时不激活 */
  depth_prompt?: { depth: number; prompt: string } | undefined;
  /** Absolute path of the avatar PNG (empty = none) */
  avatarPath: string;
  /** 绑定的 RP 提示词预设 id(自定义,导出时忽略,酒馆兼容) */
  presetId?: string | undefined;
  /** 绑定的独立世界书 id 列表(角色级,发送时与全局/内嵌/Persona/会话合并) */
  lorebookIds?: string[] | undefined;
  favorite?: boolean | undefined;
  created_at: string;
  updated_at: string;
}

/** 用户自己的角色扮演 —— 酒馆 Persona:名称 + 描述 + 头像 */
export interface Persona {
  id: string;
  name: string;
  description: string;
  /** Absolute path of the persona avatar PNG (empty = none) */
  avatarPath: string;
  /** 绑定的世界书 id 列表(我的角色可同时启用多本;旧单值字段的迁移见 load) */
  lorebookIds?: string[] | undefined;
  /** 兼容旧数据:单值绑定(读取时并入 lorebookIds) */
  lorebookId?: string | undefined;
  created_at: string;
}

/** 角色扮演提示词预设(主提示词模板) */
export interface PromptPreset {
  id: string;
  name: string;
  description: string;
  /** Template with {{char}}/{{user}}/{{description}}/{{personality}}/… placeholders */
  template: string;
  is_preset: boolean;
  created_at: string;
}

/** 酒馆模式 RP 会话(独立存储于 %APPDATA%\com.my-chat\tavern\*.json,
 *  与工作模式 sled 完全隔离,互不干扰) */
export interface TavernConversation {
  id: string;
  character_id: string;
  character_name: string;
  /** 绑定的 Persona id({{user}} 宏 = 该 Persona 名);空 = 全局激活 */
  persona_id?: string | undefined;
  /** 会话绑定的模型名(共用工作模式的模型配置);空 = 用全局 activeModel */
  model_name?: string | undefined;
  /** 会话绑定的采样器预设 id(酒馆 API 响应配置);空 = 模型参数 ?? 全局默认 */
  samplerPresetId?: string | undefined;
  /** 会话额外启用的世界书 id 列表(聊天级绑定,酒馆 Chat Lore) */
  lorebookIds?: string[] | undefined;
  /** 自动生成的对话摘要(酒馆 Summarize:历史超阈值自动总结,省 token 保记忆) */
  summary?: string | undefined;
  /** 自动记忆记账:上次摘要时的消息数(距上次总结新增消息数判定,防每轮重复总结) */
  summary_msg_count?: number | undefined;
  /** 双记忆槽(26):Author's Note 第二槽——插靠近生成处(当前指令,短程控制) */
  note?: string | undefined;
  /** Author's Note 插入深度(酒馆 note_depth):聊天内模式在第 N 条消息后插入 */
  note_depth?: number | undefined;
  /** Author's Note 插入位置(酒馆 note_position):"in_chat"= 聊天内 / "prompt"= prompt 尾部 */
  note_position?: "in_chat" | "prompt" | undefined;
  /** Author's Note 消息角色(酒馆 note_role):system / user / assistant */
  note_role?: "system" | "user" | "assistant" | undefined;
  /** 会话消息变量(酒馆 {{var::name}} 宏):发送时替换 prompt 与消息中的 {{var::x}} */
  variables?: Record<string, string> | undefined;
  /** 定时世界书状态(酒馆 Timed WI):sticky 条目内容常驻列表 + 冷却剩余轮数 */
  timedLore?: { stickyContents: string[]; cooldownLeft: Record<string, number> } | undefined;
  /** 钉住区(40):关键承诺/伏笔/人物关系钉入常驻上下文(稳定前缀区,缓存友好) */
  pinned?: string | undefined;
  /** 群聊:角色 id 列表(单角色会话为空,用 character_id) */
  groupCharIds?: string[] | undefined;
  /** 群聊:当前选中发言的角色 id(手动模式) */
  activeCharId?: string | undefined;
  /** 群聊:自动回应开关(true = AI 自选角色回复,酒馆群聊默认) */
  autoRespond?: boolean | undefined;
  /** 群聊说话队列:自动模式下当前轮到发言的角色下标(groupCharIds 顺序);手动模式忽略 */
  queueIndex?: number | undefined;
  /** 数据银行/聊天附件(酒馆 Data Bank):会话级附件笔记,发送时注入上下文 */
  attachments?: { id: string; name: string; content: string; created_at: string }[] | undefined;
  title: string;
  created_at: string;
  updated_at: string;
  messages: Message[];
}

// ── 推演模式(酒馆子模式,故事推演) ──────────────────────
/** 推演形态:剧情推演(互动叙事)/ 世界沙盒(时间演化)/ 战术行动(数值裁定) */
export type SimType = "story" | "sandbox" | "tactical";
/** 世界状态跟踪:轻状态文本 / 重状态键值表 / 纯叙事不跟踪 */
export type SimStateMode = "text" | "table" | "none";
/** 推演节奏:回合制+可连续 / 时间步进 / 自动连续推演 */
export type SimPacing = "turn" | "time" | "auto";
/** 世界状态更新策略:每轮自动刷 / 惰性(手动或每 N 轮) / 从推演输出内嵌解析 */
export type SimStateUpdate = "every" | "lazy" | "inline";

/** 事件时间线条目(推演大事记,可回看/手动增删) */
export interface TimelineEntry {
  time: string;
  event: string;
  /** 时间线分层(38):event=叙事事件(上时间线) / log=自动状态日志(可折叠) / milestone=里程碑(高亮) */
  kind?: "event" | "log" | "milestone" | undefined;
}

/** 酒馆推演模式会话(独立存储于 %APPDATA%\com.my-chat\simulation\*.json,
 *  与工作模式 sled、酒馆角色扮演 tavern\*.json 完全隔离) */
export interface SimulationConversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: Message[];
  /** 推演形态:剧情推演 / 世界沙盒 / 战术行动 */
  type: SimType;
  /** 世界状态跟踪:轻状态文本 / 重状态表 / 纯叙事 */
  stateMode: SimStateMode;
  /** 推演节奏:回合制 / 时间步进 / 自动连续 */
  pacing: SimPacing;
  /** 世界状态更新策略:每轮 / 惰性 / 内嵌解析 */
  stateUpdate: SimStateUpdate;
  /** 自动连续推演轮数(continueRounds 默认轮数,创建时可调) */
  autoRounds: number;
  /** 世界观 / 背景 / 规则设定(稳定前缀源,推演指令始终携带) */
  setup: string;
  /** 轻状态:当前世界状态文本(可编辑,每轮自动更新) */
  worldState: string;
  /** 重状态:势力 / 人物 / 资源键值表(可编辑) */
  stateTable: Record<string, string>;
  /** 时间线位置(如 "第 3 天" / "1204 年秋") */
  timeLabel: string;
  /** 事件时间线(大事记,倒序展示) */
  timeline: TimelineEntry[];
  /** 会话绑定的模型名(共用工作模式模型配置);空 = 用全局 activeModel */
  model_name?: string | undefined;
  /** 会话绑定的采样器预设 id;空 = 模型参数 ?? 全局默认 */
  samplerPresetId?: string | undefined;
  /** 自动记忆摘要(复用 V0.6 记账式阈值) */
  summary?: string | undefined;
  /** 自动记忆记账:上次摘要时的消息数 */
  summary_msg_count?: number | undefined;
  /** 惰性状态同步记账:距上次同步的推演次数(>=5 自动刷,手动同步归零) */
  stateSyncCount?: number | undefined;
  /** 双记忆槽(26):Author's Note 第二槽——插靠近生成处(当前指令,短程控制) */
  note?: string | undefined;
  /** 钉住区(40):关键承诺/伏笔/人物关系钉入常驻上下文(稳定前缀区,缓存友好) */
  pinned?: string | undefined;
  /** 漂移回锚(39):回锚摘要快照(距上次回锚 N 回合自动产出,可一键回滚) */
  anchor?: string | undefined;
  /** 漂移回锚记账:上次回锚时的消息数 */
  anchor_msg_count?: number | undefined;
  /** 观察/干预双通道(43):沙盒旁观模式——true 时 AI 自主推进,玩家只观察 */
  observerMode?: boolean | undefined;
}

// ── Skills / Agent ───────────────────────────────────────
export interface Skill {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  temperature: number | null;
  category: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  /** 绑定的 MCP 工具 JSON 数组字符串（Agent 能力），如 ["server/tool"] */
  tools_json?: string;
  /** 绑定的记忆标签 JSON 数组字符串（Agent 记忆） */
  memory_tags?: string;
}

// ── Knowledge Base ───────────────────────────────────────
export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  created_at: string;
  /** 知识源元数据(认证/新鲜度徽标):source_type(文档/网页/导入)、verified(已验证)、source_url */
  meta?: { source_type?: string; verified?: boolean; source_url?: string };
}

export interface KnowledgeFile {
  name: string;
  content: string;
}

// ── Adapter / Provider ───────────────────────────────────
export type AdapterMode = "simple" | "medium" | "advanced";

export interface ApiTemplate {
  id: string;
  name: string;
  mode: AdapterMode;
  api_url: string;
  api_key_encrypted?: string;

  // Request config
  request_method: "POST" | "GET";
  request_headers: Record<string, string>;
  request_body_template: string;

  // SSE config
  sse_enabled: boolean;
  sse_data_prefix: string;
  sse_done_marker: string;
  sse_content_path: string;

  // Response config
  response_content_path: string;

  // Metadata
  category: string;
  is_preset: boolean;
  created_at: string;
  updated_at: string;
}

// ── Plugin ───────────────────────────────────────────────
export interface ChatPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  installed_at: string;
  manifest: PluginManifest;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  main: string;
  contributes?: PluginContribution;
}

export interface PluginContribution {
  commands?: PluginCommand[];
  skills?: SkillDefinition[];
  settings?: SettingSchema[];
}

export interface PluginCommand {
  id: string;
  title: string;
  handler: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  systemPrompt: string;
}

export interface SettingSchema {
  key: string;
  type: "string" | "number" | "boolean";
  default: unknown;
  description: string;
}

// ── Stream ───────────────────────────────────────────────
export interface StreamEvent {
  done: boolean;
  content: string;
  /** Reasoning/thinking text from reasoning models (e.g. DeepSeek v4) */
  reasoning?: string;
}

export interface ChatRequest {
  model_config: ModelConfig;
  messages: Pick<Message, "role" | "content">[];
  temperature?: number | null | undefined;
  /** Max output tokens (global default parameters) — sent only when set */
  max_tokens?: number | null | undefined;
  /** Samplers (酒馆 API 响应配置) — sent only when set */
  top_p?: number | null | undefined;
  top_k?: number | null | undefined;
  repetition_penalty?: number | null | undefined;
  frequency_penalty?: number | null | undefined;
  presence_penalty?: number | null | undefined;
  min_p?: number | null | undefined;
  mirostat?: number | null | undefined;
  mirostat_tau?: number | null | undefined;
  mirostat_eta?: number | null | undefined;
  dry_multiplier?: number | null | undefined;
  dry_base?: number | null | undefined;
  dry_allowed_length?: number | null | undefined;
  dry_penalty_last_n?: number | null | undefined;
  system_prompt?: string | undefined;
  knowledge_context?: string | undefined;
  /** Thinking mode for reasoning models (DeepSeek v4): true=enabled, false=disabled, undefined=server default */
  thinking_enabled?: boolean | undefined;
  /** Reasoning effort: "low" | "medium" | "high" | "max" */
  reasoning_effort?: string | undefined;
  /** Stopping strings (酒馆 Stopping Strings): 生成到这些串时提前终止 */
  stopping_strings?: string[] | null | undefined;
  /** Custom API template — when present, request is built/parsed from the template */
  template?: ApiTemplate | undefined;
}

// ── Tauri IPC DTOs (mirrors the Rust command structs) ────
// The invoke layer returns `any`; typing the DTOs here removes the
// no-explicit-any noise from the stores.

export interface DbConvDto {
  id: string;
  title: string;
  model_name: string;
  system_prompt: string;
  created_at: string;
  updated_at: string;
  character_id?: string;
  persona_id?: string;
  /** 自动记忆摘要(工作/酒馆自动记忆持久化) */
  summary?: string;
  /** 摘要时的消息数记账(距上次总结新增消息数判定) */
  summary_msg_count?: number;
}

export interface DbMsgDto {
  id: string;
  conv_id: string;
  role: string;
  content: string;
  timestamp: string;
  token_count: number;
  model?: string;
  reasoning?: string;
  seq?: number;
  error?: string;
  /** 错误分类（错误命名化）：rate_limit / timeout / auth / overload / rejected / unknown */
  error_kind?: string;
  /** 消息书签 */
  bookmarked?: boolean;
}

export interface DbModelDto {
  name: string;
  provider: string;
  api_url: string;
  /** Encrypted (ENC:…) or — via list_models_decrypted — plaintext key */
  api_key_encrypted: string;
  model: string;
  params_json: string;
}

export interface DbSkillDto {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  model: string;
  temperature: number | null;
  category: string;
  tags_json: string;
  created_at: string;
  updated_at: string;
  tools_json?: string;
  memory_tags?: string;
}

export interface McpServerDto {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
  created_at: string;
}

export interface McpToolDto {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface McpToolResultDto {
  ok: boolean;
  content: string;
  /** MCP Apps 富 UI:工具声明的 ui:// 资源 HTML(沙箱 iframe 渲染) */
  ui_html?: string;
}

export interface BackupInfoDto {
  name: string;
  path: string;
  ts: number;
  size_mb: number;
}

// ── Theme ────────────────────────────────────────────────
export type ThemeMode = "light" | "dark" | "system";
