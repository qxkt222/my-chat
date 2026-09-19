// plugin/PluginHost.ts — Plugin host & registry

import type { ChatPlugin, PluginAPI, PluginContext } from "./types";
import type { Message } from "@/types";

const plugins = new Map<string, ChatPlugin>();

// Messages provider (set by chat store to avoid circular imports)
let messagesProvider: (() => Message[]) | null = null;
export function setMessagesProvider(fn: () => Message[]) {
  messagesProvider = fn;
}

function createContext(pluginId: string): PluginContext {
  return {
    pluginId,
    notify: (msg: string) => {
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
      p.hooks.onActivate?.(createContext(id));
    }
  },
  deactivate(id: string) {
    const p = plugins.get(id);
    if (p && p.enabled) {
      p.enabled = false;
      p.hooks.onDeactivate?.();
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
      if (p.enabled && p.hooks.beforeSend)
        result = p.hooks.beforeSend(result, createContext(p.manifest.id));
    }
    return result;
  },
  executeAfterResponse(content: string): string {
    let result = content;
    for (const p of plugins.values()) {
      if (p.enabled && p.hooks.afterResponse)
        result = p.hooks.afterResponse(result, createContext(p.manifest.id));
    }
    return result;
  },
  async executeCommand(cmd: string, args: string): Promise<string | null> {
    for (const p of plugins.values()) {
      if (p.enabled && p.hooks.onCommand) {
        const result = await p.hooks.onCommand(cmd, args, createContext(p.manifest.id));
        if (result != null) return result;
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
