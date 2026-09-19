import { useState } from "react";
import { Zap, Plus, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import { askPrompt } from "@/components/ui/ConfirmDialog";
import {
  loadQuickReplies,
  saveQuickReplies,
  renderQuickReply,
  type QuickReply,
} from "@/lib/quick-reply";

/**
 * Quick Reply 按钮条(30 + 32 STscript 轻量):
 * 常用操作(掷骰/继续/加注)+ 用户自定义按钮,一键填充输入框。
 * 模板支持 {{char}}/{{user}}/{{input}} 宏与 [roll D100 65]/[ask 问题] 内置动作。
 */
export function QuickReplyBar({
  input,
  onSend,
  vars,
  disabled,
}: {
  /** 当前输入框内容({{input}} 宏源) */
  input: string;
  /** 渲染后发送(ask 时先弹输入框) */
  onSend: (text: string) => void;
  /** 宏变量 */
  vars: { char: string; user: string };
  disabled?: boolean;
}) {
  const t = useT();
  const [replies, setReplies] = useState<QuickReply[]>(loadQuickReplies);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTpl, setNewTpl] = useState("");

  const fire = async (q: QuickReply) => {
    const r = renderQuickReply(q, { char: vars.char, user: vars.user, input: input.trim() });
    if (r.ask) {
      const ans = await askPrompt(r.ask);
      if (ans === null) return;
      onSend(r.text ? `${r.text}\n${ans}` : ans);
    } else {
      onSend(r.text);
    }
  };

  const addReply = () => {
    if (!newName.trim() || !newTpl.trim()) return;
    const custom = replies.filter((r) => r.id.startsWith("custom-"));
    const q: QuickReply = {
      id: `custom-${crypto.randomUUID()}`,
      name: newName.trim(),
      template: newTpl.trim(),
    };
    saveQuickReplies([...custom, q]);
    setReplies(loadQuickReplies());
    setNewName("");
    setNewTpl("");
    setAdding(false);
  };

  const removeReply = (id: string) => {
    if (id.startsWith("qr-")) return; // 内置不可删
    const custom = replies.filter((r) => r.id.startsWith("custom-") && r.id !== id);
    saveQuickReplies(custom);
    setReplies(loadQuickReplies());
  };

  return (
    <div className="max-w-3xl mx-auto flex flex-wrap items-center gap-1 pt-1.5 text-[11px]">
      {replies.map((q) => (
        <span key={q.id} className="relative inline-flex">
          <button
            onClick={() => fire(q)}
            disabled={disabled}
            className="px-2 py-0.5 rounded border border-input text-muted-foreground hover:text-foreground hover:border-primary/40 disabled:opacity-40 flex items-center gap-0.5"
            title={q.template}
          >
            {q.icon && <span>{q.icon}</span>}
            <Zap className="w-2.5 h-2.5" />
            {q.name}
          </button>
          {!q.id.startsWith("qr-") && (
            <button
              onClick={() => removeReply(q.id)}
              className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-destructive text-white text-[8px] flex items-center justify-center opacity-0 group-hover:opacity-100"
            >
              <X className="w-2 h-2" />
            </button>
          )}
        </span>
      ))}
      {adding ? (
        <span className="flex items-center gap-1">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("qr.name")}
            className="w-16 px-1 py-0.5 text-[11px] bg-background border border-input rounded"
          />
          <input
            value={newTpl}
            onChange={(e) => setNewTpl(e.target.value)}
            placeholder={t("qr.template")}
            className="w-40 px-1 py-0.5 text-[11px] bg-background border border-input rounded"
          />
          <button
            onClick={addReply}
            className="px-1.5 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20"
          >
            ✓
          </button>
          <button
            onClick={() => setAdding(false)}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="px-2 py-0.5 rounded border border-dashed border-primary/40 text-primary hover:bg-primary/5 flex items-center gap-0.5"
          title={t("qr.add")}
        >
          <Plus className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
