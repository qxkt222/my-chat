import { create } from "zustand";
import type { ChatPlugin } from "@/plugin/types";
import { registerPlugin, pluginAPI, listPlugins } from "@/plugin/PluginHost";
import { translatorPlugin } from "@/plugin/builtin/translator";
import { codeReviewerPlugin } from "@/plugin/builtin/code-reviewer";
import { promptTemplatesPlugin } from "@/plugin/builtin/prompt-templates";
import { webSearchPlugin } from "@/plugin/builtin/web-search";
import { summarizerPlugin } from "@/plugin/builtin/summarizer";
import { voiceInputPlugin } from "@/plugin/builtin/voice-input";
import { imageGenPlugin } from "@/plugin/builtin/image-gen";
import { ttsPlugin } from "@/plugin/builtin/tts";

// 插件启用状态持久化 key(重启恢复开关,修复"每次启动都要重开")
const PLUGIN_ENABLED_KEY = "plugin_enabled";

// Register all built-in plugins
[
  translatorPlugin,
  codeReviewerPlugin,
  promptTemplatesPlugin,
  webSearchPlugin,
  summarizerPlugin,
  voiceInputPlugin,
  imageGenPlugin,
  ttsPlugin,
].forEach(registerPlugin);

interface PluginState {
  plugins: ChatPlugin[];
  load: () => void;
  toggle: (id: string) => void;
  remove: (id: string) => void;
}

/** 读取持久化的启用集合(localStorage;缺失时按默认值) */
function loadEnabled(): Set<string> {
  try {
    const raw = localStorage.getItem(PLUGIN_ENABLED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function persistEnabled(ids: string[]) {
  localStorage.setItem(PLUGIN_ENABLED_KEY, JSON.stringify(ids));
}

export const usePluginStore = create<PluginState>((set) => ({
  plugins: [],
  load: () => {
    // 恢复持久化状态:先 apply,再刷新列表
    const enabled = loadEnabled();
    for (const p of listPlugins()) {
      const shouldEnable = enabled.has(p.manifest.id);
      const isOn = pluginAPI.getPlugin(p.manifest.id)?.enabled ?? false;
      if (shouldEnable && !isOn) pluginAPI.activate(p.manifest.id);
      if (!shouldEnable && isOn) pluginAPI.deactivate(p.manifest.id);
    }
    set({ plugins: listPlugins() });
  },
  toggle: (id) => {
    if (pluginAPI.getPlugin(id)?.enabled) pluginAPI.deactivate(id);
    else pluginAPI.activate(id);
    // 持久化当前启用集合(重启恢复)
    persistEnabled(listPlugins().filter((p) => p.enabled).map((p) => p.manifest.id));
    set({ plugins: [...listPlugins()] });
  },
  remove: (id) => {
    pluginAPI.remove(id);
    persistEnabled(listPlugins().filter((p) => p.enabled).map((p) => p.manifest.id));
    set({ plugins: [...listPlugins()] });
  },
}));
