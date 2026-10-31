// @vitest-environment jsdom
// stores/usePluginStore.test.ts — T-032 回归:插件启用状态必须在启动时恢复
//
// 背景(2026-10-31 审计):App 引导只 load 8 个 store,漏了 usePluginStore;
// 启用状态只在打开「设置→插件」页时恢复,重启后 /translate、/search、
// /summarize 等斜杠命令一律落到「未知命令」,code-reviewer 的 beforeSend 也不生效。
//
// 本文件钉住两条契约:
//   1. load() 按 localStorage 的 plugin_enabled 恢复启用状态;
//   2. load() 幂等 —— PluginManager 挂载时还会再调一次,不能重复激活/重复注册。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { usePluginStore } from "./usePluginStore";
import { pluginAPI, registerPlugin } from "@/plugin/PluginHost";
import type { ChatPlugin } from "@/plugin/types";

const KEY = "plugin_enabled";

/** 读取 store 中指定插件的启用态 */
function isEnabled(id: string): boolean | undefined {
  return usePluginStore.getState().plugins.find((p) => p.manifest.id === id)?.enabled;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  pluginAPI.remove("test-probe");
  localStorage.clear();
});

describe("usePluginStore.load", () => {
  it("load() 后已启用插件出现在 store 的启用列表里", () => {
    localStorage.setItem(KEY, JSON.stringify(["builtin-translator", "builtin-code-reviewer"]));

    usePluginStore.getState().load();

    expect(isEnabled("builtin-translator")).toBe(true);
    expect(isEnabled("builtin-code-reviewer")).toBe(true);
    expect(isEnabled("builtin-summarizer")).toBe(false);
    const enabledIds = usePluginStore
      .getState()
      .plugins.filter((p) => p.enabled)
      .map((p) => p.manifest.id)
      .sort();
    expect(enabledIds).toEqual(["builtin-code-reviewer", "builtin-translator"]);
  });

  it("重复调用 load() 不会重复注册/重复激活", () => {
    let activations = 0;
    const probe: ChatPlugin = {
      manifest: {
        id: "test-probe",
        name: "Test Probe",
        version: "1.0.0",
        description: "probe",
        author: "test",
      },
      hooks: {
        onActivate: () => {
          activations += 1;
        },
      },
      enabled: false,
    };
    registerPlugin(probe);
    localStorage.setItem(KEY, JSON.stringify(["test-probe"]));

    usePluginStore.getState().load();
    const idsAfterFirst = usePluginStore.getState().plugins.map((p) => p.manifest.id);

    usePluginStore.getState().load();

    expect(activations).toBe(1);
    expect(isEnabled("test-probe")).toBe(true);
    // 列表不因重复 load 膨胀,同一插件只出现一次
    const idsAfterSecond = usePluginStore.getState().plugins.map((p) => p.manifest.id);
    expect(idsAfterSecond).toEqual(idsAfterFirst);
    expect(idsAfterSecond.filter((id) => id === "test-probe")).toHaveLength(1);
  });
});
