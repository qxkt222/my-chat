import { useState, useCallback, useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useConversationStore } from "@/stores/useConversationStore";
import { useChatStore } from "@/stores/useChatStore";
import { useCharacterStore } from "@/stores/useCharacterStore";
import { useKnowledgeStore } from "@/stores/useKnowledgeStore";
import { getAppDir, writeFile } from "@/lib/tauri";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { Download, Search, Hash, Trash2, ArrowDown, BookOpen } from "lucide-react";
import { countConversationTokens, formatTokens } from "@/lib/token-counter";
import { useT } from "@/lib/i18n";
import { showToast } from "@/components/ui/Toast";
import { askConfirm, askPrompt } from "@/components/ui/ConfirmDialog";
import type { Message } from "@/types";

/** Group consecutive assistant messages (one question → N model answers) into rows */
function groupRows(messages: Message[]): Message[][] {
  const rows: Message[][] = [];
  for (const m of messages) {
    const last = rows[rows.length - 1];
    if (m.role === "assistant" && last && last[0]?.role === "assistant") {
      last.push(m);
    } else {
      rows.push([m]);
    }
  }
  return rows;
}

/** 轻量文本相似度(0-1):字符 bigram 重叠 Jaccard——多模型对比分歧标注用 */
function textSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const set = new Set<string>();
    const t = s.toLowerCase();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

/**
 * 多模型对比分歧标注:同一行(同一问题的多模型回答)全部非空且无流式时计算。
 * 任一对相似度 < 0.22 → conflict(分歧,建议人工核验);全部 ≥ 0.4 → consensus;否则 null。
 */
function rowCompareBadge(
  row: Message[],
  streamingIds: Set<string>
): "consensus" | "conflict" | null {
  if (row.length < 2) return null;
  if (row.some((m) => streamingIds.has(m.id))) return null;
  const contents = row
    .filter((m) => m.role === "assistant")
    .map((m) => m.content.trim())
    .filter((c) => c.length > 20);
  if (contents.length < 2) return null;
  let min = 1;
  for (let i = 0; i < contents.length; i++) {
    for (let j = i + 1; j < contents.length; j++) {
      const a = contents[i];
      const b = contents[j];
      if (a && b) min = Math.min(min, textSimilarity(a, b));
    }
  }
  if (min < 0.22) return "conflict";
  if (min >= 0.4) return "consensus";
  return null;
}

