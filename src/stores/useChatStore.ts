import { create } from "zustand";
import type { Message, ChatRequest, ModelConfig } from "@/types";
import { streamChat, cancelChat, classifyError, logDiag } from "@/lib/tauri";
import { budgetFor } from "@/lib/context-budget";
import { prepareOutgoingMessages } from "@/lib/outgoing-regex";
import { toModelConfig } from "@/lib/model-config";
import { runSummarize, SUMMARIZE_THRESHOLD } from "@/lib/summarize";
import { maybeWarnBudget } from "@/lib/budget-warning";
import { showToast } from "@/components/ui/Toast";
import { t } from "@/lib/i18n";
import { buildRpSystemParts } from "@/lib/rp-prompt";
import { useConversationStore } from "./useConversationStore";
import { useSettingsStore } from "./useSettingsStore";
import { useAdapterStore } from "./useAdapterStore";
import { useCharacterStore } from "./useCharacterStore";
import { useCacheStatsStore } from "./useCacheStatsStore";
import { useTaskStore } from "./useTaskStore";
import { setMessagesProvider, pluginAPI } from "@/plugin/PluginHost";
import { createStreamBatcher } from "@/lib/stream-batcher";

// 工具与常量抽到 ./chat/utils.ts（它们与 store 状态无关）
// 注：合帧算法在 lib/stream-batcher.ts（纯实现，三处 store 共用）；
// 只有 flush 回调（依赖 useChatStore.setState）留在这里，避免循环依赖。
import { msgId, nowISO, WORK_SUMMARIZE_KEY, WORK_TEMP_MODE_KEY } from "./chat/utils";
import { assembleRpMessages } from "./chat/rp-messages";
// 世界书四源合并与酒馆共用同一份实现（含「群聊归组」那类约定），不再各写一遍
import { collectLorebooks } from "./tavern/assembly";

/** 流式 token 合帧(rAF):每个 requestId 待刷新的 token 累积,每帧最多一次 set。
 *   finish()/cancel 前需 flush 挂起帧,否则最后一批 token 会丢。
 *   合帧算法与酒馆/推演共用 lib/stream-batcher(审计 SRC-03)。 */
const streamBatcher = createStreamBatcher<string>((batch) => {
  useChatStore.setState((s) => {
    const streamingContent = { ...s.streamingContent };
    const streamingReasoning = { ...s.streamingReasoning };
    for (const [rid, p] of batch) {
      if (p.content) streamingContent[rid] = (streamingContent[rid] || "") + p.content;
      if (p.reasoning) streamingReasoning[rid] = (streamingReasoning[rid] || "") + p.reasoning;
    }
    return { streamingContent, streamingReasoning };
  });
});

/** 立即刷新挂起的流式帧(供 finish/cancel 在读取最终值前调用) */
function flushPendingStreams(): void {
  streamBatcher.flush();
}

/** requestId → sendMessage 的收尾回调。回调在最终正文写入会话 store 之后触发，
 *  让发送 Promise 的 resolve 时间点 = 正文可被读到的时刻 (T-021)。 */
const streamSettlers = new Map<string, (finalText: string) => void>();

/** 收尾某条流：把最终正文交给等待中的 sendMessage（重复调用安全） */
function settleStream(requestId: string, finalText: string): void {
  const settle = streamSettlers.get(requestId);
  if (!settle) return;
  streamSettlers.delete(requestId);
  settle(finalText);
}

// Register messages provider for plugins
setMessagesProvider(() => {
  const conv = useConversationStore.getState().getActive();
  return conv?.messages || [];
});

interface ChatState {
  /** True while at least one model is streaming */
  isStreaming: boolean;
  /** Content per in-flight stream, keyed by request id */
  streamingContent: Record<string, string>;
  /** Reasoning/thinking text per in-flight stream */
  streamingReasoning: Record<string, string>;
  /** Error text per in-flight stream (F4: kept separate from content) */
  streamErrors: Record<string, string>;
  /** 错误分类 per in-flight stream（错误命名化：rate_limit/timeout/…） */
  streamErrorKinds: Record<string, string>;
  /** request ids of all in-flight streams */
  activeStreams: string[];
  /** msgId → {requestId, convId} 映射：流式期间前端气泡直接读 streamingContent，
   *  conversations 数组保持不动（P1-1：流式不再每 250ms 重写数组/落盘） */
  streamMsgMap: Record<string, { requestId: string; convId: string }>;
  /** 正在做上下文压缩的会话：期间 sendMessage / regenerate 一律拒绝 (T-019) */
  compressingConvIds: string[];
  /** 工作模式自动记忆(记忆卡):历史超阈值自动摘要注入上下文(默认关,防意外耗 token) */
  workAutoSummarize: boolean;
  /** 临时会话(免记忆):开启时本次会话完全不读写记忆(ChatGPT Memory 临时对话) */
  workTempMode: boolean;

