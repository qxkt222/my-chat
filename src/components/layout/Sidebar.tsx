import { useState } from "react";
import {
  Plus,
  Search,
  MessageSquare,
  Trash2,
  Star,
  Bookmark,
  CheckSquare,
  Archive,
  X,
  ListTodo,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { useConversationStore } from "@/stores/useConversationStore";
import { useTaskStore } from "@/stores/useTaskStore";
import { askConfirm } from "@/components/ui/ConfirmDialog";
import type { Conversation } from "@/types";

/** 侧栏视图:会话 / 书签(消息级)/ 任务(后台队列) */
type SidebarView = "chats" | "bookmarks" | "tasks";

export function Sidebar() {
  const t = useT();
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const create = useConversationStore((s) => s.create);
  const remove = useConversationStore((s) => s.remove);
  const openTab = useConversationStore((s) => s.openTab);
  const toggleFavorite = useConversationStore((s) => s.toggleFavorite);
  const favorites = useConversationStore((s) => s.favorites);
  const archived = useConversationStore((s) => s.archived);
  const toggleArchive = useConversationStore((s) => s.toggleArchive);
  const removeMany = useConversationStore((s) => s.removeMany);
  const toggleArchiveMany = useConversationStore((s) => s.toggleArchiveMany);
  const setActive = useConversationStore((s) => s.setActive);
  const runningCount = useTaskStore((s) => s.runningCount);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState<SidebarView>("chats");
  const [showArchived, setShowArchived] = useState(false);
  // 批量管理模式
  const [manageMode, setManageMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const filtered = search
    ? conversations.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()))
    : conversations;

  const visible = filtered.filter((c) =>
    showArchived ? archived.includes(c.id) : !archived.includes(c.id)
  );

  const handleNew = async () => {
    const conv = await create();
    openTab(conv.id);
  };

  const handleSelect = (conv: Conversation) => {
    if (manageMode) {
      setSelected((p) => (p.includes(conv.id) ? p.filter((x) => x !== conv.id) : [...p, conv.id]));
      return;
    }
    openTab(conv.id);
  };

  const handleDelete = async (e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation();
    if (!(await askConfirm(t("sidebar.confirmDelete", { title: conv.title })))) return;
    remove(conv.id);
  };

  const exitManage = () => {
    setManageMode(false);
    setSelected([]);
  };

  const batchDelete = async () => {
    if (selected.length === 0) return;
    if (!(await askConfirm(t("sidebar.confirmBatchDelete", { n: selected.length })))) return;
    void removeMany(selected);
    exitManage();
  };

  const batchArchive = (archivedState: boolean) => {
    if (selected.length === 0) return;
    void toggleArchiveMany(selected, archivedState);
    exitManage();
  };

  if (collapsed) {
    return (
      <aside className="w-10 bg-card border-r border-border flex flex-col items-center py-2 gap-2 shrink-0">
        <button
          onClick={() => setCollapsed(false)}
          className="p-1 rounded hover:bg-muted text-muted-foreground"
          title={t("sidebar.expand")}
        >
          <MessageSquare className="w-4 h-4" />
        </button>
        <button
          onClick={handleNew}
          className="p-1 rounded hover:bg-primary/20 text-primary"
          title={t("sidebar.new")}
        >
          <Plus className="w-4 h-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-56 bg-card border-r border-border flex flex-col shrink-0">
      {/* Search + New */}
      <div className="p-2 flex gap-1">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder={t("sidebar.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-7 pr-2 py-1.5 text-xs bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <button
          onClick={handleNew}
          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-primary transition-colors shrink-0"
          title={`${t("sidebar.new")} (Ctrl+N)`}
        >
          <Plus className="w-4 h-4" />
        </button>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1.5 rounded hover:bg-muted text-muted-foreground shrink-0"
          title={t("sidebar.collapse")}
        >
          <span className="text-xs">&laquo;</span>
        </button>
      </div>

      {/* 视图切换:会话 / 书签 + 批量管理 / 归档开关 */}
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <button
          onClick={() => setView("chats")}
          className={`px-2 py-1 text-[11px] rounded transition-colors ${
            view === "chats"
              ? "bg-primary/10 text-primary font-medium"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("sidebar.chats")}
        </button>
        <button
          onClick={() => setView("bookmarks")}
          className={`px-2 py-1 text-[11px] rounded transition-colors ${
            view === "bookmarks"
              ? "bg-primary/10 text-primary font-medium"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Bookmark className="w-3 h-3 inline mr-0.5 -mt-0.5" />
          {t("sidebar.bookmarks")}
        </button>
        <button
          onClick={() => setView("tasks")}
          className={`px-2 py-1 text-[11px] rounded transition-colors relative ${
            view === "tasks"
              ? "bg-primary/10 text-primary font-medium"
              : "text-muted-foreground hover:text-foreground"
          }`}
          title={t("sidebar.tasks")}
        >
          <ListTodo className="w-3 h-3 inline mr-0.5 -mt-0.5" />
          {t("sidebar.tasks")}
          {runningCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-primary animate-pulse" />
          )}
        </button>
        <div className="flex-1" />
        {view === "chats" && (
          <>
            <button
              onClick={() => setManageMode(!manageMode)}
              title={t("sidebar.manage")}
              className={`p-1 rounded transition-colors ${
                manageMode
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {manageMode ? <X className="w-3 h-3" /> : <CheckSquare className="w-3 h-3" />}
            </button>
            <button
              onClick={() => setShowArchived(!showArchived)}
              title={t("sidebar.archive")}
              className={`p-1 rounded transition-colors ${
                showArchived
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Archive className="w-3 h-3" />
            </button>
          </>
        )}
      </div>

      {view === "bookmarks" ? (
        <BookmarkPanel conversations={conversations} openTab={openTab} setActive={setActive} />
      ) : view === "tasks" ? (
        <TaskPanel />
      ) : (
        <>
          {/* 对话分组（规范 5.2：组标题 10px 灰 + 计数徽标蓝底白字） */}
          <div className="flex items-center justify-between px-3.5 pt-1 pb-1">
            <span className="text-[10px] text-[#8899A6] uppercase tracking-[0.6px]">
              {showArchived ? t("sidebar.archived") : t("header.chat")}
            </span>
            <span className="text-[10px] px-1.5 rounded-full bg-[#1A6FB5] text-white leading-4">
              {visible.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto px-1">
            {visible.map((conv) => (
              <div
                key={conv.id}
                onClick={() => handleSelect(conv)}
                className={`group flex items-center gap-2 px-2 py-1.5 mx-1 rounded text-sm cursor-pointer transition-colors ${
                  manageMode && selected.includes(conv.id)
                    ? "bg-primary/20 text-primary"
                    : activeId === conv.id
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-muted"
                }`}
              >
                {manageMode ? (
                  <span
                    className={`w-3.5 h-3.5 shrink-0 flex items-center justify-center rounded border ${
                      selected.includes(conv.id)
                        ? "bg-primary border-primary text-white"
                        : "border-input text-transparent"
                    }`}
                  >
                    ✓
                  </span>
                ) : (
                  <MessageSquare className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="flex-1 truncate text-xs">{conv.title}</span>
                {!manageMode && (
                  <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(conv.id);
                      }}
                      className={`p-0.5 rounded hover:bg-muted ${
                        favorites.includes(conv.id)
                          ? "text-yellow-400"
                          : "text-muted-foreground opacity-0 group-hover:opacity-100"
                      }`}
                    >
                      <Star className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleArchive(conv.id);
                      }}
                      title={t("sidebar.archive")}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-primary transition-all"
                    >
                      <Archive className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, conv)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-all"
                      title={t("memory.delete")}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </>
                )}
              </div>
            ))}

            {visible.length === 0 && (
              <div className="text-center text-muted-foreground text-xs py-8">
                {search ? t("sidebar.noSearchResults") : t("sidebar.noResults")}
              </div>
            )}
          </div>

          {/* 批量操作条(管理模式) */}
          {manageMode && (
            <div className="border-t border-border p-2 flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground flex-1">
                {selected.length > 0
                  ? `${t("sidebar.selected", { n: selected.length })}`
                  : t("sidebar.selectHint")}
              </span>
              <button
                onClick={() => batchArchive(showArchived ? false : true)}
                disabled={selected.length === 0}
                className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-primary disabled:opacity-30"
                title={showArchived ? t("sidebar.unarchive") : t("sidebar.archive")}
              >
                <Archive className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={batchDelete}
                disabled={selected.length === 0}
                className="p-1.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive disabled:opacity-30"
                title={t("sidebar.deleteMany")}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

/** 消息书签面板:跨会话列出所有已书签消息,一键跳转/取消 */
function BookmarkPanel({
  conversations,
  openTab,
  setActive,
}: {
  conversations: Conversation[];
  openTab: (id: string) => void;
  setActive: (id: string) => void;
}) {
  const t = useT();
  const toggleBookmark = useConversationStore((s) => s.toggleBookmark);
  // 收集所有书签消息(按时间倒序)
  const items = conversations
    .flatMap((c) => c.messages.filter((m) => m.bookmarked).map((m) => ({ conv: c, msg: m })))
    .sort((a, b) => new Date(b.msg.timestamp).getTime() - new Date(a.msg.timestamp).getTime());

  const jump = (convId: string) => {
    openTab(convId);
    setActive(convId);
  };

  return (
    <div className="flex-1 overflow-y-auto px-1">
      {items.length === 0 && (
        <p className="text-[11px] text-muted-foreground px-3 py-6 text-center">
          {t("sidebar.noBookmarks")}
        </p>
      )}
      {items.map(({ conv, msg }) => (
        <div
          key={msg.id}
          onClick={() => jump(conv.id)}
          className="group flex items-start gap-1.5 px-2 py-1.5 rounded cursor-pointer hover:bg-muted transition-colors"
        >
          <span className="text-[10px] text-muted-foreground shrink-0 mt-0.5">
            {msg.role === "user" ? "你" : "AI"}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] text-muted-foreground truncate">{conv.title}</div>
            <div className="text-xs text-foreground/90 line-clamp-2 break-words">
              {msg.content.slice(0, 80)}
            </div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              void toggleBookmark(conv.id, msg.id);
            }}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive shrink-0"
            title={t("chat.bookmark")}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** 后台任务面板:队列监控 + 进度 + 完成通知 + 结果复制(20) */
function TaskPanel() {
  const t = useT();
  const tasks = useTaskStore((s) => s.tasks);
  const removeTask = useTaskStore((s) => s.removeTask);
  const clearDone = useTaskStore((s) => s.clearDone);

  const statusBadge = (st: string) => {
    switch (st) {
      case "running":
        return (
          <span className="text-[9px] px-1 py-px rounded-full bg-primary/15 text-primary shrink-0">
            {t("task.running")}
          </span>
        );
      case "done":
        return (
          <span className="text-[9px] px-1 py-px rounded-full bg-green-500/15 text-green-500 shrink-0">
            {t("task.done")}
          </span>
        );
      case "error":
        return (
          <span className="text-[9px] px-1 py-px rounded-full bg-destructive/15 text-destructive shrink-0">
            {t("task.error")}
          </span>
        );
      default:
        return (
          <span className="text-[9px] px-1 py-px rounded-full bg-muted text-muted-foreground shrink-0">
            {t("task.queued")}
          </span>
        );
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-1">
      <div className="flex items-center justify-between px-2 pt-1 pb-1">
        <span className="text-[10px] text-[#8899A6] uppercase tracking-[0.6px]">
          {t("sidebar.tasks")}
        </span>
        {tasks.some((x) => x.status === "done" || x.status === "error") && (
          <button
            onClick={clearDone}
            className="text-[10px] text-muted-foreground hover:text-foreground"
            title={t("task.clearDone")}
          >
            {t("task.clearDone")}
          </button>
        )}
      </div>
      {tasks.length === 0 && (
        <p className="text-[11px] text-muted-foreground px-3 py-6 text-center">{t("task.empty")}</p>
      )}
      {tasks.map((task) => (
        <div key={task.id} className="group px-2 py-2 mb-1 rounded border border-border bg-card">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="flex-1 truncate text-[11px] font-medium">{task.title}</span>
            {statusBadge(task.status)}
            <button
              onClick={() => removeTask(task.id)}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted text-muted-foreground shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          {(task.status === "queued" || task.status === "running") && (
            <div className="h-1 rounded bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${task.progress}%` }}
              />
            </div>
          )}
          {task.status === "done" && task.result && (
            <div className="mt-1 text-[10px] text-muted-foreground line-clamp-3 break-words">
              {task.result.slice(0, 300)}
            </div>
          )}
          {task.status === "error" && task.error && (
            <div className="mt-1 text-[10px] text-destructive break-words">
              {task.error.slice(0, 200)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