export function ChatView() {
  const t = useT();
  // P0-2: 精准 selector — 只订阅关心的字段，避免任何 store 变化都重渲染
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const streamingReasoning = useChatStore((s) => s.streamingReasoning);
  const streamErrors = useChatStore((s) => s.streamErrors);
  const streamMsgMap = useChatStore((s) => s.streamMsgMap);
  const [searchTerm, setSearchTerm] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [quoted, setQuoted] = useState<Message | null>(null);
  // 三态滚动:是否在底部(滚离底部停止跟随 + 显示「回到底部」pill)
  const [atBottom, setAtBottom] = useState(true);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const conv = useMemo(
    () => conversations.find((c) => c.id === activeId),
    [conversations, activeId]
  );
  // 包进 useMemo:避免 conv?.messages 逻辑表达式每次渲染产生新引用,
  // 使下游 useMemo 依赖稳定(react-hooks/exhaustive-deps)
  const messages = useMemo(() => conv?.messages || [], [conv]);

  // 角色扮演渲染上下文:会话绑定的角色卡 + Persona
  const characters = useCharacterStore((s) => s.characters);
  const personas = useCharacterStore((s) => s.personas);
  const activePersonaId = useCharacterStore((s) => s.activePersonaId);
  const rpContext = useMemo(() => {
    if (!conv?.character_id) return null;
    const card = characters.find((c) => c.id === conv.character_id);
    if (!card) return null;
    const persona =
      personas.find((p) => p.id === conv.persona_id) ||
      personas.find((p) => p.id === activePersonaId) ||
      null;
    return { card, persona };
  }, [conv, characters, personas, activePersonaId]);
  const avatarSrc = rpContext?.card.avatarPath ? convertFileSrc(rpContext.card.avatarPath) : null;
  const userAvatarSrc = rpContext?.persona?.avatarPath
    ? convertFileSrc(rpContext.persona.avatarPath)
    : null;

  // P1-1: 流式中的消息用 streamingContent 覆盖显示（实时），其余消息保持原引用
  // → 只有流式那条消息对象变化，MessageBubble 的 memo 才能跳过历史消息。
  // 无流式时直接返回原数组（零开销，不 map）。
  const hasStreaming = useMemo(() => Object.keys(streamMsgMap).length > 0, [streamMsgMap]);
  const displayMessages: Message[] = useMemo(() => {
    if (!hasStreaming) return messages;
    return messages.map((m) => {
      const entry = streamMsgMap[m.id];
      if (entry && streamingContent[entry.requestId] !== undefined) {
        // 流式覆盖:content 恒为字符串(streamingContent 初始化为 ""),此处断言保证类型
        return {
          ...m,
          content: streamingContent[entry.requestId] ?? "",
          reasoning: streamingReasoning[entry.requestId] ?? m.reasoning,
          // F4: 流式错误独立于正文实时合并（气泡横幅渲染）
          error: streamErrors[entry.requestId] ?? m.error,
        } as Message;
      }
      return m;
    });
  }, [messages, hasStreaming, streamMsgMap, streamingContent, streamingReasoning, streamErrors]);

  // 搜索过滤 + 分组（useMemo 缓存，避免每次渲染重建）
  const filteredMessages = useMemo(
    () =>
      searchTerm
        ? displayMessages.filter((m) =>
            (m.content || "").toLowerCase().includes(searchTerm.toLowerCase())
          )
        : displayMessages,
    [displayMessages, searchTerm]
  );
  const rows = useMemo(() => groupRows(filteredMessages), [filteredMessages]);
  const totalTokens = useMemo(() => countConversationTokens(messages), [messages]);

  const exportMarkdown = useCallback(() => {
    if (!conv) return;
    // 导出保留结构:标题层级/列表/代码块(纯 markdown 天然保留)
    let md = `# ${conv.title}\n\n`;
    md += `Date: ${new Date(conv.created_at).toLocaleString()}\n\n---\n\n`;
    for (const msg of conv.messages) {
      const role =
        msg.role === "user" ? t("chat.you") : msg.role === "assistant" ? t("chat.ai") : "System";
      md += `### ${role}${msg.model ? ` (${msg.model})` : ""}\n\n${msg.content}\n\n---\n\n`;
    }
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${conv.title.replace(/[^a-zA-Z0-9]/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [conv, t]);

  // 归档为结构化笔记(22):把会话导出为知识库笔记文件(保留结构,可回流知识库)
  const archiveAsNote = useCallback(async () => {
    if (!conv) return;
    const kbStore = useKnowledgeStore.getState();
    const kbId = kbStore.activeBaseId;
    if (!kbId) {
      showToast("error", t("chat.archiveNeedKb"));
      return;
    }
    let md = `# ${conv.title}\n\n`;
    md += `> 归档自 AI 会话 · ${new Date().toLocaleString()}\n\n---\n\n`;
    for (const msg of conv.messages) {
      const role =
        msg.role === "user" ? t("chat.you") : msg.role === "assistant" ? t("chat.ai") : "System";
      md += `## ${role}${msg.model ? ` (${msg.model})` : ""}\n\n${msg.content}\n\n---\n\n`;
    }
    const appDir = await getAppDir();
    const safeName = conv.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 60);
    await writeFile(`${appDir}/knowledge/${kbId}/${safeName}.md`, md);
    showToast("success", t("chat.archived", { kb: kbId }));
  }, [conv, t]);

  // 话题分叉：复制该消息及之前的全部消息到新会话，激活新会话
  // useCallback 保证引用稳定 → MessageBubble 的 memo 生效
  const handleFork = useCallback(
    async (msg: Message) => {
      const c = conversations.find((x) => x.id === activeId);
      if (!c) return;
      const idx = c.messages.findIndex((m) => m.id === msg.id);
      if (idx < 0) return;
      const slice = c.messages.slice(0, idx + 1);
      const convStore = useConversationStore.getState();
      const newConv = await convStore.create();
      // P1: 分叉批量写库（一次 IPC，替代逐条 addMessage）。注意顺序：
      // batch 会给空会话自动生成标题（首条 user 消息），随后 rename 覆盖为「原标题（分叉）」。
      await convStore.addMessagesBatch(
        newConv.id,
        slice.map((m) => ({
          id: crypto.randomUUID(),
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          model: m.model,
          reasoning: m.reasoning,
          error: m.error,
        }))
      );
      await convStore.rename(newConv.id, `${c.title}（${t("chat.fork")}）`);
      showToast("success", t("chat.forkSuccess", { n: slice.length }));
    },
    [conversations, activeId, t]
  );

  // 消息书签:切换单条消息书签状态(长会话快速跳回)
  const handleToggleBookmark = useCallback(
    (msg: Message) => {
      if (!activeId) return;
      void useConversationStore.getState().toggleBookmark(activeId, msg.id);
    },
    [activeId]
  );

  // 请求失败重试(错误命名化:限流/超时提供重试按钮;重放最后回合)
  const handleRetry = useCallback(() => {
    void useChatStore.getState().regenerate();
  }, []);

  // 消息编辑:弹输入框,改后经 updateMessage 落盘(sled)
  const handleEditMessage = useCallback(
    async (msg: Message) => {
      if (!activeId) return;
      const updated = await askPrompt(t("chat.edit"), msg.content);
      if (updated === null || updated === msg.content) return;
      useConversationStore.getState().updateMessage(activeId, msg.id, updated);
    },
    [activeId, t]
  );

  // 三态滚动:滚离底部时显示「回到底部」pill,点击跳到最后
  const jumpToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    setAtBottom(true);
  }, []);

  // 单行渲染：一问多答并排 或 单条
  const renderRow = useCallback(
    (row: Message[]) => {
      // 多模型对比分歧标注(流式结束后计算,防止每 token 重算)
      const streamingIds = new Set(row.filter((m) => streamMsgMap[m.id]).map((m) => m.id));
      const badge = rowCompareBadge(row, streamingIds);
      const renderMsg = (msg: Message) => (
        <MessageBubble
          message={msg}
          onQuote={setQuoted}
          onFork={handleFork}
          streaming={!!streamMsgMap[msg.id]}
          // 角色扮演:assistant 用角色头像+名,user 用 Persona 头像+名
          rpCharName={rpContext?.card.name}
          rpCharAvatar={avatarSrc}
          rpUserName={rpContext?.persona?.name}
          rpUserAvatar={userAvatarSrc}
          compareBadge={row.length > 1 ? badge : null}
          onToggleBookmark={handleToggleBookmark}
          onRetry={handleRetry}
          onEdit={handleEditMessage}
        />
      );
      if (row.length > 1 && row[0]?.role === "assistant") {
        return (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(${Math.min(row.length, 3)}, 1fr)` }}
          >
            {row.map((msg) => (
              <div key={msg.id} className="min-w-0">
                {renderMsg(msg)}
              </div>
            ))}
          </div>
        );
      }
      return <div>{row.map((msg) => renderMsg(msg))}</div>;
    },
    [
      handleFork,
      streamMsgMap,
      rpContext,
      avatarSrc,
      userAvatarSrc,
      handleToggleBookmark,
      handleRetry,
    ]
  );

  const anyStreamingEmpty =
    isStreaming &&
    Object.keys(streamingContent).length > 0 &&
    Object.values(streamingContent).some((c) => !c);

  // 会话重置(A):清空当前对话消息 + 确认提示
  const handleClear = useCallback(async () => {
    if (!activeId) return;
    if (!(await askConfirm(t("chat.clearConfirm")))) return;
    useConversationStore.getState().clearConversation(activeId);
    showToast("success", t("chat.clearDone"));
  }, [activeId, t]);

  return (
    <div className="flex flex-col h-full">
      {/* 角色信息条(角色扮演会话) */}
      {rpContext && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border bg-primary/5 shrink-0">
          {avatarSrc && (
            <img
              src={avatarSrc}
              alt={rpContext.card.name}
              className="w-5 h-5 rounded-full object-cover"
            />
          )}
          <span className="text-xs font-medium">{rpContext.card.name}</span>
          {rpContext.card.description && (
            <span className="text-[10px] text-muted-foreground truncate">
              {rpContext.card.description}
            </span>
          )}
          <div className="flex-1" />
          {rpContext.persona && (
            <span className="text-[10px] text-muted-foreground">
              {t("chat.rpAs", { name: rpContext.persona.name })}
            </span>
          )}
        </div>
      )}

      {/* Toolbar */}
      {conv && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border bg-muted/30 shrink-0">
          <button
            onClick={exportMarkdown}
            className="px-2 py-0.5 text-[10px] rounded hover:bg-muted text-muted-foreground flex items-center gap-1"
            title={t("chat.export")}
          >
            <Download className="w-3 h-3" /> {t("chat.export")}
          </button>
          <button
            onClick={archiveAsNote}
            className="px-2 py-0.5 text-[10px] rounded hover:bg-muted text-muted-foreground flex items-center gap-1"
            title={t("chat.archiveNote")}
          >
            <BookOpen className="w-3 h-3" /> {t("chat.archiveNote")}
          </button>
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Hash className="w-3 h-3" />
            {formatTokens(totalTokens)} {t("chat.tokens")}
          </span>
          <button
            onClick={handleClear}
            disabled={messages.length === 0}
            className="px-2 py-0.5 text-[10px] rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex items-center gap-1 disabled:opacity-30"
            title={t("chat.clearConversation")}
          >
            <Trash2 className="w-3 h-3" /> {t("chat.clearConversation")}
          </button>
          <div className="flex-1" />
          {showSearch ? (
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t("chat.searchMsg")}
              className="w-48 px-2 py-0.5 text-xs bg-background border border-input rounded"
              autoFocus
              onKeyDown={(e) => e.key === "Escape" && (setShowSearch(false), setSearchTerm(""))}
            />
          ) : (
            <button
              onClick={() => setShowSearch(true)}
              className="px-2 py-0.5 text-[10px] rounded hover:bg-muted text-muted-foreground flex items-center gap-1"
            >
              <Search className="w-3 h-3" /> {t("chat.search")}
            </button>
          )}
        </div>
      )}

      {/* 消息区：虚拟化（只渲染可见行）+ followOutput 流式自动滚动 */}
      <div className="flex-1 min-h-0 relative">
        {!conv ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-muted-foreground">
              <p className="text-lg mb-2">{t("chat.welcome")}</p>
              <p className="text-sm">{t("chat.startHint")}</p>
            </div>
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={rows}
            itemContent={(_, row) => (
              <div className="max-w-3xl mx-auto px-4 py-1.5">{renderRow(row)}</div>
            )}
            // 三态滚动:在底部时跟随(auto=瞬时);用户上滑查看历史时停止,
            // 并显示「回到底部」pill(有内容进来但不在底部时)
            followOutput={(isAtBottom) => (isAtBottom ? "auto" : false)}
            atBottomStateChange={(b) => setAtBottom(b)}
            increaseViewportBy={200}
            components={{
              Footer: () =>
                anyStreamingEmpty ? (
                  <div className="flex items-center gap-1 text-muted-foreground text-sm px-4 py-2 max-w-3xl mx-auto">
                    <span className="animate-pulse-dot w-1.5 h-1.5 bg-primary rounded-full" />
                    <span
                      className="animate-pulse-dot w-1.5 h-1.5 bg-primary rounded-full"
                      style={{ animationDelay: "0.2s" }}
                    />
                    <span
                      className="animate-pulse-dot w-1.5 h-1.5 bg-primary rounded-full"
                      style={{ animationDelay: "0.4s" }}
                    />
                  </div>
                ) : null,
            }}
          />
        )}
        {/* 三态滚动:滚离底部且有新内容时,浮动「回到底部」pill */}
        {conv && !atBottom && (
          <button
            onClick={jumpToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-card border border-border shadow-md text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 z-10"
            title={t("chat.jumpToBottom")}
          >
            <ArrowDown className="w-3 h-3" />
            {t("chat.jumpToBottom")}
          </button>
        )}
      </div>

      {/* Input area */}
      {conv && <ChatInput quoted={quoted} onClearQuote={() => setQuoted(null)} />}
    </div>
  );
}
