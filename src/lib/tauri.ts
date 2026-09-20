// lib/tauri.ts — Tauri IPC bridge (typed wrappers over the Rust commands)

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  StreamEvent,
  ChatRequest,
  DbConvDto,
  DbMsgDto,
  DbModelDto,
  DbSkillDto,
  McpServerDto,
  McpToolDto,
  McpToolResultDto,
  BackupInfoDto,
} from "@/types";

// ── Chat ────────────────────────────────────────────────
// Each in-flight stream is keyed by its frontend-generated request_id,
// so multiple models can stream in parallel (one question → N answers).
interface StreamHandlers {
  onToken: (d: string) => void;
  /** Reasoning/thinking tokens from reasoning models */
  onReasoning?: ((d: string) => void) | undefined;
  onDone: (cache?: { hit: number; miss: number }) => void;
  onError: (e: string) => void;
}

let chatUnlisten: UnlistenFn | null = null;
const streams = new Map<string, StreamHandlers>();

function ensureListener(): Promise<void> {
  if (chatUnlisten) return Promise.resolve();
  return listen<
    StreamEvent & { request_id?: string; cache_hit_tokens?: number; cache_miss_tokens?: number }
  >("chat-stream", (event) => {
    const { request_id, done, content, reasoning, cache_hit_tokens, cache_miss_tokens } =
      event.payload;
    if (!request_id) return;
    const h = streams.get(request_id);
    if (!h) return; // Unknown/aborted stream
    if (done) {
      h.onDone(
        cache_hit_tokens || cache_miss_tokens
          ? { hit: cache_hit_tokens || 0, miss: cache_miss_tokens || 0 }
          : undefined
      );
      streams.delete(request_id);
    } else {
      if (reasoning) h.onReasoning?.(reasoning);
      if (content) h.onToken(content);
    }
  }).then((un) => {
    chatUnlisten = un;
  });
}

export async function streamChat(
  request: ChatRequest,
  requestId: string,
  handlers: {
    onToken: (d: string) => void;
    onReasoning?: (d: string) => void;
    onDone: (cache?: { hit: number; miss: number }) => void;
    onError: (e: string) => void;
  }
): Promise<void> {
  const { onToken, onReasoning, onDone, onError } = handlers;
  streams.set(requestId, { onToken, onReasoning, onDone, onError });

  // Report any failure in this layer to the backend log so the root cause
  // can be read from chat_errors.log even when stream_chat never runs.
  const diag = (stage: string, e: unknown) => {
    const msg = `${stage} err=${JSON.stringify(String(e ?? "null"))} url=${request.model_config.api_url} model=${request.model_config.model}`;
    logDiag(msg);
  };

  try {
    await ensureListener();
  } catch (e) {
    diag("listen", e);
    streams.delete(requestId);
    onError(String(e));
    return;
  }
  try {
    await invoke("stream_chat", { request: { ...request, request_id: requestId } });
  } catch (e) {
    diag("invoke", e);
    streams.delete(requestId);
    onError(String(e));
  }
}

/** Cancel a specific stream (true abort: signals Rust + drops the listener) */
/**
 * 把一条诊断写进后端 `chat_errors.log`。
 *
 * 非流式路径（渲染层、导入导出等）没有 `streamChat` 内部那个 `diag` 可用，
 * 需要一条公共通道 —— 否则这些地方只能 `console.error`，而 webview 的控制台
 * 用户根本看不到，等于没记。
 *
 * 落盘失败就放弃（避免「记日志失败 → 再记日志」的递归）——这里是有意为之的静默。
 */
export function logDiag(message: string): void {
  invoke("log_diag", { message }).catch(() => {
    // 有意静默：这一层就是日志自身的出口，它失败时再记日志会无限递归。
    // 全仓最后一处「空 catch」就是这里，且是唯一合理的一处。
  });
}

export function cancelChat(requestId: string): void {
  streams.delete(requestId);
  invoke("cancel_chat", { requestId }).catch((e: unknown) => {
    // 取消失败意味着那条流可能还在跑 —— 必须留痕，否则用户以为停了其实没停
    logDiag(`cancel_chat failed: ${String(e)} request_id=${requestId}`);
  });
}

// ── 错误分类（错误命名化）──────────────────────────────
// Rust 侧把上游错误统一格式化为 `API error {status}: {text}`，前端在这里按
// 类型归类，让气泡能按 kind 渲染差异化文案与重试建议（限流/超时/拒绝/未知）。

export type ErrorKind = "rate_limit" | "timeout" | "rejected" | "auth" | "overload" | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
}

