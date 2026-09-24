import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  MessageSquare,
  CornerDownLeft,
  Settings,
  Plus,
  Languages,
  Palette,
} from "lucide-react";
import { useConversationStore } from "@/stores/useConversationStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useViewStore } from "@/stores/useViewStore";
import { useT } from "@/lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

interface PaletteItem {
  id: string;
  kind: "conv" | "msg" | "action";
  title: string;
  sub: string;
  icon: React.ReactNode;
  run: () => void;
}

/**
 * Ctrl+K 命令面板（规范 5.8）：搜索会话标题 + 消息内容 + 动作命令。
 * 内存索引（load 时已全量拉取消息），无需新后端。
 */
export function CommandPalette({ open, onClose, onOpenSettings }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const conversations = useConversationStore((s) => s.conversations);
  const openTab = useConversationStore((s) => s.openTab);
  const createConv = useConversationStore((s) => s.create);
  const models = useSettingsStore((s) => s.models);
  const setActiveModel = useSettingsStore((s) => s.setActiveModel);
  const setView = useViewStore((s) => s.setView);

  // 打开时聚焦 + 清空上次搜索(异步更新,避免 effect 内同步 setState 级联渲染)
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => {
        setQuery("");
        setSel(0);
        inputRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(id);
    }
    // 显式返回：noImplicitReturns 要求所有分支同形（未打开时无可清理资源）
    return undefined;
  }, [open]);

  // 全局 Escape 关闭(焦点不在输入框时也可退出;capture 阻断全局"停止生成"快捷键误触发)
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [open, onClose]);

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) return [];
    const q = query.trim().toLowerCase();
    const list: PaletteItem[] = [];

    // 动作命令
    list.push({
      id: "act-new",
      kind: "action",
      title: t("palette.newChat"),
      sub: "Ctrl+N",
      icon: <Plus className="w-4 h-4" />,
      run: () => {
        createConv();
        onClose();
      },
    });
    list.push({
      id: "act-translate",
      kind: "action",
      title: t("palette.openTranslate"),
      sub: "",
      icon: <Languages className="w-4 h-4" />,
      run: () => {
        setView("translation");
        onClose();
      },
    });
    list.push({
      id: "act-draw",
      kind: "action",
      title: t("palette.openDraw"),
      sub: "",
      icon: <Palette className="w-4 h-4" />,
      run: () => {
        setView("drawing");
        onClose();
      },
    });
    list.push({
      id: "act-settings",
      kind: "action",
      title: t("palette.openSettings"),
      sub: "",
      icon: <Settings className="w-4 h-4" />,
      run: () => {
        onOpenSettings();
        onClose();
      },
    });

    // 模型切换动作
    for (const m of models) {
      list.push({
        id: `model-${m.name}`,
        kind: "action",
        title: t("palette.switchModel", { name: m.name }),
        sub: m.model,
        icon: <MessageSquare className="w-4 h-4" />,
        run: () => {
          setActiveModel(m.name);
          onClose();
        },
      });
    }

    // 会话 + 消息搜索
    for (const c of conversations) {
      const titleMatch = !q || c.title.toLowerCase().includes(q);
      if (titleMatch) {
        list.push({
          id: `conv-${c.id}`,
          kind: "conv",
          title: c.title,
          sub: t("palette.convSub"),
          icon: <MessageSquare className="w-4 h-4" />,
          run: () => {
            openTab(c.id);
            onClose();
          },
        });
      }
      // 消息内容命中（限制条数避免面板爆炸）
      let msgHits = 0;
      for (const m of c.messages) {
        if (msgHits >= 5) break;
        if (q && m.content.toLowerCase().includes(q)) {
          msgHits++;
          list.push({
            id: `msg-${c.id}-${m.id}`,
            kind: "msg",
            title: m.content.slice(0, 60),
            sub: c.title,
            icon: <MessageSquare className="w-4 h-4" />,
            run: () => {
              openTab(c.id);
              onClose();
            },
          });
        }
      }
    }

    // 过滤：非空查询时只留命中项
    const filtered = q
      ? list.filter((it) => it.title.toLowerCase().includes(q) || it.sub.toLowerCase().includes(q))
      : list;
    // 动作优先，上限 40
    return filtered.slice(0, 40);
  }, [
    open,
    query,
    openTab,
    createConv,
    models,
    setActiveModel,
    onClose,
    setView,
    onOpenSettings,
    t,
    conversations,
  ]);

  if (!open) return null;

  const run = (it: PaletteItem) => it.run();
  const activeItem = items[Math.min(sel, Math.max(0, items.length - 1))];

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 flex items-start justify-center"
      style={{ paddingTop: "15vh" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[500px] max-w-[90vw] bg-white rounded-[10px] shadow-2xl overflow-hidden">
        {/* 输入行：16px 大字，下缘 1px 分隔线 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#E8ECF0]">
          <Search className="w-4 h-4 text-[#8899A6]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter" && activeItem) {
                e.preventDefault();
                run(activeItem);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder={t("palette.placeholder")}
            className="flex-1 text-base outline-none bg-transparent"
          />
        </div>
        {/* 结果列表 */}
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {items.length === 0 && (
            <div className="px-4 py-6 text-center text-[#8899A6] text-sm">
              {t("palette.noResults")}
            </div>
          )}
          {items.map((it, i) => (
            <button
              key={it.id}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(it)}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left text-[13px] ${
                i === sel ? "bg-[#E8ECF0]" : ""
              }`}
            >
              <span className="text-[#5A6D7E] shrink-0">{it.icon}</span>
              <span className="flex-1 truncate text-[#2C3E50]">{it.title}</span>
              <span className="text-[11px] text-[#8899A6] truncate max-w-[140px]">{it.sub}</span>
              {i === sel && <CornerDownLeft className="w-3.5 h-3.5 text-[#8899A6]" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
