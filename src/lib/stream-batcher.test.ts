// lib/stream-batcher.test.ts — SRC-03 回归 / 三条链路共用的 rAF 合帧
//
// 背景(2026-10-23 审计):useChatStore 已有 pendingStreams + scheduleFlush,
// 但酒馆(useTavernStore)/ 推演(useSimulationStore)每个 token 直接 set,
// 高 token 速率下每帧多次重渲染。
//
// 本文件钉住的行为契约:
//   1. 同一帧内连续 50 次 add → 只 flush 一次,内容按到达顺序拼接;
//   2. flush 后缓冲清空,再 add 会重新排帧;
//   3. content / reasoning 走同一条合帧通路(不同字段分开累加);
//   4. 手动 flush() 会立即落出挂起内容(finish/cancel 前保底);
//   5. 没有挂起内容时不产生空 flush。

import { describe, it, expect, vi } from "vitest";
import { createStreamBatcher, type StreamDelta } from "./stream-batcher";

/** 可手动驱动的帧调度器:收集回调,由测试决定何时跑帧 */
function manualScheduler() {
  const queue: Array<() => void> = [];
  const schedule = vi.fn((cb: () => void) => {
    queue.push(cb);
  });
  return {
    schedule,
    /** 跑掉当前排队的帧 */
    tick() {
      const cbs = queue.splice(0, queue.length);
      for (const cb of cbs) cb();
      return cbs.length;
    },
    get queued() {
      return queue.length;
    },
  };
}

describe("createStreamBatcher", () => {
  it("连续 50 个 token 只 flush 一次,内容完整拼接", () => {
    const sched = manualScheduler();
    const flushed: Array<Map<string, StreamDelta>> = [];
    const b = createStreamBatcher<string>((batch) => flushed.push(batch), sched.schedule);

    for (let i = 0; i < 50; i += 1) b.add("msg1", { content: `t${i},` });

    // 帧还没跑:一次都不应 flush
    expect(flushed.length).toBe(0);
    expect(sched.schedule).toHaveBeenCalledTimes(1);

    sched.tick();

    expect(flushed.length).toBe(1);
    expect(flushed[0]?.get("msg1")?.content).toBe(
      Array.from({ length: 50 }, (_, i) => `t${i},`).join("")
    );
  });

  it("flush 后缓冲清空,下一次 add 重新排帧", () => {
    const sched = manualScheduler();
    const flushed: Array<Map<string, StreamDelta>> = [];
    const b = createStreamBatcher<string>((batch) => flushed.push(batch), sched.schedule);

    b.add("m", { content: "a" });
    sched.tick();
    b.add("m", { content: "b" });
    expect(sched.schedule).toHaveBeenCalledTimes(2);
    sched.tick();

    expect(flushed.length).toBe(2);
    expect(flushed[1]?.get("m")?.content).toBe("b");
  });

  it("content 与 reasoning 同一帧合并、不同字段分别累加", () => {
    const sched = manualScheduler();
    const flushed: Array<Map<string, StreamDelta>> = [];
    const b = createStreamBatcher<string>((batch) => flushed.push(batch), sched.schedule);

    b.add("m", { content: "正" });
    b.add("m", { reasoning: "想" });
    b.add("m", { content: "文" });
    b.add("m", { reasoning: "法" });
    sched.tick();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.get("m")).toEqual({ content: "正文", reasoning: "想法" });
  });

  it("多个 key 在同一帧内各自累加,一次 flush", () => {
    const sched = manualScheduler();
    const flushed: Array<Map<string, StreamDelta>> = [];
    const b = createStreamBatcher<string>((batch) => flushed.push(batch), sched.schedule);

    b.add("a", { content: "1" });
    b.add("b", { content: "2" });
    b.add("a", { content: "3" });
    sched.tick();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.get("a")?.content).toBe("13");
    expect(flushed[0]?.get("b")?.content).toBe("2");
  });

  it("手动 flush() 立即落出挂起内容,且不会在随后帧里重复", () => {
    const sched = manualScheduler();
    const flushed: Array<Map<string, StreamDelta>> = [];
    const b = createStreamBatcher<string>((batch) => flushed.push(batch), sched.schedule);

    b.add("m", { content: "x" });
    b.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.get("m")?.content).toBe("x");

    sched.tick();
    expect(flushed).toHaveLength(1); // 帧回调触发时缓冲已空,不产生空 flush

    b.flush(); // 手动再 flush 一次也不应产生空批
    expect(flushed).toHaveLength(1);
  });

  it("空增量(空串 token)不排帧、不产生 flush", () => {
    const sched = manualScheduler();
    const onFlush = vi.fn();
    const b = createStreamBatcher<string>(onFlush, sched.schedule);
    b.add("m", { content: "" });
    b.add("m", {});
    expect(sched.schedule).not.toHaveBeenCalled();
    sched.tick();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("没有挂起内容时 flush() 是 no-op", () => {
    const sched = manualScheduler();
    const onFlush = vi.fn();
    const b = createStreamBatcher<string>(onFlush, sched.schedule);
    b.flush();
    expect(onFlush).not.toHaveBeenCalled();
    expect(b.hasPending()).toBe(false);
  });
});
