import { create } from "zustand";
import type { Message, ChatRequest, ModelConfig } from "@/types";
import { streamChat, cancelChat, classifyError, logDiag } from "@/lib/tauri";
import { budgetFor, shrinkMessages } from "@/lib/context-budget";
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

// 工具与常量抽到 ./chat/utils.ts（它们与 store 状态无关）
// 注：下面的 pendingStreams / flushPendingStreams 依赖 useChatStore.setState，
// 搬出去会形成循环依赖，故有意留在本文件。
import {
  msgId,
  nowISO,
  WORK_SUMMARIZE_KEY,
  WORK_SUMMARIZE_THRESHOLD,
  WORK_TEMP_MODE_KEY,
} from "./chat/utils";
import { assembleRpMessages } from "./chat/rp-messages";
// 世界书四源合并与酒馆共用同一份实现（含「群聊归组」那类约定），不再各写一遍
import { collectLorebooks } from "./tavern/assembly";

/** 流式 token 合帧(rAF):每个 requestId 待刷新的 token 累积,每帧最多一次 set。
 *   finish()/cancel 前需 flush 挂起帧,否则最后一批 token 会丢。 */
const pendingStreams = new Map<string, { content: string; reasoning: string }>();
let flushScheduled = false;

/** 立即刷新挂起的流式帧(供 finish/cancel 在读取最终值前调用) */
function flushPendingStreams(): void {
  if (pendingStreams.size === 0) return;
  const batch = new Map(pendingStreams);
  pendingStreams.clear();
  useChatStore.setState((s) => {
    const streamingContent = { ...s.streamingContent };
    const streamingReasoning = { ...s.streamingReasoning };
    for (const [rid, p] of batch) {
      if (p.content) streamingContent[rid] = (streamingContent[rid] || "") + p.content;
      if (p.reasoning) streamingReasoning[rid] = (streamingReasoning[rid] || "") + p.reasoning;
    }
    return { streamingContent, streamingReasoning };
  });
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
    opts?: { skipUserAppend?: boolean }
  ) => Promise<void>;
  cancelGeneration: (requestId?: string) => void;
  regenerate: () => Promise<void>;
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
  workAutoSummarize: localStorage.getItem(WORK_SUMMARIZE_KEY) === "1",
  workTempMode: localStorage.getItem(WORK_TEMP_MODE_KEY) === "1",

  sendMessage: async (content, models, systemPrompt, knowledgeContext, opts) => {
    const convStore = useConversationStore.getState();
    const settingsStore = useSettingsStore.getState();
    let convId = convStore.activeId;

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
    const conv = convStore.getActive();
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

    // Run all streams concurrently
    await Promise.all(
      streams.map(({ requestId, msgId: asmId, modelName, modelConfig }) => {
        // F2 per-model 参数：模型自带参数优先，无则回退全局默认
        const temperature =
          modelConfig.parameters?.temperature ?? settingsStore.defaultParameters.temperature ?? 0.7;
        const maxTokens =
          modelConfig.parameters?.max_tokens ?? settingsStore.defaultParameters.max_tokens ?? null;

        // Token 预算(自动模式):发送前按优先级收缩,历史超限整段替换为摘要
        // (保三段式前缀稳定,DeepSeek 缓存不失效)。手动模式只统计不砍。
        const settings = useSettingsStore.getState();
        const shrunk = shrinkMessages(messages, budgetFor(modelConfig, settings.budgetConfig), {
          mode: settings.budgetConfig.mode,
          summary: conv?.summary,
        });
        const finalMessages = shrunk.messages;
        const request: ChatRequest = {
          model_config: {
            name: modelConfig.name,
            provider: modelConfig.provider || "",
            api_url: modelConfig.api_url,
            api_key: modelConfig.api_key,
            model: modelConfig.model,
          },
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
          // Final flush so the last tokens + reasoning are persisted (once per turn)
          if (entry) {
            if (finalContent) {
              // 响应后处理钩子(插件 afterResponse):落盘前应用
              const processed = pluginAPI.executeAfterResponse(finalContent);
              convStore.updateMessage(entry.convId, asmId, processed);
            }
            if (finalReasoning)
              convStore.updateMessageReasoning(entry.convId, asmId, finalReasoning);
            // F4 + 错误命名化: 分类与内容分离落盘——失败不污染消息正文
            if (finalError)
              convStore.updateMessageError(entry.convId, asmId, finalError, finalErrorKind);
          }
        };

        return streamChat(request, requestId, {
          // 流式 token 合帧(rAF):每个 token 直接 set 会在高 token 速率下触发
          // 每帧多次重渲染(React 18 自动批处理跨异步边界有限)。合帧后每帧最多
          // 一次 set → 流式渲染节奏与屏幕刷新对齐,CPU 峰值下降。
          onToken: (delta) => {
            const pend = pendingStreams.get(requestId) || { content: "", reasoning: "" };
            pend.content += delta;
            pendingStreams.set(requestId, pend);
            if (!flushScheduled) {
              flushScheduled = true;
              requestAnimationFrame(() => {
                flushScheduled = false;
                if (pendingStreams.size === 0) return;
                const batch = new Map(pendingStreams);
                pendingStreams.clear();
                set((s) => {
                  const streamingContent = { ...s.streamingContent };
                  const streamingReasoning = { ...s.streamingReasoning };
                  for (const [rid, p] of batch) {
                    if (p.content) {
                      streamingContent[rid] = (streamingContent[rid] || "") + p.content;
                    }
                    if (p.reasoning) {
                      streamingReasoning[rid] = (streamingReasoning[rid] || "") + p.reasoning;
                    }
                  }
                  return { streamingContent, streamingReasoning };
                });
              });
            }
          },
          onReasoning: (delta) => {
            // 与 onToken 同一 rAF 合帧(思考 token 与正文 token 交错到达,合并刷新)
            const pend = pendingStreams.get(requestId) || { content: "", reasoning: "" };
            pend.reasoning += delta;
            pendingStreams.set(requestId, pend);
            if (!flushScheduled) {
              flushScheduled = true;
              requestAnimationFrame(() => {
                flushScheduled = false;
                if (pendingStreams.size === 0) return;
                const batch = new Map(pendingStreams);
                pendingStreams.clear();
                set((s) => {
                  const streamingContent = { ...s.streamingContent };
                  const streamingReasoning = { ...s.streamingReasoning };
                  for (const [rid, p] of batch) {
                    if (p.content) {
                      streamingContent[rid] = (streamingContent[rid] || "") + p.content;
                    }
                    if (p.reasoning) {
                      streamingReasoning[rid] = (streamingReasoning[rid] || "") + p.reasoning;
                    }
                  }
                  return { streamingContent, streamingReasoning };
                });
              });
            }
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

    // 记忆卡(工作模式自动记忆):回合完成,检查是否需要自动摘要(记账式阈值,只跑一次)。
    // 临时会话(免记忆)不触发。
    if (!get().workTempMode) {
      void get().summarizeIfNeeded(convId as string);
    }
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
      if (asmId && entry && cur) convStore.updateMessage(entry.convId, asmId, cur);
      if (asmId && entry && err) convStore.updateMessageError(entry.convId, asmId, err, errKind);
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

  regenerate: async () => {
    const convStore = useConversationStore.getState();
    const conv = convStore.getActive();
    if (!conv) return;

    // Find last user message
    const lastUserMsg = [...conv.messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return;

    // 行业标准(regenerate = replay the last turn):user 消息保留不动,
    // 只删除并替换尾部的 assistant 回复(s)。
    await convStore.removeLastAssistantMessage(conv.id);
    // If multiple models answered in parallel, remove all trailing assistant messages of this turn
    // 循环内重新取活跃会话,避免引用过期导致死循环
    for (;;) {
      const cur = convStore.getActive();
      if (!cur) break;
      if (cur.messages[cur.messages.length - 1]?.role !== "assistant") break;
      await convStore.removeLastAssistantMessage(conv.id);
    }

    // Re-send with the same model(s) — skipUserAppend:不新增重复的 user 消息
    const settingsStore = useSettingsStore.getState();
    const model = settingsStore.models.find((m) => m.name === settingsStore.activeModel);
    if (!model) return;

    await get().sendMessage(lastUserMsg.content, [model], conv.system_prompt, undefined, {
      skipUserAppend: true,
    });
  },

  compressContext: async () => {
    const convStore = useConversationStore.getState();
    const conv = convStore.getActive();
    if (!conv || conv.messages.length === 0) return;
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

    showToast("info", t("chat.compressing"));

    // Raw streaming call — does NOT touch the conversation (no user/assistant msgs added)
    const summary = await new Promise<string>((resolve) => {
      const requestId = msgId();
      let acc = "";
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve(acc);
        }
      };
      streamChat(
        {
          model_config: {
            name: model.name,
            provider: "",
            api_url: model.api_url,
            api_key: model.api_key,
            model: model.model,
          },
          messages: [
            { role: "system", content: sys },
            { role: "user", content: transcript },
          ],
          temperature: 0.3,
          thinking_enabled: false,
        },
        requestId,
        {
          onToken: (d) => {
            acc += d;
          },
          onDone: done,
          onError: (e) => {
            logDiag(`compress err: ${String(e)}`);
            done();
          },
        }
      );
    }).catch(() => "");

    if (!summary.trim()) {
      showToast("error", t("chat.compressFailed"));
      return;
    }

    // Replace history with a system summary + keep it out of the next reply
    const now = new Date().toISOString();
    await convStore.replaceMessages(conv.id, [
      {
        id: msgId(),
        role: "system",
        content: `【此前对话摘要】\n${summary.trim()}`,
        timestamp: now,
      },
    ]);
    showToast("success", t("chat.compressSuccess"));
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
    const conv = convStore.conversations.find((c) => c.id === convId);
    if (!conv || conv.messages.length === 0) return;
    const settingsStore = useSettingsStore.getState();
    const model = settingsStore.models.find((m) => m.name === settingsStore.activeModel);
    if (!model) return;
    // 记账式阈值:距上次摘要新增消息数 ≥ N 才总结(不随清空/压缩漂移)
    const lastCount = conv.summary_msg_count ?? 0;
    if (conv.messages.length - lastCount < WORK_SUMMARIZE_THRESHOLD) return;

    // 后台任务队列(20):摘要走独立任务跑,不阻塞发送链路;侧栏「任务」面板可见进度
    const taskStore = useTaskStore.getState();
    await taskStore.enqueue("自动记忆摘要", async (report) => {
      const cur = useConversationStore.getState().conversations.find((c) => c.id === convId);
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

      let acc = "";
      try {
        await new Promise<void>((resolve) => {
          void streamChat(
            {
              model_config: {
                name: model.name,
                provider: model.provider || "",
                api_url: model.api_url,
                api_key: model.api_key,
                model: model.model,
              },
              messages: [
                { role: "system", content: sys },
                {
                  role: "user",
                  content: cur.summary
                    ? `【已有摘要】\n${cur.summary}\n\n【新增对话】\n${transcript}`
                    : transcript,
                },
              ],
              temperature: 0.3,
              thinking_enabled: false,
            },
            msgId(),
            {
              onToken: (d) => {
                acc += d;
                report(Math.min(90, 10 + acc.length)); // 进度:流式长度近似
              },
              onDone: () => resolve(),
              onError: () => resolve(),
            }
          );
        });
      } catch {
        /* 摘要失败静默,不影响主流程 */
      }
      const summary = acc.trim();
      if (summary) {
        // 记账:记住总结时的消息数(阈值判定用),摘要持久化
        await useConversationStore.getState().updateSummary(convId, summary, cur.messages.length);
      }
      report(100);
      return summary ? `已更新摘要(${summary.length} 字)` : "摘要为空";
    });
  },
}));
