import { useMemo, useState } from "react";
import { Eye, X, Copy } from "lucide-react";
import { useT } from "@/lib/i18n";
import { buildRpSystemParts } from "@/lib/rp-prompt";
import { countTokens } from "@/lib/token-counter";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import type { CharacterCard, CharacterBook, Persona, PromptPreset, Message } from "@/types";

/**
 * 上下文查看器(25,对齐 NovelAI Context Viewer):生成前显示 prompt 拼装预览——
 * 三段式各段/世界书命中/摘要/token 占比。把"黑盒 prompt 组装"变成可见可调。
 * 纯展示:复用 buildRpSystemParts(已是纯函数),不产生额外流。
 */
export function ContextViewer({
  card,
  persona,
  preset,
  lorebooks,
  recentMessages,
  currentInput,
  summary,
  onClose,
}: {
  card: CharacterCard;
  persona?: Persona | null | undefined;
  preset?: PromptPreset | null | undefined;
  lorebooks: CharacterBook[];
  recentMessages: Pick<Message, "role" | "content">[];
  currentInput: string;
  summary?: string | undefined;
  onClose: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  // Escape 关闭(此前只有右上角 X)
  useEscapeClose(onClose);

  const parts = useMemo(
    () =>
      buildRpSystemParts({
        card,
        persona: persona || null,
        preset: preset || null,
        lorebooks,
        recentMessages,
        currentInput,
        summary,
      }),
    [card, persona, preset, lorebooks, recentMessages, currentInput, summary]
  );

  const segments = [
    { name: t("context.stable"), text: parts.stableSystem, color: "text-primary" },
    { name: t("context.lorebook"), text: parts.lorebook, color: "text-emerald-500" },
    { name: t("context.summary"), text: parts.summary, color: "text-amber-500" },
    ...(parts.depthPrompt
      ? [
          {
            name: t("context.depth", { n: parts.depthPrompt.depth }),
            text: parts.depthPrompt.prompt,
            color: "text-purple-500",
          },
        ]
      : []),
  ];
  const total = segments.reduce((s, x) => s + countTokens(x.text), 0);

  const copyAll = async () => {
    const all = segments
      .filter((s) => s.text)
      .map((s) => `[${s.name}]\n${s.text}`)
      .join("\n\n---\n\n");
    await navigator.clipboard.writeText(all);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[92vw] max-h-[80vh] flex flex-col bg-card border border-border rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 px-4 py-3 border-b border-border">
          <Eye className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">{t("context.title")}</span>
          <span className="text-[10px] text-muted-foreground">
            {t("context.subtitle")} · ~{total} tokens
          </span>
          <div className="flex-1" />
          <button
            onClick={copyAll}
            className="p-1 rounded hover:bg-muted text-muted-foreground"
            title={t("context.copy")}
          >
            {copied ? (
              <span className="text-green-500 text-xs">✓</span>
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {segments.map((seg) => (
            <div key={seg.name}>
              <div className="flex items-center justify-between mb-0.5">
                <span className={`text-[10px] font-medium ${seg.color}`}>{seg.name}</span>
                <span className="text-[9px] text-muted-foreground">
                  {countTokens(seg.text)} tokens
                </span>
              </div>
              <pre className="p-2 text-[11px] bg-muted rounded whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                {seg.text || <span className="text-muted-foreground/50">(空)</span>}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
