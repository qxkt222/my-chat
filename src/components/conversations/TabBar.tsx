import { X } from "lucide-react";
import { useConversationStore } from "@/stores/useConversationStore";

export function TabBar() {
  const conversations = useConversationStore((s) => s.conversations);
  const tabIds = useConversationStore((s) => s.tabIds);
  const activeId = useConversationStore((s) => s.activeId);
  const openTab = useConversationStore((s) => s.openTab);
  const closeTab = useConversationStore((s) => s.closeTab);

  if (tabIds.length <= 1) return null;

  return (
    <div className="flex items-center gap-0.5 px-1 py-0.5 bg-muted/50 border-b border-border overflow-x-auto shrink-0">
      {tabIds.map((id) => {
        const conv = conversations.find((c) => c.id === id);
        if (!conv) return null;
        const isActive = id === activeId;

        return (
          <div
            key={id}
            onClick={() => openTab(id)}
            className={`group flex items-center gap-1 px-2.5 py-1 rounded-t text-xs cursor-pointer transition-colors whitespace-nowrap ${
              isActive
                ? "bg-card text-foreground border border-border border-b-0"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
            style={isActive ? { borderTop: "2px solid hsl(var(--primary))" } : undefined}
          >
            <span className="max-w-[120px] truncate">{conv.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(id);
              }}
              className="p-0.5 rounded-sm opacity-0 group-hover:opacity-100 hover:bg-muted-foreground/20 transition-all"
              title="Close tab"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
