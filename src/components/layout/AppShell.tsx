import { ErrorBoundary } from "./ErrorBoundary";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { ChatView } from "@/components/chat/ChatView";
import { TabBar } from "@/components/conversations/TabBar";
import { ToastContainer } from "@/components/ui/Toast";
import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { useViewStore } from "@/stores/useViewStore";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { TavernView } from "@/components/tavern/TavernView";
import { TranslationWorkspace } from "@/workspaces/TranslationWorkspace";
import { DrawingWorkspace } from "@/workspaces/DrawingWorkspace";

interface Props {
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
}

export function AppShell({ settingsOpen, onOpenSettings, onCloseSettings }: Props) {
  const view = useViewStore((s) => s.view);
  const mode = useAppModeStore((s) => s.mode);

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen bg-background">
        <Header
          settingsOpen={settingsOpen}
          onOpenSettings={onOpenSettings}
          onCloseSettings={onCloseSettings}
        />

        {/* 酒馆模式:独立角色扮演界面(与工作模式会话完全隔离,互不干扰) */}
        {mode === "tavern" ? (
          <TavernView onOpenSettings={onOpenSettings} />
        ) : (
          <>
            <TabBar />
            <div className="flex flex-1 overflow-hidden">
              <Sidebar />
              <main className="flex-1 flex flex-col overflow-hidden">
                {view === "chat" && <ChatView />}
                {view === "translation" && <TranslationWorkspace />}
                {view === "drawing" && <DrawingWorkspace />}
              </main>
            </div>
          </>
        )}

        <StatusBar />
        <ToastContainer />
        <ConfirmDialogHost />
      </div>
    </ErrorBoundary>
  );
}