  sendMessage: (
    content: string,
    models: {
      api_url: string;
      api_key: string;
      model: string;
      name: string;
      temperature?: number | null;
      max_tokens?: number | null;
    }[],
    systemPrompt?: string,
    knowledgeContext?: string,
    /** 重新生成专用:不新增 user 消息(行业标准:replay the last turn,
     *  user 消息保持不动,只替换 AI 回复)——避免旧 user + 新 user 重复 */
    opts?: {
      skipUserAppend?: boolean;
      /** T-034: 钉住的发送目标会话；缺省仍取当前 activeId（兼容旧调用）。
       *  预处理期间用户切走会话时，消息不会落到新会话。 */
      convId?: string | undefined;
    }
  ) => Promise<string>;
  cancelGeneration: (requestId?: string) => void;
  /** 重新生成：传 msgId 时只重生成该气泡（并用它的模型）；
   *  不传时保持旧行为「重生成最后一轮 assistant」。 */
  regenerate: (msgId?: string) => Promise<void>;
  /** Context compression (Chatbox): summarize history, clear old messages, seed summary */
  compressContext: () => Promise<void>;
  /** 工作模式自动记忆(记忆卡):回合完成后检查,历史超阈值自动总结合并进 conv.summary */
  summarizeIfNeeded: (convId: string) => Promise<void>;
  setWorkAutoSummarize: (on: boolean) => void;
  setWorkTempMode: (on: boolean) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  isStreaming: false,
  streamingContent: {},
  streamingReasoning: {},
  streamErrors: {},
  streamErrorKinds: {},
  activeStreams: [],
  streamMsgMap: {},
  compressingConvIds: [],
  workAutoSummarize: localStorage.getItem(WORK_SUMMARIZE_KEY) === "1",
  workTempMode: localStorage.getItem(WORK_TEMP_MODE_KEY) === "1",

