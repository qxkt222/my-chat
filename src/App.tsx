import { useEffect, useMemo, useState } from "react";
import { useThemeStore } from "./stores/useThemeStore";
import { useConversationStore } from "./stores/useConversationStore";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useSkillStore } from "./stores/useSkillStore";
import { useKnowledgeStore } from "./stores/useKnowledgeStore";
import { useAdapterStore } from "./stores/useAdapterStore";
import { useMemoryStore } from "./stores/useMemoryStore";
import { useCharacterStore } from "./stores/useCharacterStore";
import { useTranslateStore } from "./stores/useTranslateStore";
import { useChatStore } from "./stores/useChatStore";
import { useAppConfigStore, applyFontSize } from "./stores/useAppConfigStore";
import { AppShell } from "./components/layout/AppShell";
import { CommandPalette } from "./components/ui/CommandPalette";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { getSubModels, getCachedModels } from "./lib/model-presets";
import { useT } from "./lib/i18n";

export default function App() {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const theme = useThemeStore((s) => s.theme);
  const cfg = useAppConfigStore();

  // Apply stored config on mount
  useEffect(() => {
    applyFontSize(cfg.fontSize);
  }, [cfg.fontSize]);

  // Apply theme class to document
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else if (theme === "light") {
      root.classList.remove("dark");
    } else {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const apply = () => {
        if (mq.matches) root.classList.add("dark");
        else root.classList.remove("dark");
      };
      apply();
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  // Bootstrap data + parallel load for speed
  useEffect(() => {
    Promise.all([
      useSettingsStore.getState().load(),
      useConversationStore.getState().load(),
      useSkillStore.getState().load(),
      useKnowledgeStore.getState().load(),
      useAdapterStore.getState().load(),
      useMemoryStore.getState().load(),
      useCharacterStore.getState().load(),
      useTranslateStore.getState().load(),
    ]).finally(() => setLoading(false));
    // 空闲时预加载 markdown 渲染栈（react-markdown + highlight ~600KB），
    // 让第一条 AI 回复完成时无需等待懒加载。
    const idle =
      (window as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback ||
      ((cb: () => void) => setTimeout(cb, 3000));
    idle(() => {
      import("./components/chat/MessageRenderer").catch(() => {
        // 有意静默：空闲预加载失败不影响任何功能——真正渲染时会再 import 一次，
        // 那次失败有 ErrorBoundary 与错误横幅接着。写日志反而会淹没 chat_errors.log。
      });
    });
  }, []);

  // Global keyboard shortcuts (exact modifier matching)
  const shortcuts = useMemo(() => {
    const settings = () => useSettingsStore.getState();
    const conv = () => useConversationStore.getState();
    return [
      {
        key: "n",
        ctrl: true,
        description: t("palette.newChat"),
        handler: () => {
          conv().create();
        },
      },
      {
        key: "k",
        ctrl: true,
        description: t("palette.placeholder"),
        handler: (e: KeyboardEvent) => {
          e.preventDefault();
          setPaletteOpen((v) => !v);
        },
      },
      {
        key: "w",
        ctrl: true,
        description: t("shortcut.closeTab"),
        handler: () => {
          const c = conv();
          if (c.activeId) c.closeTab(c.activeId);
        },
      },
      {
        key: "Tab",
        ctrl: true,
        description: t("shortcut.nextTab"),
        handler: () => {
          const c = conv();
          if (c.tabIds.length < 2) return;
          const i = c.tabIds.indexOf(c.activeId || "");
          const next = c.tabIds[(i + 1) % c.tabIds.length];
          if (next) c.openTab(next);
        },
      },
      {
        key: "Tab",
        ctrl: true,
        shift: true,
        description: t("shortcut.prevTab"),
        handler: () => {
          const c = conv();
          if (c.tabIds.length < 2) return;
          const i = c.tabIds.indexOf(c.activeId || "");
          const next = c.tabIds[(i - 1 + c.tabIds.length) % c.tabIds.length];
          if (next) c.openTab(next);
        },
      },
      {
        key: "Escape",
        description: t("chat.stop"),
        handler: () => {
          if (useChatStore.getState().isStreaming) useChatStore.getState().cancelGeneration();
        },
      },
      // 模型快速切换：Alt+↑/↓ 循环服务商，Alt+←/→ 循环子模型
      {
        key: "ArrowDown",
        alt: true,
        description: t("shortcut.nextProvider"),
        handler: () => {
          const s = settings();
          const i = s.models.findIndex((m) => m.name === s.activeModel);
          const next = s.models[(i + 1) % s.models.length];
          if (next) s.setActiveModel(next.name);
        },
      },
      {
        key: "ArrowUp",
        alt: true,
        description: t("shortcut.prevProvider"),
        handler: () => {
          const s = settings();
          const i = s.models.findIndex((m) => m.name === s.activeModel);
          const next = s.models[(i - 1 + s.models.length) % s.models.length];
          if (next) s.setActiveModel(next.name);
        },
      },
      {
        key: "ArrowLeft",
        alt: true,
        description: t("shortcut.prevSubModel"),
        handler: () => {
          const s = settings();
          const m = s.models.find((x) => x.name === s.activeModel);
          if (!m) return;
          // 与 Header 一致:缓存优先,回退预设;空列表不空转
          const list = getCachedModels(s.activeModel) || getSubModels(m.provider || "");
          if (list.length === 0) return;
          const idx = list.indexOf(m.model);
          const prev = list[(idx - 1 + list.length) % list.length];
          if (prev) {
            s.updateModel(m.name, { model: prev });
            s.persistModel(m.name);
          }
        },
      },
      {
        key: "ArrowRight",
        alt: true,
        description: t("shortcut.nextSubModel"),
        handler: () => {
          const s = settings();
          const m = s.models.find((x) => x.name === s.activeModel);
          if (!m) return;
          // 与 Header 一致:缓存优先,回退预设;空列表不空转
          const list = getCachedModels(s.activeModel) || getSubModels(m.provider || "");
          if (list.length === 0) return;
          const idx = list.indexOf(m.model);
          const next = list[(idx + 1) % list.length];
          if (next) {
            s.updateModel(m.name, { model: next });
            s.persistModel(m.name);
          }
        },
      },
    ];
  }, [t]);

  useKeyboardShortcuts(shortcuts);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <AppShell
        settingsOpen={settingsOpen}
        onOpenSettings={() => setSettingsOpen(true)}
        onCloseSettings={() => setSettingsOpen(false)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    </>
  );
}
