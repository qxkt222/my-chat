// @vitest-environment jsdom
//
// PluginHost 回归（T-146/T-147）：
//   - 任一插件 hook 抛错只隔离该插件，消息发送/落盘链路不中断，且必须留日志；
//   - ctx.notify 的事件此前全仓无监听 → 现在必须转成可见 toast，不能静默丢弃。

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({ logDiag: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ showToast: vi.fn() }));

import { pluginAPI, registerPlugin } from "./PluginHost";
import { logDiag } from "@/lib/tauri";
import { showToast } from "@/components/ui/Toast";
import type { ChatPlugin } from "./types";

const registeredIds: string[] = [];

function makePlugin(id: string, hooks: ChatPlugin["hooks"]): ChatPlugin {
  const plugin: ChatPlugin = {
    manifest: { id, name: id, version: "1.0.0", description: "", author: "test" },
    hooks,
    enabled: false,
  };
  registerPlugin(plugin);
  registeredIds.push(id);
  return plugin;
}

afterEach(() => {
  for (const id of registeredIds.splice(0)) pluginAPI.remove(id);
  vi.clearAllMocks();
});

describe("PluginHost hook 隔离（T-146）", () => {
  it("beforeSend 抛错只跳过该插件，消息继续交给后续插件", () => {
    makePlugin("t146-bad-before", {
      beforeSend: () => {
        throw new Error("boom-before");
      },
    });
    makePlugin("t146-good-before", { beforeSend: (s) => `${s}!` });
    pluginAPI.activate("t146-bad-before");
    pluginAPI.activate("t146-good-before");

    expect(pluginAPI.executeBeforeSend("hi")).toBe("hi!");
    expect(vi.mocked(logDiag)).toHaveBeenCalledWith(expect.stringContaining("beforeSend"));
  });

  it("afterResponse 抛错不吞掉已处理结果，后续插件继续", () => {
    makePlugin("t146-good-after", { afterResponse: (s) => `${s}!` });
    makePlugin("t146-bad-after", {
      afterResponse: () => {
        throw new Error("boom-after");
      },
    });
    pluginAPI.activate("t146-good-after");
    pluginAPI.activate("t146-bad-after");

    expect(pluginAPI.executeAfterResponse("hi")).toBe("hi!");
    expect(vi.mocked(logDiag)).toHaveBeenCalledWith(expect.stringContaining("afterResponse"));
  });

  it("onActivate 抛错不冒泡，插件仍标记为已启用", () => {
    makePlugin("t146-bad-activate", {
      onActivate: () => {
        throw new Error("boom-activate");
      },
    });

    expect(() => pluginAPI.activate("t146-bad-activate")).not.toThrow();
    expect(pluginAPI.getPlugin("t146-bad-activate")?.enabled).toBe(true);
    expect(vi.mocked(logDiag)).toHaveBeenCalledWith(expect.stringContaining("onActivate"));
  });

  it("onDeactivate 抛错不阻断 remove", () => {
    makePlugin("t146-bad-deactivate", {
      onDeactivate: () => {
        throw new Error("boom-deactivate");
      },
    });
    pluginAPI.activate("t146-bad-deactivate");

    expect(() => pluginAPI.remove("t146-bad-deactivate")).not.toThrow();
    expect(pluginAPI.getPlugin("t146-bad-deactivate")).toBeUndefined();
    expect(vi.mocked(logDiag)).toHaveBeenCalledWith(expect.stringContaining("onDeactivate"));
  });

  it("onCommand 抛错时继续尝试后续插件", async () => {
    makePlugin("t146-bad-cmd", {
      onCommand: () => Promise.reject(new Error("boom-cmd")),
    });
    makePlugin("t146-good-cmd", {
      onCommand: async (cmd) => (cmd === "go" ? "ok" : null),
    });
    pluginAPI.activate("t146-bad-cmd");
    pluginAPI.activate("t146-good-cmd");

    await expect(pluginAPI.executeCommand("go", "")).resolves.toBe("ok");
    expect(vi.mocked(logDiag)).toHaveBeenCalledWith(expect.stringContaining("onCommand"));
  });
});

describe("ctx.notify 可见提示（T-147）", () => {
  it("插件 ctx.notify 派发的事件被转成 toast，不再静默丢弃", () => {
    makePlugin("t147-notify", {
      onActivate: (ctx) => ctx.notify("hello"),
    });

    pluginAPI.activate("t147-notify");

    expect(vi.mocked(showToast)).toHaveBeenCalledWith("info", "[t147-notify] hello");
  });
});
