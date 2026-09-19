// plugin/types.ts — Plugin type definitions

import type { Message } from "@/types";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
}

export interface PluginHooks {
  /** Transform user message before sending to AI */
  beforeSend?: (content: string, context: PluginContext) => string;
  /** Transform AI response before displaying */
  afterResponse?: (content: string, context: PluginContext) => string;
  /** Handle a custom command — return null to indicate "not handled" */
  onCommand?: (cmd: string, args: string, context: PluginContext) => Promise<string | null>;
  /** Called when plugin is activated */
  onActivate?: (context: PluginContext) => void;
  /** Called when plugin is deactivated */
  onDeactivate?: () => void;
}

export interface PluginContext {
  pluginId: string;
  /** Show toast notification */
  notify: (message: string) => void;
  /** Get current conversation context */
  getConversationMessages: () => Message[];
}

export interface ChatPlugin {
  manifest: PluginManifest;
  hooks: PluginHooks;
  enabled: boolean;
}

export interface PluginAPI {
  activate(pluginId: string): void;
  deactivate(pluginId: string): void;
  remove(pluginId: string): void;
  getPlugin(id: string): ChatPlugin | undefined;
  listPlugins(): ChatPlugin[];
  executeBeforeSend(content: string): string;
  executeAfterResponse(content: string): string;
  /** Dispatch a slash command (e.g. "/search foo") to enabled plugins. Returns the first non-null result. */
  executeCommand(cmd: string, args: string): Promise<string | null>;
}
