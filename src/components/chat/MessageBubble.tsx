import { useState, useCallback, memo, lazy, Suspense, useMemo } from "react";
import {
  Copy,
  Check,
  RefreshCw,
  MessageSquareQuote,
  GitFork,
  Languages,
  Bookmark,
  Pencil,
  Play,
} from "lucide-react";
import type { Message } from "@/types";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useT } from "@/lib/i18n";
import { applyRegexRules } from "@/lib/regex-format";
import { errorTitle, errorHint } from "@/lib/tauri";
import { countTokens, formatTokens } from "@/lib/token-counter";
import { StreamCursor } from "./StreamCursor";

// markdown 栈（react-markdown + rehype-highlight ~600KB）懒加载：
// 首屏/启动不加载，第一条 AI 回复完成时才拉取；流式期间走纯文本。
const MessageRenderer = lazy(() => import("./MessageRenderer"));

interface Props {
  message: Message;
  /** Callback to quote this message into the input (Chatbox Message Quoting) */
  onQuote?: ((msg: Message) => void) | undefined;
  /** Callback to fork the conversation at this message (话题分叉) */
  onFork?: ((msg: Message) => void) | undefined;
  /** 该消息正在流式（打字机阶段走纯文本，零 markdown 解析） */
  streaming?: boolean | undefined;
  /** 角色扮演:assistant 显示的角色名与头像(src) */
  rpCharName?: string | undefined;
  rpCharAvatar?: string | null | undefined;
  /** 角色扮演:user 显示的 Persona 名与头像 */
  rpUserName?: string | undefined;
  rpUserAvatar?: string | null | undefined;
  /** 酒馆内置翻译:点击翻译该消息(译文存 message.translation 渲染) */
  onTranslate?: ((msg: Message) => void) | undefined;
  /** 该消息正在翻译中(按钮 loading 态) */
  translating?: boolean | undefined;
  /** Swipe 滑卡:◀/▶ 切换回复版本 */
  onSwipe?: ((msg: Message, dir: -1 | 1) => void) | undefined;
  /** 消息书签:切换单条消息书签状态(长会话快速跳回) */
  onToggleBookmark?: ((msg: Message) => void) | undefined;
  /** 多模型对比分歧标注:同一问题各模型回答的一致性(流式结束后计算) */
  compareBadge?: "consensus" | "conflict" | null | undefined;
  /** 请求失败重试(错误命名化:限流/超时提供重试按钮) */
  onRetry?: ((msg: Message) => void) | undefined;
  /** 消息编辑:点击弹出编辑框,改后落盘(酒馆/工作共用) */
  onEdit?: ((msg: Message) => void) | undefined;
  /** 继续生成(酒馆 Continue):以上一条回复结尾为前缀续写 */
  onContinue?: ((msg: Message) => void) | undefined;
}

