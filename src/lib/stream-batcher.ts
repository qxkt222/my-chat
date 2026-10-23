// lib/stream-batcher.ts — 流式 token 的 rAF 合帧(三条链路共用)
//
// 审计 SRC-03:工作模式(useChatStore)已有 pendingStreams + scheduleFlush,
// 酒馆/推演却在每个 onToken 里直接 set({ conversations }) → 高 token 速率下
// 每帧多次重渲染。这里把「按 key 累加 + 每帧最多一次 flush」抽成与 store
// 无关的纯实现,三处复用同一份语义(避免再手抄第三、第四份)。
//
// 生命周期:
//   add(key, delta)  → 累加进待写缓冲,并(若尚未排帧)排一个动画帧
//   flush()          → 立即交出当前缓冲(给 finish/cancel 在读取最终值前保底)
//
// 注意:flush 回调里做 set 时,绝不能再去读「已挂起但未刷新」的值 —— 所以
// store 的 finish() 必须先 flush 再读 get()。

export interface StreamDelta {
  content?: string;
  reasoning?: string;
}

export type FlushHandler<K extends string> = (batch: Map<K, StreamDelta>) => void;

/** 帧调度器:默认 rAF;非浏览器环境(测试/主进程)退化为 16ms 定时器 */
export type FrameScheduler = (flush: () => void) => void;

const defaultScheduler: FrameScheduler = (flush) => {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => flush());
  } else {
    setTimeout(flush, 16);
  }
};

export interface StreamBatcher<K extends string> {
  /** 累加一个 token(正文/思考共用同一条合帧通路) */
  add(key: K, delta: StreamDelta): void;
  /** 立即刷新挂起内容;没有挂起内容时是 no-op */
  flush(): void;
  hasPending(): boolean;
}

export interface StreamMessage {
  id: string;
  content: string;
  reasoning?: string | undefined;
}

/**
 * 把一批流式增量应用到会话列表,返回新列表(以及是否真的有变化)。
 * 未命中的会话/消息保持原对象引用 → React 侧可继续依赖引用相等跳过重渲染。
 * 酒馆与推演的 onFlush 共用这一份,避免两处各写一遍 map/map。
 */
export function applyStreamDeltas<C extends { messages: M[] }, M extends StreamMessage>(
  conversations: readonly C[],
  batch: ReadonlyMap<string, StreamDelta>
): { conversations: C[]; changed: boolean } {
  let changed = false;
  const next = conversations.map((conv) => {
    let convChanged = false;
    const messages = conv.messages.map((m): M => {
      const delta = batch.get(m.id);
      if (!delta || (!delta.content && !delta.reasoning)) return m;
      convChanged = true;
      const updated = {
        ...m,
        content: delta.content ? m.content + delta.content : m.content,
      } as M;
      if (delta.reasoning) updated.reasoning = (m.reasoning ?? "") + delta.reasoning;
      return updated;
    });
    if (!convChanged) return conv;
    changed = true;
    return { ...conv, messages };
  });
  return { conversations: next, changed };
}

export function createStreamBatcher<K extends string>(
  onFlush: FlushHandler<K>,
  schedule: FrameScheduler = defaultScheduler
): StreamBatcher<K> {
  const pending = new Map<K, StreamDelta>();
  let scheduled = false;

  const flush = (): void => {
    if (pending.size === 0) return;
    // 先取走再回调:回调里若发生重入 add,应进入下一帧而不是本轮
    const batch = new Map(pending);
    pending.clear();
    onFlush(batch);
  };

  return {
    add(key, delta) {
      // 空增量(空串 token)不排帧,避免无意义的重渲染
      if (!delta.content && !delta.reasoning) return;
      const cur = pending.get(key);
      if (cur) {
        if (delta.content) cur.content = (cur.content ?? "") + delta.content;
        if (delta.reasoning) cur.reasoning = (cur.reasoning ?? "") + delta.reasoning;
      } else {
        pending.set(key, {
          ...(delta.content ? { content: delta.content } : {}),
          ...(delta.reasoning ? { reasoning: delta.reasoning } : {}),
        });
      }
      if (scheduled) return;
      scheduled = true;
      schedule(() => {
        scheduled = false;
        flush();
      });
    },
    flush,
    hasPending() {
      return pending.size > 0;
    },
  };
}
