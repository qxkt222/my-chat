// lib/summarize.test.ts — 三处摘要器合并后的唯一实现
//
// 旧实现（工作模式 / 酒馆 / 推演各一份）的核心缺陷：
//   `onError: () => resolve()` 把错误吞掉后，调用方只看 `acc.trim()` 是否非空，
//   于是「半截摘要」会被当成完整摘要持久化（甚至覆盖掉好摘要）。
// 新契约：runSummarize 返回 { summary, complete }，
//   只有 complete === true 且 summary 非空，调用方才允许落盘。
//
// 三种结局都在这里钉住：
//   1. onDone               → complete = true
//   2. 流中途 reject（半截） → complete = false + logDiag
//   3. onError（网络错误）   → complete = false + logDiag

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  streamChat: vi.fn(),
  logDiag: vi.fn(),
  cancelChat: vi.fn(),
}));

vi.mock("./tauri", () => mocks);

import { runSummarize, SUMMARIZE_THRESHOLD, SUMMARIZE_TIMEOUT_MS } from "./summarize";

const model = {
  name: "m1",
  provider: "openai",
  api_url: "https://api.example/v1",
  api_key: "sk-test",
  model: "m1-model",
};

type Handlers = {
  onToken: (d: string) => void;
  onReasoning?: (d: string) => void;
  onDone: () => void;
  onError: (e: string) => void;
};

describe("runSummarize", () => {
  beforeEach(() => {
    mocks.streamChat.mockReset();
    mocks.logDiag.mockReset();
    mocks.cancelChat.mockReset();
  });

  it("流正常完成 → complete=true，摘要 trim 后返回", async () => {
    mocks.streamChat.mockImplementation(
      (_req: unknown, _rid: string, h: Handlers): Promise<void> => {
        h.onToken("  关键事实：");
        h.onToken("用户喜欢猫  ");
        h.onDone();
        return Promise.resolve();
      }
    );

    const result = await runSummarize({
      model,
      systemPrompt: "sys",
      userContent: "transcript",
      label: "work-summarize",
    });

    expect(result).toEqual({ summary: "关键事实：用户喜欢猫", complete: true });
    expect(mocks.logDiag).not.toHaveBeenCalled();
    // model_config 统一走 toModelConfig（provider 原样）
    const req = mocks.streamChat.mock.calls[0]?.[0] as {
      model_config: Record<string, unknown>;
      temperature?: number;
      thinking_enabled?: boolean;
    };
    expect(req.model_config).toEqual({
      name: "m1",
      provider: "openai",
      api_url: "https://api.example/v1",
      api_key: "sk-test",
      model: "m1-model",
    });
    expect(req.temperature).toBe(0.3);
    expect(req.thinking_enabled).toBe(false);
  });

  it("流中途中断（有半截内容）→ complete=false + logDiag，半截内容不得视为完整", async () => {
    mocks.streamChat.mockImplementation(
      (_req: unknown, _rid: string, h: Handlers): Promise<void> => {
        h.onToken("半截摘");
        return Promise.reject(new Error("stream aborted"));
      }
    );

    const result = await runSummarize({
      model,
      systemPrompt: "sys",
      userContent: "transcript",
      label: "tavern-summarize",
    });

    expect(result.complete).toBe(false);
    expect(result.summary).toBe("半截摘"); // 内容仍返回，但由 complete 决定不落盘
    expect(mocks.logDiag).toHaveBeenCalledTimes(1);
    expect(String(mocks.logDiag.mock.calls[0]?.[0])).toContain("tavern-summarize");
    expect(String(mocks.logDiag.mock.calls[0]?.[0])).toContain("stream aborted");
  });

  it("网络错误（onError）→ complete=false + logDiag，保存的错误文本进日志", async () => {
    mocks.streamChat.mockImplementation(
      (_req: unknown, _rid: string, h: Handlers): Promise<void> => {
        h.onToken("半截");
        h.onError("network down");
        return Promise.resolve();
      }
    );

    const result = await runSummarize({
      model,
      systemPrompt: "sys",
      userContent: "transcript",
    });

    expect(result).toEqual({ summary: "半截", complete: false });
    expect(mocks.logDiag).toHaveBeenCalledTimes(1);
    expect(String(mocks.logDiag.mock.calls[0]?.[0])).toContain("network down");
  });

  it("什么都没产出（onError 前无 token）→ summary 为空串 + complete=false", async () => {
    mocks.streamChat.mockImplementation(
      (_req: unknown, _rid: string, h: Handlers): Promise<void> => {
        h.onError("429");
        return Promise.resolve();
      }
    );

    const result = await runSummarize({
      model,
      systemPrompt: "sys",
      userContent: "transcript",
    });
    expect(result.summary).toBe("");
    expect(result.complete).toBe(false);
  });

  it("onToken 进度回调按累计长度上报（任务面板进度）", async () => {
    const onProgress = vi.fn();
    mocks.streamChat.mockImplementation(
      (_req: unknown, _rid: string, h: Handlers): Promise<void> => {
        h.onToken("1234");
        h.onToken("56");
        h.onDone();
        return Promise.resolve();
      }
    );

    await runSummarize({
      model,
      systemPrompt: "sys",
      userContent: "transcript",
      onProgress,
    });
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([4, 6]);
  });

  it("阈值只在 summarize.ts 定义，值为 15", () => {
    expect(SUMMARIZE_THRESHOLD).toBe(15);
  });
});

