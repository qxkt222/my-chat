import { useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from "react";
import { Sparkles, MessageSquare, Database, Zap } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useSkillStore } from "@/stores/useSkillStore";
import { useKnowledgeStore } from "@/stores/useKnowledgeStore";
import { useConversationStore } from "@/stores/useConversationStore";
import { SLASH_COMMANDS } from "@/plugin/commands";

/** @提及对象类型:技能 / 命令 / 知识库 / 最近会话 */
export type MentionKind = "skill" | "command" | "knowledge" | "conversation";

export interface MentionItem {
  kind: MentionKind;
  id: string;
  name: string;
  description: string;
}

export interface MentionSelection {
  kind: MentionKind;
  id: string;
  name: string;
}

export interface AtMentionMenuHandle {
  /** Enter 确认当前高亮项(由父级键盘导航触发) */
  selectHighlighted: () => void;
}

/**
 * `@` 提及菜单(输入框打字流的一部分):
 * 输入 `@` 后弹出可搜索列表(技能/命令/知识库/最近会话),↑↓ 选择 Enter 确认。
 * 选中技能/命令 → 注入 systemPrompt;选中知识库 → 注入 RAG 上下文;
 * 选中最近会话 → 可拉取该会话内容作为上下文(@ 旧会话自动压缩)。
 */
export const AtMentionMenu = forwardRef<
  AtMentionMenuHandle,
  {
    /** 当前 @ 后面的搜索文本(可能为空=全部) */
    trigger: string;
    /** 高亮下标(受控,由输入框键盘导航驱动) */
    highlight: number;
    onHighlightChange: (i: number) => void;
    onSelect: (sel: MentionSelection) => void;
  }
>(function AtMentionMenu({ trigger, highlight, onHighlightChange, onSelect }, ref) {
  const t = useT();
  const skills = useSkillStore((s) => s.skills);
  const bases = useKnowledgeStore((s) => s.bases);
  const conversations = useConversationStore((s) => s.conversations);
  const listRef = useRef<HTMLDivElement>(null);

  const q = trigger.trim().toLowerCase();

  const items = useMemo<MentionItem[]>(() => {
    const list: MentionItem[] = [
      ...skills.map((s) => ({
        kind: "skill" as const,
        id: s.id,
        name: s.name,
        description: s.description || s.systemPrompt.slice(0, 60),
      })),
      ...SLASH_COMMANDS.map((c) => ({
        kind: "command" as const,
        id: c.cmd,
        name: `/${c.cmd}`,
        description: c.description || "",
      })),
      ...bases.map((b) => ({
        kind: "knowledge" as const,
        id: b.id,
        name: b.name,
        description: t("mention.knowledgeDesc"),
      })),
      // 最近会话(最多 8 个,按 updated_at)
      ...[...conversations]
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .slice(0, 8)
        .map((c) => ({
          kind: "conversation" as const,
          id: c.id,
          name: c.title,
          description: t("mention.convDesc"),
        })),
    ];
    return q
      ? list.filter(
          (i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)
        )
      : list;
  }, [skills, bases, conversations, q, t]);

  const visible = items.slice(0, 12);
  // 高亮越界兜底(列表缩短时)
  const active = Math.min(highlight, Math.max(0, visible.length - 1));

  // Enter 确认高亮项(父级键盘导航驱动)
  useImperativeHandle(
    ref,
    () => ({
      selectHighlighted: () => {
        const item = visible[active];
        if (item) onSelect({ kind: item.kind, id: item.id, name: item.name });
      },
    }),
    [visible, active, onSelect]
  );

  // 搜索词变化时回到第一项
  useEffect(() => {
    onHighlightChange(0);
    listRef.current?.scrollTo({ top: 0 });
  }, [trigger, onHighlightChange]);

  if (items.length === 0) return null;

  const kindIcon = (kind: MentionKind) => {
    switch (kind) {
      case "skill":
        return <Sparkles className="w-3 h-3 text-primary" />;
      case "command":
        return <Zap className="w-3 h-3 text-amber-500" />;
      case "knowledge":
        return <Database className="w-3 h-3 text-emerald-500" />;
      case "conversation":
        return <MessageSquare className="w-3 h-3 text-muted-foreground" />;
    }
  };

  return (
    <div
      ref={listRef}
      className="absolute bottom-full mb-1 w-64 max-h-56 overflow-y-auto rounded-md border border-border bg-card shadow-lg z-20"
    >
      {visible.map((item, i) => (
        <button
          key={`${item.kind}:${item.id}`}
          onMouseEnter={() => onHighlightChange(i)}
          onClick={() => onSelect({ kind: item.kind, id: item.id, name: item.name })}
          className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors ${
            i === active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"
          }`}
        >
          {kindIcon(item.kind)}
          <span className="flex-1 truncate">{item.name}</span>
          <span className="text-[9px] text-muted-foreground truncate max-w-[90px]">
            {item.description}
          </span>
        </button>
      ))}
    </div>
  );
});