/**
 * 消息气泡。memo 是流式性能的关键：流式时只有正在流式的那条消息 content 变化，
 * 其余历史消息 props 引用不变 → 不重渲染（不再重复跑 markdown 解析）。
 * 注意：onQuote/onFork 必须是稳定引用（useCallback），否则 memo 失效。
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  onQuote,
  onFork,
  streaming,
  rpCharName,
  rpCharAvatar,
  rpUserName,
  rpUserAvatar,
  onTranslate,
  translating,
  onSwipe,
  onToggleBookmark,
  compareBadge,
  onRetry,
  onEdit,
  onContinue,
}: Props) {
  const t = useT();
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const [copied, setCopied] = useState(false);

  // Swipe:显示当前版本内容(variants[variantIndex] ?? content)
  const variants = message.variants || [];
  const variantIndex = message.variantIndex ?? 0;
  const rawContent =
    variants.length > 0 ? (variants[variantIndex] ?? message.content) : message.content;
  const swipeCount = variants.length > 0 ? variants.length : 1;
  // Regex 后处理(渲染前;memo 内 useMemo 缓存,流式/历史均生效)
  const regexRules = useSettingsStore((s) => s.regexRules);
  const displayContent = useMemo(
    () => applyRegexRules(rawContent, regexRules),
    [rawContent, regexRules]
  );

  // 角色扮演显示名:assistant 优先角色名,user 优先 Persona 名;否则回退模型名/You
  const displayName = isUser ? rpUserName || "You" : rpCharName || message.model || "AI";
  const displayAvatar = isUser ? rpUserAvatar : rpCharAvatar;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [message.content]);

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div className="px-3 py-1 bg-muted text-muted-foreground text-xs rounded-full max-w-lg truncate">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`group relative flex ${isUser ? "justify-end" : "justify-start"} animate-fade-in`}
    >
      <div
        className={`max-w-[85%] rounded-lg px-4 py-2.5 ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-card border border-border text-foreground"
        }`}
      >
        {isUser ? (
          <div className="text-sm">
            <div className="flex items-center justify-end gap-1.5 mb-1">
              {displayAvatar && (
                <img
                  src={displayAvatar}
                  alt={displayName}
                  className="w-4 h-4 rounded-full object-cover"
                />
              )}
              <span className="text-[10px] text-primary-foreground/70 font-medium">
                {displayName}
              </span>
            </div>
            <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
          </div>
        ) : (
          <div className="text-sm">
            <div className="flex items-center gap-1.5 mb-1">
              {displayAvatar && (
                <img
                  src={displayAvatar}
                  alt={displayName}
                  className="w-4 h-4 rounded-full object-cover"
                />
              )}
              <div
                className="text-[10px] text-primary mb-1 font-medium truncate"
                title={displayName}
              >
                {displayName}
              </div>
              {/* 多模型对比分歧标注:同一问题各模型回答一致/分歧(流式结束才显示) */}
              {compareBadge && (
                <span
                  className={`ml-1 px-1.5 py-px rounded text-[9px] font-medium ${
                    compareBadge === "conflict"
                      ? "bg-amber-500/15 text-amber-500"
                      : "bg-emerald-500/15 text-emerald-500"
                  }`}
                  title={
                    compareBadge === "conflict"
                      ? t("chat.compareConflict")
                      : t("chat.compareConsensus")
                  }
                >
                  {compareBadge === "conflict"
                    ? t("chat.compareConflict")
                    : t("chat.compareConsensus")}
                </span>
              )}
            </div>
            {message.reasoning && <ReasoningBlock reasoning={message.reasoning} />}
            {/* 深优化：流式中纯文本（零 markdown 解析），完成后才切 markdown 渲染 */}
            {streaming ? (
              <div className="whitespace-pre-wrap break-words">
                {displayContent}
                <StreamCursor active />
              </div>
            ) : (
              <Suspense
                fallback={<div className="whitespace-pre-wrap break-words">{displayContent}</div>}
              >
                <MessageRenderer content={displayContent} />
              </Suspense>
            )}
            {/* 酒馆内置翻译:译文(独立于原文) */}
            {message.translation && !streaming && (
              <div className="mt-2 pl-2.5 border-l-2 border-primary/40 text-[13px] text-foreground/90 whitespace-pre-wrap break-words">
                <div className="text-[10px] text-primary mb-0.5">{t("chat.translation")}</div>
                {message.translation}
              </div>
            )}
            {/* F4 + 错误命名化: 请求错误独立横幅——按 kind 差异化标题/提示,失败不污染正文 */}
            {message.error && !streaming && (
              <div className="mt-2 px-3 py-2 rounded-md border border-destructive/30 bg-destructive/5 text-destructive text-xs whitespace-pre-wrap break-words">
                <span className="font-medium block mb-0.5">
                  {message.errorKind
                    ? errorTitle(message.errorKind as never)
                    : t("chat.requestFailed")}
                </span>
                <span className="text-destructive/90">{message.error}</span>
                {message.errorKind && errorHint(message.errorKind as never) && (
                  <span className="block mt-1 text-destructive/70">
                    💡 {errorHint(message.errorKind as never)}
                  </span>
                )}
                {(message.errorKind === "timeout" || message.errorKind === "rate_limit") &&
                  onRetry && (
                    <button
                      onClick={() => onRetry(message)}
                      className="mt-1.5 px-2 py-0.5 rounded border border-destructive/40 text-destructive hover:bg-destructive/10 text-[11px]"
                    >
                      {t("chat.retry")}
                    </button>
                  )}
              </div>
            )}
          </div>
        )}
        <div
          className={`text-[10px] mt-1 ${
            isUser ? "text-primary-foreground/60" : "text-muted-foreground"
          }`}
        >
          {formatTime(message.timestamp)}
          {/* 每消息 token 计数(酒馆 message_token_count_enabled 对齐;流式时不显示) */}
          {!streaming && (
            <span className="ml-1.5 opacity-70">· {formatTokens(countTokens(displayContent))}</span>
          )}
        </div>
      </div>

      {/* Message actions (Chatbox style) — copy / quote / regenerate */}
      {message.content && (
        <div
          className={`absolute ${isUser ? "left-0 -translate-x-full" : "right-0 translate-x-full"}
            top-1 hidden group-hover:flex items-center gap-0.5 px-1 py-0.5 rounded-md bg-card border border-border shadow-sm`}
        >
          <button
            onClick={handleCopy}
            title={t("chat.copy")}
            className={`p-1 rounded hover:bg-muted transition-colors ${copied ? "text-green-500" : "text-muted-foreground hover:text-foreground"}`}
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          </button>
          {/* Swipe 滑卡:◀ 版本计数 ▶(酒馆招牌;右到头可再生成新版本) */}
          {onSwipe && !isUser && (
            <span className="flex items-center gap-0.5 px-1 text-[10px] text-muted-foreground select-none">
              <button
                onClick={() => onSwipe(message, -1)}
                title={t("chat.swipePrev")}
                className="p-0.5 rounded hover:bg-muted hover:text-foreground"
              >
                ◀
              </button>
              <span className="min-w-[24px] text-center">
                {variantIndex + 1}/{swipeCount}
              </span>
              <button
                onClick={() => onSwipe(message, 1)}
                title={t("chat.swipeNext")}
                className="p-0.5 rounded hover:bg-muted hover:text-foreground"
              >
                ▶
              </button>
            </span>
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(message)}
              title={t("chat.edit")}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}
          {onTranslate && !isUser && (
            <button
              onClick={() => onTranslate(message)}
              title={t("chat.translate")}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              {translating ? (
                <span className="inline-block w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              ) : (
                <Languages className="w-3 h-3" />
              )}
            </button>
          )}
          {onQuote && (
            <button
              onClick={() => onQuote(message)}
              title={t("chat.quote")}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <MessageSquareQuote className="w-3 h-3" />
            </button>
          )}
          {onToggleBookmark && (
            <button
              onClick={() => onToggleBookmark(message)}
              title={t("chat.bookmark")}
              className={`p-1 rounded hover:bg-muted transition-colors ${
                message.bookmarked ? "text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Bookmark className="w-3 h-3" fill={message.bookmarked ? "currentColor" : "none"} />
            </button>
          )}
          {onFork && (
            <button
              onClick={() => onFork(message)}
              title={t("chat.fork")}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <GitFork className="w-3 h-3" />
            </button>
          )}
          {!isUser && onRetry && (
            <button
              onClick={() => onRetry(message)}
              title={t("chat.regenerate")}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
          {!isUser && onContinue && (
            <button
              onClick={() => onContinue(message)}
              title={t("chat.continue")}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <Play className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
});

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** Collapsible "thinking" block for reasoning models (DeepSeek v4 etc.) */
function ReasoningBlock({ reasoning }: { reasoning: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2 text-xs rounded-md border border-border bg-muted/50 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        <span className="font-medium">{t("chat.thinkingProcess")}</span>
        <span className="text-[10px] opacity-60 ml-auto">
          {t("chat.thinkingChars", { n: reasoning.length })}
        </span>
      </button>
      {open && (
        <div className="px-3 py-2 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap border-t border-border max-h-64 overflow-y-auto">
          {reasoning}
        </div>
      )}
    </div>
  );
}