// ── T-117:done 事件丢失时的前端兜底超时 ─────────────────────────────
describe("runSummarize 前端超时（T-117）", () => {
  beforeEach(() => {
    mocks.streamChat.mockReset();
    mocks.logDiag.mockReset();
    mocks.cancelChat.mockReset();
  });

  it("done 永不到达 → 超时后 complete=false、取消后端流、写诊断日志", async () => {
    vi.useFakeTimers();
    try {
      // 事件监听已注册但流永不结束（模拟 done 事件丢失）
      mocks.streamChat.mockImplementation(() => new Promise<void>(() => {}));

      const pending = runSummarize({
        model,
        systemPrompt: "sys",
        userContent: "transcript",
        label: "work-compress",
        timeoutMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;

      expect(result).toEqual({ summary: "", complete: false });
      expect(mocks.cancelChat).toHaveBeenCalledTimes(1);
      expect(String(mocks.logDiag.mock.calls[0]?.[0])).toContain("timeout");
      expect(String(mocks.logDiag.mock.calls[0]?.[0])).toContain("work-compress");
    } finally {
      vi.useRealTimers();
    }
  });

  it("超时后迟到的 onDone 不得把 complete 翻回 true", async () => {
    vi.useFakeTimers();
    try {
      let handlers: Handlers | undefined;
      mocks.streamChat.mockImplementation(
        (_req: unknown, _rid: string, h: Handlers): Promise<void> => {
          handlers = h;
          return new Promise<void>(() => {});
        }
      );
      const pending = runSummarize({
        model,
        systemPrompt: "sys",
        userContent: "transcript",
        timeoutMs: 500,
      });
      await vi.advanceTimersByTimeAsync(500);
      handlers?.onToken("迟到内容");
      handlers?.onDone();
      const result = await pending;
      expect(result).toEqual({ summary: "", complete: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("超时后重试成功（状态已清理，可再次压缩）", async () => {
    vi.useFakeTimers();
    try {
      mocks.streamChat.mockImplementationOnce(() => new Promise<void>(() => {}));
      const first = runSummarize({
        model,
        systemPrompt: "sys",
        userContent: "a",
        timeoutMs: 100,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect((await first).complete).toBe(false);

      mocks.streamChat.mockImplementationOnce(
        (_req: unknown, _rid: string, h: Handlers): Promise<void> => {
          h.onToken("重试成功");
          h.onDone();
          return Promise.resolve();
        }
      );
      const second = await runSummarize({
        model,
        systemPrompt: "sys",
        userContent: "b",
        timeoutMs: 100,
      });
      expect(second).toEqual({ summary: "重试成功", complete: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("默认超时常量存在（180s）", () => {
    expect(SUMMARIZE_TIMEOUT_MS).toBe(180_000);
  });
});