/** 把错误字符串分类为结构化错误（带 kind），用于差异化横幅渲染 */
export function classifyError(raw: string): ClassifiedError {
  const s = raw || "";
  const lower = s.toLowerCase();
  if (/429|rate.?limit|too many/i.test(lower)) return { kind: "rate_limit", message: s };
  if (/timeout|timed out|deadline|took too long|etimedout/i.test(lower))
    return { kind: "timeout", message: s };
  if (/401|403|unauthorized|forbidden|invalid api key|permission/i.test(lower))
    return { kind: "auth", message: s };
  if (/503|502|overloaded|capacity|busy|temporarily unavailable|server error/i.test(lower))
    return { kind: "overload", message: s };
  if (/refused|rejected|econnrefused|connection refused|certificate|ssl|dns/i.test(lower))
    return { kind: "rejected", message: s };
  return { kind: "unknown", message: s };
}

/** 错误横幅标题（按 kind）——供 MessageBubble 差异化渲染 */
export function errorTitle(kind: ErrorKind): string {
  switch (kind) {
    case "rate_limit":
      return "请求被限流 (429)";
    case "timeout":
      return "请求超时";
    case "auth":
      return "认证失败 (401/403)";
    case "overload":
      return "服务过载 (5xx)";
    case "rejected":
      return "连接被拒绝";
    default:
      return "请求失败";
  }
}

/** 错误重试建议（按 kind）——差异化提示文案 */
export function errorHint(kind: ErrorKind): string | null {
  switch (kind) {
    case "rate_limit":
      return "稍后再试，或切换更快/更便宜模型";
    case "timeout":
      return "可点「重试」重新生成";
    case "auth":
      return "检查 API Key 是否正确";
    case "overload":
      return "模型过载，稍后再试或切换模型";
    case "rejected":
      return "检查网络/代理连接";
    default:
      return null;
  }
}

// ── DB: Conversations ────────────────────────────────────
export function dbCreateConv(conv: Partial<DbConvDto>): Promise<void> {
  return invoke("create_conv", { conv });
}
export function dbListConvs(): Promise<DbConvDto[]> {
  return invoke("list_convs");
}
/** P1-3 启动批量化：一次返回全部会话 + 全部消息（替代 N+1 次 list_msgs） */
export function dbLoadAll(): Promise<{
  conversations: DbConvDto[];
  messages: Record<string, DbMsgDto[]>;
}> {
  return invoke("load_all");
}
export function dbDeleteConv(id: string): Promise<void> {
  return invoke("delete_conv", { id });
}
export function dbRenameConv(id: string, title: string, updatedAt: string): Promise<void> {
  return invoke("rename_conv", { id, title, updatedAt });
}
/** 批量删除会话:一次 IPC 删除多个会话及其消息 */
export function dbBatchDeleteConvs(ids: string[]): Promise<void> {
  return invoke("batch_delete_convs", { ids });
}
/** 消息书签:切换单条消息书签状态(长会话快速跳回) */
export function dbSetMsgBookmark(id: string, convId: string, bookmarked: boolean): Promise<void> {
  return invoke("set_msg_bookmark", { id, convId, bookmarked });
}
/** 自动记忆:持久化会话摘要 + 摘要时的消息数记账(轻量,不重写其他字段) */
export function dbUpdateConvSummary(
  id: string,
  summary: string,
  summaryMsgCount: number,
  updatedAt: string
): Promise<void> {
  return invoke("update_conv_summary", { id, summary, summaryMsgCount, updatedAt });
}
export function dbAddMsg(msg: Partial<DbMsgDto>): Promise<void> {
  return invoke("add_msg", { msg });
}
/** P1 热路径批量化：一次 IPC 插入多条消息 + 更新会话标题/时间戳 */
export function dbBatchAddMessages(
  convId: string,
  msgs: Partial<DbMsgDto>[],
  title: string,
  updatedAt: string
): Promise<void> {
  return invoke("batch_add_messages", { convId, msgs, title, updatedAt });
}
export function dbListMsgs(convId: string): Promise<DbMsgDto[]> {
  return invoke("list_msgs", { convId });
}
export function dbUpdateMsgContent(id: string, convId: string, content: string): Promise<void> {
  return invoke("update_msg_content", { id, convId, content });
}
export function dbUpdateMsgReasoning(id: string, convId: string, reasoning: string): Promise<void> {
  return invoke("update_msg_reasoning", { id, convId, reasoning });
}
export function dbUpdateMsgError(
  id: string,
  convId: string,
  error: string,
  errorKind: string = ""
): Promise<void> {
  return invoke("update_msg_error", { id, convId, error, errorKind });
}
export function dbDeleteLastAsmMsg(convId: string): Promise<void> {
  return invoke("delete_last_asm_msg", { convId });
}
export function dbClearMessages(convId: string): Promise<void> {
  return invoke("clear_messages", { convId });
}

