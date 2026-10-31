// plugin/PluginHost.ts — Plugin host & registry

import type { ChatPlugin, PluginAPI, PluginContext } from "./types";
import type { Message } from "@/types";
import { logDiag } from "@/lib/tauri";
import { showToast } from "@/components/ui/Toast";

const plugins = new Map<string, ChatPlugin>();

// Messages provider (set by chat store to avoid circular imports)
let messagesProvider: (() => Message[]) | null = null;
export function setMessagesProvider(fn: () => Message[]) {
  messagesProvider = fn;
}

// ── notify 桥接(T-147) ─────────────────────────────────
// 插件拿到的是 CustomEvent('plugin-notify')；此前全仓无监听，translator /
// image-gen / tts 的 ctx.notify 全部静默丢弃。这里挂一个监听转成可见 toast。
interface PluginNotifyDetail {
  pluginId?: string;
  msg?: string;
}

function handlePluginNotify(ev: Event): void {
  const detail = (ev as CustomEvent<PluginNotifyDetail>).detail;
  const msg = detail?.msg;
  if (!msg) return;
  showToast("info", detail?.pluginId ? `[${detail.pluginId}] ${msg}` : msg);
}

let notifyListenerAttached = false;
function ensureNotifyListener(): void {
  if (notifyListenerAttached || typeof window === "undefined") return;
  notifyListenerAttached = true;
  window.addEventListener("plugin-notify", handlePluginNotify);
}
// 模块加载即接线；node 环境（无 window）下由 notify 内分支兜底记日志。
ensureNotifyListener();

/** 隔离单个插件 hook：抛错只影响该插件，记日志后继续下一个(T-146) */
function runHookSafely(pluginId: string, hook: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    logDiag(`plugin ${pluginId} ${hook} failed: ${String(e)}`);
  }
}

function createContext(pluginId: string): PluginContext {
  return {
    pluginId,
    notify: (msg: string) => {
      if (typeof window === "undefined") {
        // 非浏览器环境没有事件总线，至少不要静默丢失
        logDiag(`plugin ${pluginId} notify (no window): ${msg}`);
        return;
      }
      window.dispatchEvent(new CustomEvent("plugin-notify", { detail: { pluginId, msg } }));
    },
    getConversationMessages: () => messagesProvider?.() || [],
  };
}

export const pluginAPI: PluginAPI = {
  activate(id: string) {
    const p = plugins.get(id);
    if (p && !p.enabled) {
      p.enabled = true;
      runHookSafely(id, "onActivate", () => p.hooks.onActivate?.(createContext(id)));
    }
  },
  deactivate(id: string) {
    const p = plugins.get(id);
    if (p && p.enabled) {
      p.enabled = false;
      runHookSafely(id, "onDeactivate", () => p.hooks.onDeactivate?.());
    }
  },
  remove(id: string) {
    this.deactivate(id);
    plugins.delete(id);
  },
  getPlugin(id: string) {
    return plugins.get(id);
  },
  listPlugins() {
    return Array.from(plugins.values());
  },
  executeBeforeSend(content: string): string {
    let result = content;
    for (const p of plugins.values()) {
      const hook = p.hooks.beforeSend;
      if (!p.enabled || !hook) continue;
      runHookSafely(p.manifest.id, "beforeSend", () => {
        result = hook(result, createContext(p.manifest.id));
      });
    }
    return result;
  },
  executeAfterResponse(content: string): string {
    let result = content;
    for (const p of plugins.values()) {
      const hook = p.hooks.afterResponse;
      if (!p.enabled || !hook) continue;
      runHookSafely(p.manifest.id, "afterResponse", () => {
        result = hook(result, createContext(p.manifest.id));
      });
    }
    return result;
  },
  async executeCommand(cmd: string, args: string): Promise<string | null> {
    for (const p of plugins.values()) {
      const hook = p.hooks.onCommand;
      if (!p.enabled || !hook) continue;
      try {
        const result = await hook(cmd, args, createContext(p.manifest.id));
        if (result != null) return result;
      } catch (e) {
        logDiag(`plugin ${p.manifest.id} onCommand failed: ${String(e)}`);
      }
    }
    return null;
  },
};

export function registerPlugin(plugin: ChatPlugin) {
  plugins.set(plugin.manifest.id, plugin);
}
export function listPlugins(): ChatPlugin[] {
  return Array.from(plugins.values());
}
export function isPluginEnabled(id: string): boolean {
  return plugins.get(id)?.enabled ?? false;
}