  sendMessage: async (content, models, systemPrompt, knowledgeContext, opts) => {
    const convStore = useConversationStore.getState();
    const settingsStore = useSettingsStore.getState();
    // T-034: 调用方可钉死目标会话（ChatInput 在预处理开始时就传入）。
    // 缺省仍取「当前」activeId，保持旧调用方行为不变。
    let convId = opts?.convId ?? convStore.activeId;

    // T-019: 压缩上下文期间该会话禁止发送——压缩完成后会以摘要替换历史，
    // 期间发出的回合会被一并清掉；直接拒绝并提示，而不是静默排队。
    if (convId && get().compressingConvIds.includes(convId)) {
      showToast("info", t("chat.compressing"));
      return "";
    }

    if (!convId) {
      const conv = await convStore.create();
      convId = conv.id;
    }

    // Run plugin hooks: beforeSend
    const processedContent = pluginAPI.executeBeforeSend(content);

    const userMsg: Message = {
      id: msgId(),
      role: "user",
      content: processedContent,
      timestamp: nowISO(),
    };

    // Build messages array with cache-friendly ordering (DeepSeek prompt cache):
    // stable prefix first (system prompt + history), variable tail last
    // (new user message + knowledge context). Keeping the knowledge context at
    // the END means only the tail changes between turns → prefix stays cached.
    // T-034: 组装历史必须用「钉住的会话」，不能用 getActive()——预处理期间
    // 用户切走后 activeId 已指向别的会话，历史会拼错。
    const liveConvStore = useConversationStore.getState();
    const conv = opts?.convId
      ? (liveConvStore.allConversations.find((c) => c.id === convId) ??
        liveConvStore.conversations.find((c) => c.id === convId))
      : liveConvStore.getActive();
    const messages: Pick<Message, "role" | "content">[] = [];

    // RP 会话(带角色卡):三段式组装(DeepSeek 缓存优化核心——stableSystem 前缀恒定,
    // 世界书/摘要尾部可变,只尾部变 → 前缀持续命中)
    if (conv?.character_id) {
      const charStore = useCharacterStore.getState();
      const card = charStore.characters.find((c) => c.id === conv.character_id);
      if (card) {
        const persona =
          charStore.personas.find((p) => p.id === conv.persona_id) ||
          charStore.getActivePersona() ||
          null;
        // 世界书四源合并复用酒馆那份实现（同一套优先级，不再各写一遍）
        const books = collectLorebooks({
          globalLorebook: charStore.globalLorebook,
          card,
          enabledIds: charStore.enabledLorebookIds,
          personaIds: persona?.lorebookIds || [],
          convIds: conv.lorebookIds || [],
          byId: charStore.lorebooks,
        });
        const parts = buildRpSystemParts({
          card,
          persona,
          preset: charStore.presets,
          baseSystemPrompt: systemPrompt,
          lorebooks: books,
          recentMessages: conv.messages,
          currentInput: processedContent,
          summary: conv.summary,
        });
        // 三段式组装（含深度提示词注入位置）抽到 ./chat/rp-messages.ts，那边有测试守着
        messages.push(
          ...assembleRpMessages({
            stableSystem: parts.stableSystem,
            history: conv.messages,
            lorebook: parts.lorebook,
            summary: parts.summary,
            depthPrompt: parts.depthPrompt,
          })
        );
      } else {
        // 角色卡被删,回退普通逻辑
        if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
        for (const m of conv.messages) {
          if (m.role !== "system") messages.push({ role: m.role, content: m.content });
        }
      }
    } else {
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      for (const m of conv?.messages || []) {
        if (m.role !== "system") {
          messages.push({ role: m.role, content: m.content });
        }
      }
    }

    // 当前轮用户输入：必须在历史之后、变量尾段（知识库/摘要）之前。
    // 之前这里漏掉了这一条 —— messages 只从 conv.messages（旧历史）组装，
    // 导致工作模式每轮发给模型的内容里没有用户刚输入的那句话。
    // 用 processedContent（插件 beforeSend 之后），不是原始 content。
    // skipUserAppend（重新生成）：历史末尾已经有这条 user 消息，不能再追加。
    if (!opts?.skipUserAppend) {
      messages.push({ role: "user", content: processedContent });
    }

    // Knowledge context goes LAST (variable tail, does not invalidate the prefix)
    if (knowledgeContext) {
      messages.push({ role: "system", content: `Reference Knowledge:\n${knowledgeContext}` });
    }

    // 记忆卡(工作模式自动记忆):自动摘要注入消息尾部(变量尾,不动 stableSystem 前缀
    // → 缓存友好)。RP 会话的摘要已在三段式内注入,这里只处理普通会话。
    if (!conv?.character_id && conv?.summary) {
      messages.push({ role: "system", content: `【对话摘要】\n${conv.summary}` });
    }

    // One assistant placeholder + one stream per model (一问多答, Cherry-style)
    const streams: {
      requestId: string;
      msgId: string;
      modelName: string;
      modelConfig: ModelConfig;
    }[] = [];
    const assistantMsgs: Message[] = [];
    for (const m of models) {
      const assistantMsg: Message = {
        id: msgId(),
        role: "assistant",
        content: "",
        timestamp: nowISO(),
        model: m.model || m.name,
      };
      assistantMsgs.push(assistantMsg);
      streams.push({
        requestId: msgId(),
        msgId: assistantMsg.id,
        modelName: m.name,
        modelConfig: m as ModelConfig,
      });
    }

    // P1 热路径批量化：用户消息 + N 条 assistant 占位一次 IPC 写库
    // （原实现 2+2N 次 dbAddMsg/dbCreateConv 往返 → 1 次 batch_add_messages）
    // skipUserAppend(重新生成)：user 消息已在历史中，只追加 assistant 占位
    await convStore.addMessagesBatch(
      convId,
      opts?.skipUserAppend ? assistantMsgs : [userMsg, ...assistantMsgs]
    );

    set((s) => ({
      isStreaming: true,
      activeStreams: [...s.activeStreams, ...streams.map((x) => x.requestId)],
      streamingContent: {
        ...s.streamingContent,
        ...Object.fromEntries(streams.map((x) => [x.requestId, ""])),
      },
      streamingReasoning: {
        ...s.streamingReasoning,
        ...Object.fromEntries(streams.map((x) => [x.requestId, ""])),
      },
      streamErrors: {
        ...s.streamErrors,
        ...Object.fromEntries(streams.map((x) => [x.requestId, ""])),
      },
      streamErrorKinds: {
        ...s.streamErrorKinds,
        ...Object.fromEntries(streams.map((x) => [x.requestId, ""])),
      },
      streamMsgMap: {
        ...s.streamMsgMap,
        ...Object.fromEntries(
          streams.map((x) => [x.msgId, { requestId: x.requestId, convId: convId as string }])
        ),
      },
    }));

    // T-021: 每条流注册一个收尾等待器 —— finish() 在最终正文写入会话 store
    // 之后才 resolve 它；sendMessage 等全部收尾完成再返回，prompt 链因此不会
    // 在「正文还没落库」时读到空占位。
    const completions = streams.map(
      ({ requestId }) =>
        new Promise<string>((resolve) => {
          streamSettlers.set(requestId, resolve);
        })
    );

    // Run all streams concurrently
    await Promise.all(
      streams.map(({ requestId, msgId: asmId, modelName, modelConfig }) => {
        // F2 per-model 参数：模型自带参数优先，无则回退全局默认
        const temperature =
          modelConfig.parameters?.temperature ?? settingsStore.defaultParameters.temperature ?? 0.7;
        const maxTokens =
          modelConfig.parameters?.max_tokens ?? settingsStore.defaultParameters.max_tokens ?? null;

        // 发送前准备(三条链路共用):预算收缩(自动模式,历史超限整段替换为摘要,
        // 保三段式前缀稳定) → 出站正则清理(placement=2,只作用于待发副本)。
        // 手动模式只统计不砍。
        const settings = useSettingsStore.getState();
        const shrunk = prepareOutgoingMessages(messages, {
          budget: budgetFor(modelConfig, settings.budgetConfig),
          mode: settings.budgetConfig.mode,
          summary: conv?.summary,
          regexRules: settings.regexRules,
        });
        // 接近/超出预算时主动提醒(只弹 Toast,不影响发送)
        maybeWarnBudget(convId, shrunk.total, shrunk.budget);
        const finalMessages = shrunk.messages;
        const request: ChatRequest = {
          model_config: toModelConfig(modelConfig),
          messages: finalMessages,
          temperature,
          max_tokens: maxTokens,
          // 采样器(酒馆 API 响应配置):模型参数优先,回退全局默认
          top_p: modelConfig.parameters?.top_p ?? settingsStore.defaultParameters.top_p ?? null,
          top_k: modelConfig.parameters?.top_k ?? settingsStore.defaultParameters.top_k ?? null,
          repetition_penalty:
            modelConfig.parameters?.repetition_penalty ??
            settingsStore.defaultParameters.repetition_penalty ??
            null,
          frequency_penalty:
            modelConfig.parameters?.frequency_penalty ??
            settingsStore.defaultParameters.frequency_penalty ??
            null,
          presence_penalty:
            modelConfig.parameters?.presence_penalty ??
            settingsStore.defaultParameters.presence_penalty ??
            null,
          min_p: modelConfig.parameters?.min_p ?? settingsStore.defaultParameters.min_p ?? null,
          mirostat:
            modelConfig.parameters?.mirostat ?? settingsStore.defaultParameters.mirostat ?? null,
          mirostat_tau:
            modelConfig.parameters?.mirostat_tau ??
            settingsStore.defaultParameters.mirostat_tau ??
            null,
          mirostat_eta:
            modelConfig.parameters?.mirostat_eta ??
            settingsStore.defaultParameters.mirostat_eta ??
            null,
          dry_multiplier:
            modelConfig.parameters?.dry_multiplier ??
            settingsStore.defaultParameters.dry_multiplier ??
            null,
          dry_base:
            modelConfig.parameters?.dry_base ?? settingsStore.defaultParameters.dry_base ?? null,
          dry_allowed_length:
            modelConfig.parameters?.dry_allowed_length ??
            settingsStore.defaultParameters.dry_allowed_length ??
            null,
          dry_penalty_last_n:
            modelConfig.parameters?.dry_penalty_last_n ??
            settingsStore.defaultParameters.dry_penalty_last_n ??
            null,
          system_prompt: systemPrompt,
          knowledge_context: knowledgeContext,
          thinking_enabled: settingsStore.thinkingEnabled,
          reasoning_effort: settingsStore.reasoningEffort,
          // 停止字符串(酒馆 Stopping Strings):全局配置,非空才发送
          stopping_strings:
            settingsStore.stoppingStrings.length > 0 ? settingsStore.stoppingStrings : null,
          // Attach the active custom API template (adapter subsystem) if one is selected
          template: useAdapterStore.getState().getActive() || undefined,
        };

        // P1-1: 流式期间不调 updateMessage（不重写 conversations 数组、不落盘），
        // 气泡直接读 streamingContent；仅完成/取消时一次性落盘。
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          // 合帧补偿:先 flush 挂起帧,再读最终值(否则最后一批 token 丢失)
          flushPendingStreams();
          // Capture final values BEFORE removing them from the maps —
          // the final flush below would otherwise read undefined.
          const finalContent = get().streamingContent[requestId] || "";
          const finalReasoning = get().streamingReasoning[requestId] || "";
          const finalError = get().streamErrors[requestId] || "";
          const finalErrorKind = get().streamErrorKinds[requestId] || "";
          const entry = get().streamMsgMap[asmId];

          // T-021: 先把最终正文落库，再从流式状态移除 —— 顺序反过来时，
          // 「清空流式覆盖」与「updateMessage 的 set」之间气泡会闪成空占位，
          // 且 sendMessage 会在正文可读之前 resolve。
          const persist = (async (): Promise<string> => {
            if (!entry) return "";
            let out = "";
            if (finalContent) {
              // 响应后处理钩子(插件 afterResponse):落盘前应用
              const processed = pluginAPI.executeAfterResponse(finalContent);
              out = processed;
              await convStore.updateMessage(entry.convId, asmId, processed);
            }
            if (finalReasoning)
              await convStore.updateMessageReasoning(entry.convId, asmId, finalReasoning);
            // F4 + 错误命名化: 分类与内容分离落盘——失败不污染消息正文
            if (finalError)
              await convStore.updateMessageError(entry.convId, asmId, finalError, finalErrorKind);
            return out;
          })();

          const cleanup = () => {
            set((s) => {
              const activeStreams = s.activeStreams.filter((id) => id !== requestId);
              const streamingContent = { ...s.streamingContent };
              delete streamingContent[requestId];
              const streamingReasoning = { ...s.streamingReasoning };
              delete streamingReasoning[requestId];
              const streamErrors = { ...s.streamErrors };
              delete streamErrors[requestId];
              const streamErrorKinds = { ...s.streamErrorKinds };
              delete streamErrorKinds[requestId];
              const streamMsgMap = { ...s.streamMsgMap };
              delete streamMsgMap[asmId];
              return {
                activeStreams,
                streamingContent,
                streamingReasoning,
                streamErrors,
                streamErrorKinds,
                streamMsgMap,
                isStreaming: activeStreams.length > 0,
              };
            });
          };

          // 落库成功/失败都要清理流式状态并放行等待者（不能把 UI 卡在流式中）
          void persist.then(
            (text) => {
              cleanup();
              settleStream(requestId, text);
            },
            () => {
              cleanup();
              settleStream(requestId, "");
            }
          );
        };

        return streamChat(request, requestId, {
          // 流式 token 合帧(rAF):每个 token 直接 set 会在高 token 速率下触发
          // 每帧多次重渲染(React 18 自动批处理跨异步边界有限)。合帧后每帧最多
          // 一次 set → 流式渲染节奏与屏幕刷新对齐,CPU 峰值下降。
          onToken: (delta) => {
            streamBatcher.add(requestId, { content: delta });
          },
          onReasoning: (delta) => {
            // 与 onToken 同一 rAF 合帧(思考 token 与正文 token 交错到达,合并刷新)
            streamBatcher.add(requestId, { reasoning: delta });
          },
          onDone: (cache) => {
            // DeepSeek 缓存命中率:全部记录进诊断面板(设置→缓存);
            // toast 只在命中率偏低(<50%)时提示——高命中是常态,每条都弹是噪音
            if (cache && cache.hit + cache.miss > 0) {
              const pct = Math.round((cache.hit / (cache.hit + cache.miss)) * 100);
              useCacheStatsStore.getState().recordCache(modelConfig.name, cache.hit, cache.miss);
              if (pct < 50) {
                showToast(
                  "info",
                  t("chat.cacheHit", { pct, hit: cache.hit, total: cache.hit + cache.miss })
                );
              }
            }
            finish();
          },
          onError: (err) => {
            logDiag(`Chat error (${modelName}): ${String(err)}`);
            const raw = typeof err === "string" ? err : String(err ?? "");
            const classified = classifyError(raw);
            const short = (raw || t("chat.unknownError")).slice(0, 300);
            // F4 + 错误命名化: 分类结果写进 streamErrors（差异化横幅渲染），不拼进正文
            set((s) => ({
              streamErrors: { ...s.streamErrors, [requestId]: short },
              streamErrorKinds: { ...s.streamErrorKinds, [requestId]: classified.kind },
            }));
            finish();
            showToast("error", t("chat.requestFailedToast", { name: modelName }));
          },
        });
      })
    );