// ── DB: Models / Settings ────────────────────────────────
export function dbSaveModel(model: Partial<DbModelDto>): Promise<void> {
  return invoke("save_model", { model });
}
export function dbListModels(): Promise<DbModelDto[]> {
  return invoke("list_models");
}
/** List models with API keys already decrypted on the Rust side */
export function dbListModelsDecrypted(): Promise<DbModelDto[]> {
  return invoke("list_models_decrypted");
}
export function dbDeleteModel(name: string): Promise<void> {
  return invoke("delete_model", { name });
}
export function dbDeleteAllModels(): Promise<void> {
  return invoke("delete_all_models");
}
export function dbGetSetting(key: string): Promise<string> {
  return invoke("get_setting", { key });
}
export function dbSaveSetting(key: string, value: string): Promise<void> {
  return invoke("save_setting", { key, value });
}

// ── DB: Skills ───────────────────────────────────────────
export function dbCreateSkill(skill: Partial<DbSkillDto>): Promise<void> {
  return invoke("create_skill", { skill });
}
export function dbListSkills(): Promise<DbSkillDto[]> {
  return invoke("list_skills");
}
export function dbUpdateSkill(skill: Partial<DbSkillDto>): Promise<void> {
  return invoke("update_skill", { skill });
}
export function dbDeleteSkill(id: string): Promise<void> {
  return invoke("delete_skill_cmd", { id });
}

// ── DB: Status ───────────────────────────────────────────
export function dbGetStatus(): Promise<string> {
  return invoke("get_db_status");
}

// ── File system ──────────────────────────────────────────
export function getAppDir(): Promise<string> {
  return invoke("get_app_dir");
}
export function readFile(path: string): Promise<string> {
  return invoke("read_file", { path });
}
export function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}
export function deleteItem(path: string): Promise<void> {
  return invoke("delete_item", { path });
}
export function listDir(path: string): Promise<string[]> {
  return invoke("list_dir", { path });
}
export function createDir(path: string): Promise<void> {
  return invoke("create_dir", { path });
}

