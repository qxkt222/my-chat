// lib/emotion.test.ts — SRC-04 回归:表情图存在性检测的进程内缓存
//
// 背景(2026-10-23 审计):TavernView 的 effect 对每条 assistant 消息调用
// emotionImageExists() → 每次都经 Rust readFile 把整张 PNG 读回来。
// 100 条消息 × 每帧 = 100 次 IPC + 整图读盘。
//
// 契约:同一路径在一个进程内最多 readFile 一次(命中/未命中都缓存),
//       结果不失效 —— 表情图缺失时本来就会回退角色头像。

import { describe, it, expect, vi, beforeEach } from "vitest";

const readFile = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>(async () => "png"));

vi.mock("@/lib/tauri", () => ({ readFile }));

import { emotionImageExists, clearEmotionImageCache } from "./emotion";

beforeEach(() => {
  readFile.mockClear();
  readFile.mockResolvedValue("png");
  clearEmotionImageCache();
});

describe("emotionImageExists 缓存", () => {
  it("同一路径第二次调用不再触发 readFile", async () => {
    expect(await emotionImageExists("/a/happy.png")).toBe(true);
    expect(await emotionImageExists("/a/happy.png")).toBe(true);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("文件不存在的路径也缓存(第二次不再读盘)", async () => {
    readFile.mockRejectedValueOnce(new Error("ENOENT"));

    expect(await emotionImageExists("/a/missing.png")).toBe(false);
    expect(await emotionImageExists("/a/missing.png")).toBe(false);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("不同路径各自读一次", async () => {
    await emotionImageExists("/a/happy.png");
    await emotionImageExists("/a/sad.png");
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("null/空路径直接 false,不读盘", async () => {
    expect(await emotionImageExists(null)).toBe(false);
    expect(await emotionImageExists("")).toBe(false);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("缓存命中不关心 readFile 之后是否成功(结果稳定)", async () => {
    await emotionImageExists("/a/happy.png"); // 第一次成功
    readFile.mockRejectedValue(new Error("disk gone"));
    expect(await emotionImageExists("/a/happy.png")).toBe(true);
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