    // T-021: 等到所有流把最终正文写进会话 store 才算完成。
    const finalTexts = await Promise.all(completions);
    // 多模型对比没有唯一正文：取最后一个有内容的流（prompt 链只发单模型）。
    const finalText = [...finalTexts].reverse().find((text) => text) ?? "";

    // 记忆卡(工作模式自动记忆):回合完成,检查是否需要自动摘要(记账式阈值,只跑一次)。
    // 临时会话(免记忆)不触发。
    if (!get().workTempMode) {
      void get().summarizeIfNeeded(convId);
    }
    return finalText;
  },

  cancelGeneration: (requestId?: string) => {
    const { activeStreams } = get();
    const convStore = useConversationStore.getState();
    const targets = requestId ? [requestId] : activeStreams;
    for (const id of targets) {
      cancelChat(id);
      // 合帧补偿:取消前先 flush 挂起帧(否则取消时已生成但未刷新的内容会丢)
      flushPendingStreams();
      // P1-1 补偿：流式期间没写盘，取消时把已生成内容落盘一次
      const pair = Object.entries(get().streamMsgMap).find(([, v]) => v.requestId === id);
      const asmId = pair?.[0];
      const entry = pair?.[1];
      const cur = get().streamingContent[id] || "";
      const err = get().streamErrors[id] || "";
      const errKind = get().streamErrorKinds[id] || "";
      const pending: Promise<void>[] = [];
      if (asmId && entry && cur) pending.push(convStore.updateMessage(entry.convId, asmId, cur));
      if (asmId && entry && err)
        pending.push(convStore.updateMessageError(entry.convId, asmId, err, errKind));
      // T-021: 取消路径不依赖迟到的 done 事件 —— 主动放行等待中的 sendMessage，
      // 否则「取消后 done 丢失」会让发送 Promise 永远挂着。顺序同样保持
      // 「先落库、再 resolve」：等待上面两笔写库完成后再放行。
      void Promise.allSettled(pending).then(() => settleStream(id, ""));
      // Drop the listener immediately so no further tokens arrive
      set((s) => {
        const streamingContent = { ...s.streamingContent };
        delete streamingContent[id];
        const streamingReasoning = { ...s.streamingReasoning };
        delete streamingReasoning[id];
        const streamErrors = { ...s.streamErrors };
        delete streamErrors[id];
        const streamErrorKinds = { ...s.streamErrorKinds };
        delete streamErrorKinds[id];
        const streamMsgMap = { ...s.streamMsgMap };
        if (asmId) delete streamMsgMap[asmId];
        return {
          streamingContent,
          streamingReasoning,
          streamErrors,
          streamErrorKinds,
          streamMsgMap,
          activeStreams: s.activeStreams.filter((x) => x !== id),
          isStreaming: s.activeStreams.filter((x) => x !== id).length > 0,
        };
      });
    }
  },

  regenerate: async (msgId) => {
    // T-020: 流式期间点重试会删掉正在流式的占位消息并再开一条流
    // → 并发双流、双倍 API 消耗。入口直接拒绝。
    if (get().isStreaming) return;

    const convStore = useConversationStore.getState();
    const conv = convStore.getActive();
    if (!conv) return;
    if (get().compressingConvIds.includes(conv.id)) return;

    // 目标：指定气泡（旧气泡重试）或最后一轮的全部 assistant（旧行为）。
    let userMsg: Message | undefined;
    let trailingAssistants: Message[] = [];
    if (msgId) {
      const idx = conv.messages.findIndex((m) => m.id === msgId);
      const target = idx >= 0 ? conv.messages[idx] : undefined;
      if (!target || target.role !== "assistant") return;
      for (let i = idx - 1; i >= 0; i--) {
        const m = conv.messages[i];
        if (m?.role === "user") {
          userMsg = m;
          break;
        }
      }
      if (!userMsg) return;
    } else {
      let lastUserIdx = -1;
      for (let i = conv.messages.length - 1; i >= 0; i--) {
        if (conv.messages[i]?.role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx < 0) return;
      const picked = conv.messages[lastUserIdx];
      if (!picked) return;
      userMsg = picked;
      trailingAssistants = conv.messages
        .slice(lastUserIdx + 1)
        .filter((m) => m.role === "assistant");
      if (trailingAssistants.length === 0) return;
    }
    if (!userMsg) return;

    // T-020: 先解析模型再删消息——模型为空（被删/未选）时不得静默丢上一条回复。
    // 指定气泡优先用它自己的模型（对比模式逐路处理），回退当前模型。
    const settingsStore = useSettingsStore.getState();
    const targetModelName = msgId
      ? conv.messages.find((m) => m.id === msgId)?.model || settingsStore.activeModel
      : settingsStore.activeModel;
    const model =
      settingsStore.models.find((m) => m.name === targetModelName) ??
      (targetModelName !== settingsStore.activeModel
        ? settingsStore.models.find((m) => m.name === settingsStore.activeModel)
        : undefined);
    if (!model) return;

    // 行业标准(regenerate = replay the last turn):user 消息保留不动,
    // 只删除并替换目标 assistant 回复(s)。
    if (msgId) {
      await convStore.removeMessage(conv.id, msgId);
    } else {
      for (let i = 0; i < trailingAssistants.length; i++) {
        await convStore.removeLastAssistantMessage(conv.id);
      }
    }

    // skipUserAppend:不新增重复的 user 消息
    await get().sendMessage(userMsg.content, [model], conv.system_prompt, undefined, {
      skipUserAppend: true,
    });
  },

  compressContext: async () => {
    const convStore = useConversationStore.getState();
    const conv = convStore.getActive();
    if (!conv || conv.messages.length === 0) return;
    // 压缩完成后会以摘要替换历史；流式中的占位消息不能被清掉。
    if (get().isStreaming) return;
    const convId = conv.id;
    if (get().compressingConvIds.includes(convId)) return;
    const settingsStore = useSettingsStore.getState();
    const model = settingsStore.models.find((m) => m.name === settingsStore.activeModel);
    if (!model) return;

    // Ask the current model to summarize the whole conversation
    const transcript = conv.messages
      .map(
        (m) =>
          `${m.role === "user" ? "用户" : "AI"}${m.model ? `(${m.model})` : ""}：\n${m.content.slice(0, 1500)}`
      )
      .join("\n\n---\n\n")
      .slice(0, 12000);

    const sys =
      "你是对话总结器。请把以下对话提炼成精炼的中文摘要（保留关键事实、结论、用户偏好、未决问题），300字以内，只输出摘要正文。";

    // T-019: 压缩期间置忙碌标志（输入框禁用、sendMessage/regenerate 拒绝）。
    // baselineCount 是压缩期间「可被摘要替换」的消息数基线。
    const baselineCount = conv.messages.length;
    set((s) => ({ compressingConvIds: [...s.compressingConvIds, convId] }));
    try {
      showToast("info", t("chat.compressing"));

      // Raw streaming call — does NOT touch the conversation (no user/assistant msgs added)。
      // 只有流完整结束才允许用它替换历史：中断时的半截摘要会永久丢上下文。
      const result = await runSummarize({
        model,
        systemPrompt: sys,
        userContent: transcript,
        label: "work-compress",
      });
      const summary = result.summary;
      if (!result.complete || !summary) {
        showToast("error", t("chat.compressFailed"));
        return;
      }

      // Replace history with a system summary. 基线校验在 replaceMessages 内：
      // 压缩期间新增的消息合并保留；期间消息被删则放弃替换 (T-019)。
      const now = new Date().toISOString();
      const replaced = await convStore.replaceMessages(
        convId,
        [
          {
            id: msgId(),
            role: "system",
            content: `【此前对话摘要】\n${summary}`,
            timestamp: now,
          },
        ],
        baselineCount
      );
      if (!replaced) {
        showToast("error", t("chat.compressFailed"));
        return;
      }
      showToast("success", t("chat.compressSuccess"));
    } finally {
      set((s) => ({
        compressingConvIds: s.compressingConvIds.filter((id) => id !== convId),
      }));
    }
  },

  setWorkAutoSummarize: (on) => {
    localStorage.setItem(WORK_SUMMARIZE_KEY, on ? "1" : "0");
    set({ workAutoSummarize: on });
  },

  setWorkTempMode: (on) => {
    localStorage.setItem(WORK_TEMP_MODE_KEY, on ? "1" : "0");
    set({ workTempMode: on });
  },

  summarizeIfNeeded: async (convId) => {
    // 记忆卡(工作模式自动记忆,对齐酒馆 Summarize):历史超阈值 → 用当前模型
    // 总结并合并进 conv.summary(经 Rust 持久化,重启保留)。与手动"压缩上下文"
    // 的区别:不删消息、只维护滚动摘要,注入消息尾部(缓存友好)。
    if (!get().workAutoSummarize || get().workTempMode) return;
    const convStore = useConversationStore.getState();
    // 必须查全量列表：`conversations` 只是当前子模式的可见视图，用户可能在一个
    // 会话流式途中切到另一个子模式，此时会话仍在 allConversations 但不在可见列表。
    // 全量列表为空时回退可见列表（兼容测试/旧调用方注入方式）。
    const conv =
      convStore.allConversations.find((c) => c.id === convId) ??
      convStore.conversations.find((c) => c.id === convId);
    if (!conv || conv.messages.length === 0) return;
    const settingsStore = useSettingsStore.getState();
    const model = settingsStore.models.find((m) => m.name === settingsStore.activeModel);
    if (!model) return;
    // 记账式阈值:距上次摘要新增消息数 ≥ N 才总结(不随清空/压缩漂移)
    const lastCount = conv.summary_msg_count ?? 0;
    if (conv.messages.length - lastCount < SUMMARIZE_THRESHOLD) return;

    // 后台任务队列(20):摘要走独立任务跑,不阻塞发送链路;侧栏「任务」面板可见进度
    const taskStore = useTaskStore.getState();
    await taskStore.enqueue("自动记忆摘要", async (report) => {
      // 同上：后台任务期间用户可能已切子模式，按全量列表找
      const cs = useConversationStore.getState();
      const cur =
        cs.allConversations.find((c) => c.id === convId) ??
        cs.conversations.find((c) => c.id === convId);
      if (!cur || cur.messages.length === 0) return "";
      // 已有摘要 + 全部消息 → 合并式总结;无摘要 → 首轮总结
      const transcript = cur.messages
        .map(
          (m) =>
            `${m.role === "user" ? "用户" : "AI"}${m.model ? `(${m.model})` : ""}：\n${m.content.slice(0, 800)}`
        )
        .join("\n\n---\n\n")
        .slice(0, 9000);
      const sys = cur.summary
        ? "你是对话记忆管理员。下面是已有的对话摘要和新增对话。请把新增内容合并进摘要，保留关键事实、结论、用户偏好、未决问题，输出一份精炼的中文摘要（500 字内），只输出摘要正文，不要任何前后缀。"
        : "你是对话记忆管理员。请把以下对话提炼成精炼的中文摘要（保留关键事实、结论、用户偏好、未决问题），500 字内，只输出摘要正文。";

      const result = await runSummarize({
        model,
        systemPrompt: sys,
        userContent: cur.summary
          ? `【已有摘要】\n${cur.summary}\n\n【新增对话】\n${transcript}`
          : transcript,
        label: "work-summarize",
        onProgress: (chars) => report(Math.min(90, 10 + chars)), // 进度:流式长度近似
      });
      const summary = result.summary;
      // 只有完整结束才落盘：中断时的半截摘要会覆盖掉上一份好摘要
      if (result.complete && summary) {
        // 记账:记住总结时的消息数(阈值判定用),摘要持久化
        await useConversationStore.getState().updateSummary(convId, summary, cur.messages.length);
      }
      report(100);
      return result.complete && summary ? `已更新摘要(${summary.length} 字)` : "摘要为空";
    });
  },
}));