// ── MCP (Model Context Protocol) ─────────────────────────
export function mcpListServers(): Promise<McpServerDto[]> {
  return invoke("mcp_list_servers");
}
export function mcpSaveServer(server: Partial<McpServerDto>): Promise<void> {
  return invoke("mcp_save_server", { server });
}
export function mcpDeleteServer(id: string): Promise<void> {
  return invoke("mcp_delete_server", { id });
}
export function mcpListTools(serverId: string): Promise<McpToolDto[]> {
  return invoke("mcp_list_tools", { serverId });
}
export function mcpCallTool(
  serverId: string,
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<McpToolResultDto> {
  return invoke("mcp_call_tool", { serverId, toolName, arguments: toolArgs });
}
// ── MCP 权限 + 审计 + 临时授权(18/19)──────────────────
export interface McpPermissionDto {
  server_id: string;
  tool: string;
  action: string; // allow | ask | deny
}
export interface McpGrantDto {
  server_id: string;
  tool: string;
  expires_at: number;
}
export interface McpAuditDto {
  ts: number;
  server_id: string;
  server_name: string;
  tool: string;
  args_preview: string;
  ok: boolean;
}
export function mcpSetPermission(serverId: string, tool: string, action: string): Promise<void> {
  return invoke("mcp_set_permission", { serverId, tool, action });
}
export function mcpListPermissions(): Promise<McpPermissionDto[]> {
  return invoke("mcp_list_permissions");
}
export function mcpGrantTool(serverId: string, tool: string, grantMinutes: number): Promise<void> {
  return invoke("mcp_grant_tool", { serverId, tool, grantMinutes });
}
export function mcpRevokeTool(serverId: string, tool: string): Promise<void> {
  return invoke("mcp_revoke_tool", { serverId, tool });
}
export function mcpListGrants(): Promise<McpGrantDto[]> {
  return invoke("mcp_list_grants");
}
export function mcpAudit(limit: number): Promise<McpAuditDto[]> {
  return invoke("mcp_audit", { limit });
}

// ── Backup / WebDAV ──────────────────────────────────────
export function createBackup(destDir: string): Promise<string> {
  return invoke("create_backup", { destDir });
}
export function listBackups(destDir: string): Promise<BackupInfoDto[]> {
  return invoke("list_backups", { destDir });
}
export function restoreBackup(backupDir: string): Promise<string> {
  return invoke("restore_backup", { backupDir });
}
export function webdavUpload(
  url: string,
  username: string,
  password: string,
  filePath: string
): Promise<void> {
  return invoke("webdav_upload", { url, username, password, filePath });
}

// ── RAG ─────────────────────────────────────────────────

/** 结构化检索结果(RAG 引用回链+摘录:来源卡用 kb/file 打开原文) */
export interface RagResult {
  chunk_id: string;
  content: string;
  score: number;
  kb_name: string;
  file_name: string;
}

/**
 * 结构化检索:返回候选片段数组(替代旧的纯文本上下文)。
 * mode: bm25 / vector / hybrid(双模式检索分流——找文档走单轨更快)。
 * provider: keyword(本地哈希)或 openai(需 apiKey)。
 */
export function ragSearch(
  query: string,
  opts?: {
    kbId?: string;
    topK?: number;
    mode?: "bm25" | "vector" | "hybrid";
    provider?: "keyword" | "openai";
    apiKey?: string;
  }
): Promise<RagResult[]> {
  return invoke("rag_search", {
    query: {
      query,
      kb_id: opts?.kbId || null,
      top_k: opts?.topK || 3,
      provider: opts?.provider || "keyword",
      api_key: opts?.apiKey || null,
      mode: opts?.mode || "hybrid",
    },
  });
}

/** LLM rerank(重排):取候选 top-N,喂给配置的模型按相关性打分排序,返回重排后的下标 */
export function ragRerank(
  query: string,
  candidates: string[],
  modelConfig: { api_url: string; api_key: string; model: string }
): Promise<number[]> {
  return invoke("rag_rerank", {
    query,
    candidates,
    apiUrl: modelConfig.api_url,
    apiKey: modelConfig.api_key,
    model: modelConfig.model,
  });
}
export function ragIndexDocument(kbId: string, fileId: string, content: string): Promise<number> {
  return invoke("rag_index_document", {
    req: { kb_id: kbId, file_id: fileId, content, chunk_size: 500, overlap: 50 },
  });
}
/** OpenAI 嵌入索引(接线闲置能力:rag_index_with_openai 此前无前端入口) */
export function ragIndexWithOpenai(
  kbId: string,
  fileId: string,
  content: string,
  apiKey: string
): Promise<number> {
  return invoke("rag_index_with_openai", {
    req: { kb_id: kbId, file_id: fileId, content, chunk_size: 500, overlap: 50 },
    apiKey,
  });
}
export function ragDeleteKb(kbId: string): Promise<void> {
  return invoke("delete_kb", { id: kbId });
}

// ── Docs (文档解析 / OCR / 文件选择) ────────────────────
export function pickFile(filterName?: string, filterExts?: string[]): Promise<string> {
  return invoke("pick_file", { filterName, filterExts });
}
export function extractDocumentText(path: string): Promise<string> {
  return invoke("extract_document_text", { path });
}
export function ocrImage(path: string): Promise<string> {
  return invoke("ocr_image", { path });
}

// ── Memory (白盒记忆) ───────────────────────────────────
export function memList(): Promise<unknown[]> {
  return invoke("mem_list");
}
export function memSave(memory: object): Promise<void> {
  return invoke("mem_save", { memory });
}
export function memDelete(id: string): Promise<void> {
  return invoke("mem_delete", { id });
}
/** 向量记忆检索(27/41):相关性+新鲜度+重要性三维打分,返回带分数的记忆 */
export function memSearch(
  query: string,
  topK = 3
): Promise<{ id: string; content: string; score: number }[]> {
  return invoke("mem_search", { query, topK });
}

// ── Drawing (图片生成) ──────────────────────────────────
export function generateImage(
  url: string,
  apiKey: string,
  prompt: string,
  model: string,
  size: string
): Promise<string> {
  return invoke("generate_image", { url, apiKey, prompt, model, size });
}

// ── Character cards (角色扮演) — binary file I/O ─────────
/** Read a file as base64 (PNG character cards, avatar images) */
export function readFileBytes(path: string): Promise<string> {
  return invoke("read_file_bytes", { path });
}
/** Write a base64 payload to a file (avatar PNGs, exported PNG cards) */
export function writeFileBytes(path: string, base64Data: string): Promise<void> {
  return invoke("write_file_bytes", { path, base64Data });
}

// ── 翻译(非 AI 引擎:Google 免key / DeepL / LibreTranslate) ─
export function translateText(
  text: string,
  targetLang: string,
  engine: string,
  deeplKey: string,
  libreUrl: string,
  proxyUrl: string
): Promise<string> {
  return invoke("translate_text", { text, targetLang, engine, deeplKey, libreUrl, proxyUrl });
}
