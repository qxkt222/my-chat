// lib/summarize.ts — 自动记忆摘要器的唯一实现（工作模式 / 酒馆 / 推演共用）
//
// 合并前三个 store 各有一份逐行同构的实现（transcript 截断 800/9000、同一套
// 「记忆管理员」提示词、`onError: () => resolve()`）。共同缺陷是：
//   流被中断（网络断开 / Rust 侧取消）时，包装 Promise 通过 onError 静默 resolve，
//   调用方只判断 `acc.trim()` 非空，于是**半截摘要会被当成完整摘要落盘**，
//   甚至覆盖掉上一份好摘要。
//
// 新契约：返回 { summary, complete }。
//   complete === true 仅在收到 onDone 时成立。调用方必须同时满足
//   `complete === true && summary.trim()` 才允许持久化。
//
// 失败/中断一律走 lib/tauri 的 logDiag（不新增通道），带 label 便于在
// chat_errors.log 里区分是哪条链路。

import type { ModelConfigSource } from "./model-config";
import { toModelConfig } from "./model-config";
import { cancelChat, logDiag, streamChat } from "./tauri";

/** 自动摘要阈值：距上次摘要新增消息数（三条链路共用） */
export const SUMMARIZE_THRESHOLD = 15;

/**
 * 前端兜底超时（T-117）：摘要完全依赖 Rust 侧事件推进，`done` 一旦丢失，
 * Promise 就永远悬着，调用方的「压缩中」忙碌状态也永远不解除。
 * 超时后主动取消后端流（cancelChat）并返回 complete=false，调用方即可清理
 * 状态、给用户报错并允许重试。
 */
export const SUMMARIZE_TIMEOUT_MS = 180_000;

export interface SummarizeOptions {
  model: ModelConfigSource;
  /** 系统提示词（首轮总结 / 合并已有摘要各不同，由调用方决定） */
  systemPrompt: string;
  /** 用户内容（transcript，或【已有摘要】+【新增对话】） */
  userContent: string;
  /** 诊断标签：失败日志前缀，如 "work-summarize" */
  label?: string;
  /** 流式进度：累计字符数（任务面板进度条用） */
  onProgress?: (chars: number) => void;
  /** 采样温度（默认 0.3，与旧实现一致） */
  temperature?: number;
  /** 前端超时毫秒数（默认 SUMMARIZE_TIMEOUT_MS；测试可调小） */
  timeoutMs?: number;
}

export interface SummarizeResult {
  /** 已生成的内容（trim 过），中断时可能是半截，调用方靠 complete 判断 */
  summary: string;
  /** 是否收到流结束信号（onDone）。false = 失败或中断，禁止落盘 */
  complete: boolean;
}

/**
 * 跑一次摘要流。永不抛错：失败返回 complete=false，并写 logDiag。
 */
export async function runSummarize(opts: SummarizeOptions): Promise<SummarizeResult> {
  const label = opts.label ?? "summarize";
  let acc = "";
  let complete = false;

  const requestId = crypto.randomUUID();
  const request = {
    model_config: toModelConfig(opts.model),
    messages: [
      { role: "system" as const, content: opts.systemPrompt },
      { role: "user" as const, content: opts.userContent },
    ],
    temperature: opts.temperature ?? 0.3,
    thinking_enabled: false,
  };

  await new Promise<void>((resolve) => {
    let settled = false;
    let failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };

    // 前端兜底超时：done 事件丢失时结束等待，并主动中断 Rust 侧流，
    // 否则会一直占用请求/连接。complete 保持 false，半截内容不会落盘。
    const timeoutMs = opts.timeoutMs ?? SUMMARIZE_TIMEOUT_MS;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        logDiag(`${label} timeout after ${timeoutMs}ms (request_id=${requestId})`);
        cancelChat(requestId);
        finish();
      }, timeoutMs);
    }

    // streamChat 自身的 Promise 只覆盖「事件监听注册 + invoke 启动」，
    // 流内容由回调推进——所以这里不能 await 它的 resolve，只能接住 reject。
    void Promise.resolve(
      streamChat(request, requestId, {
        onToken: (d) => {
          // 超时/取消后的迟到 token 不再推进进度或内容
          if (settled) return;
          acc += d;
          opts.onProgress?.(acc.length);
        },
        onDone: () => {
          if (settled) return;
          complete = true;
          finish();
        },
        onError: (e) => {
          if (settled) return;
          failed = true;
          logDiag(`${label} error: ${String(e)}`);
          finish();
        },
      })
    ).catch((e: unknown) => {
      // 流中途中断（mock/未来实现可能表现为 reject）：半截内容保留，
      // 但 complete 保持 false，调用方不会落盘。
      if (!failed) logDiag(`${label} interrupted: ${String(e)}`);
      finish();
    });
  });

  return { summary: acc.trim(), complete };
}
