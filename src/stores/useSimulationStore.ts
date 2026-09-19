import { create } from "zustand";
import type {
  Message,
  ModelConfig,
  SimPacing,
  SimulationConversation,
  SimStateMode,
  SimStateUpdate,
  SimType,
} from "@/types";
import { getAppDir, readFile, writeFile, listDir, deleteItem, memSearch } from "@/lib/tauri";
import { streamChat, cancelChat } from "@/lib/tauri";
import { useSettingsStore } from "./useSettingsStore";
import {
  buildSimSystemParts,
  parseStateTable,
  parseStateText,
  parseTimeLabel,
  parseTimelineLines,
} from "@/lib/sim-prompt";
import { budgetFor, shrinkMessages } from "@/lib/context-budget";

function uuid(): string {
  return crypto.randomUUID();
}
function nowISO(): string {
  return new Date().toISOString();
}

/** 自动记忆(记忆卡,对齐酒馆 Summarize)开关持久化 */
const AUTO_SUMMARIZE_KEY = "sim_auto_summarize";
/** 自动摘要阈值:距上次摘要新增消息数 */
const SUMMARIZE_THRESHOLD = 15;
/** 惰性状态同步:距上次同步 N 次推演后自动刷一次 */
const LAZY_SYNC_INTERVAL = 5;

/** 推演类型徽标文案(新建会话标题前缀) */
const TYPE_TITLE: Record<SimType, string> = {
  story: "剧情推演",
  sandbox: "世界沙盒",
  tactical: "战术行动",
};

export interface CreateSimOptions {
  type: SimType;
  stateMode: SimStateMode;
  pacing: SimPacing;
  stateUpdate: SimStateUpdate;
  autoRounds: number;
  setup: string;
}

interface SimulationState {
  conversations: SimulationConversation[];
  activeId: string | null;
  isStreaming: boolean;
  /** 世界状态同步流进行中(状态面板小指示) */
  isSyncing: boolean;
  activeRequestId: string | null;
  /** 自动记忆开关(会话级全局,localStorage) */
  autoSummarize: boolean;
  /** 自动连续推演取消标志(continueRounds 循环检查) */
  cancelRounds: boolean;
  loaded: boolean;

  load: () => Promise<void>;
  create: (opts: CreateSimOptions) => Promise<SimulationConversation>;
  saveConv: (conv: SimulationConversation) => Promise<void>;
  removeConv: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  /** 通用会话级 setter:浅合并字段并落盘 */
  patch: (id: string, p: Partial<SimulationConversation>) => Promise<void>;
  addTimelineEntry: (id: string, time: string, event: string) => Promise<void>;
  removeTimelineEntry: (id: string, idx: number) => Promise<void>;
  /** 双记忆槽(26):Author's Note 第二槽 */
  setNote: (id: string, note: string) => Promise<void>;
  /** 钉住区(40):关键承诺/伏笔/关系钉入常驻上下文 */
  setPinned: (id: string, pinned: string) => Promise<void>;
  /** 观察/干预双通道(43):旁观模式切换 */
  setObserverMode: (id: string, on: boolean) => Promise<void>;
  /** 漂移回锚(39):手动产出回锚摘要(并入 conv.anchor) */
  anchorNow: (id: string) => Promise<void>;
  setAutoSummarize: (on: boolean) => void;
  resolveModel: (conv: SimulationConversation) => ModelConfig | undefined;
  /** 推演一轮(回合制一步 / 时间步进 / 自动连续的一轮共用) */
  sendMessage: (content: string) => Promise<void>;
  /** 自动连续推演 N 轮(每轮 sendMessage,可打断) */
  continueRounds: (n: number) => Promise<void>;
  /** 每轮推演完成后的收尾:记忆卡 + 世界状态同步(按 stateUpdate 策略分派) */
  afterTurn: (convId: string) => Promise<void>;
  /** 时间步进:注入时间跨度,推演该时段事件并更新当前时间 */
  timeStep: (duration: string) => Promise<void>;
  /** 世界状态同步(every 每轮 / lazy 手动或每 N 轮 / 手动按钮):独立流产出 JSON */
  updateStateAndTimeline: (convId: string) => Promise<void>;
  /** 记忆卡:历史超阈值自动摘要合并进 conv.summary */
  summarizeIfNeeded: (convId: string) => Promise<void>;
  cancelGeneration: () => void;
  getActive: () => SimulationConversation | undefined;
}

export const useSimulationStore = create<SimulationState>((set, get) => ({
  conversations: [],
  activeId: null,
  isStreaming: false,
  isSyncing: false,
  activeRequestId: null,
  autoSummarize: localStorage.getItem(AUTO_SUMMARIZE_KEY) === "1",
  cancelRounds: false,
  loaded: false,

  load: async () => {
    try {
      const appDir = await getAppDir();
      const names = await listDir(`${appDir}/simulation`);
      const convs: SimulationConversation[] = [];
      for (const f of names) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await readFile(`${appDir}/simulation/${f}`);
          const c = JSON.parse(raw) as SimulationConversation;
          if (c.id) convs.push(c);
        } catch {
          /* 坏文件跳过 */
        }
      }
      convs.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      set({ conversations: convs, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  create: async (opts) => {
    const settingsStore = useSettingsStore.getState();
    const n = get().conversations.length + 1;
    const conv: SimulationConversation = {
      id: uuid(),
      title: `${TYPE_TITLE[opts.type]} #${n}`,
      created_at: nowISO(),
      updated_at: nowISO(),
      messages: [],
      type: opts.type,
      stateMode: opts.stateMode,
      pacing: opts.pacing,
      stateUpdate: opts.stateUpdate,
      autoRounds: opts.autoRounds,
      setup: opts.setup,
      worldState: "",
      stateTable: {},
      timeLabel: "",
      timeline: [],
      model_name: settingsStore.activeModel || undefined,
    };
    await get().saveConv(conv);
    set((s) => ({ conversations: [conv, ...s.conversations], activeId: conv.id }));
    return conv;
  },

  saveConv: async (conv) => {
    const appDir = await getAppDir();
    await writeFile(`${appDir}/simulation/${conv.id}.json`, JSON.stringify(conv, null, 2));
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conv.id ? conv : c)),
    }));
  },

  removeConv: async (id) => {
    const appDir = await getAppDir();
    try {
      await deleteItem(`${appDir}/simulation/${id}.json`);
    } catch {
      /* ignore */
    }
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    }));
  },

  setActive: (id) => set({ activeId: id }),

  patch: async (id, p) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    const updated = { ...conv, ...p, updated_at: nowISO() };
    await get().saveConv(updated);
  },

  addTimelineEntry: async (id, time, event) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || !event.trim()) return;
    const updated = {
      ...conv,
      timeline: [
        ...conv.timeline,
        { time: time.trim() || conv.timeLabel || "当前", event: event.trim() },
      ],
      updated_at: nowISO(),
    };
    await get().saveConv(updated);
  },

  removeTimelineEntry: async (id, idx) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    const updated = {
      ...conv,
      timeline: conv.timeline.filter((_, i) => i !== idx),
      updated_at: nowISO(),
    };
    await get().saveConv(updated);
  },

  setNote: async (id, note) => {
    await get().patch(id, { note });
  },

  setPinned: async (id, pinned) => {
    await get().patch(id, { pinned });
  },

  setObserverMode: async (id, on) => {
    await get().patch(id, { observerMode: on });
  },

  /** 漂移回锚(39,对齐 Dunia:AI GM 漂移是头号问题):独立流产出既定事实锚点 */
  anchorNow: async (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.messages.length === 0) return;
    const model = get().resolveModel(conv);
    if (!model) return;
    const transcript = conv.messages
      .slice(-12)
      .map((m) => `${m.role === "user" ? "玩家" : "推演"}：\n${m.content.slice(0, 500)}`)
      .join("\n\n---\n\n")
      .slice(0, 8000);
    const sys =
      "你是推演一致性锚定器。从最近的推演中提取【已经确立、不应被推翻的事实】(已发生事件、人物关系、世界规则、设定承诺),输出精炼的中文清单(300 字内),只输出清单,不要任何前后缀。";
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
              { role: "user", content: transcript },
            ],
            temperature: 0.3,
            thinking_enabled: false,
          },
          uuid(),
          {
            onToken: (d) => {
              acc += d;
            },
            onDone: () => resolve(),
            onError: () => resolve(),
          }
        );
      });
      const anchor = acc.trim();
      if (anchor) {
        await get().patch(id, { anchor, anchor_msg_count: conv.messages.length });
      }
    } catch {
      /* 回锚失败静默 */
    }
  },

  setAutoSummarize: (on) => {
    localStorage.setItem(AUTO_SUMMARIZE_KEY, on ? "1" : "0");
    set({ autoSummarize: on });
  },

  resolveModel: (conv) => {
    const settingsStore = useSettingsStore.getState();
    return (
      settingsStore.models.find((m) => m.name === conv.model_name) ||
      settingsStore.models.find((m) => m.name === settingsStore.activeModel)
    );
  },

  sendMessage: async (content) => {
    const conv = get().getActive();
    if (!conv || get().isStreaming || !content.trim()) return;
    const settingsStore = useSettingsStore.getState();
    const model = get().resolveModel(conv);
    if (!model) return;

    // 三段式(推演模式):stableSystem(类型指令+设定+节奏+钉住+回锚)恒定前缀 +
    // 状态先于文本(35,TextWorld/MUD 架构):stateBlock 移到历史【前】——
    // AI 先看到当前局面再推演,因果一致;history 中段;note 靠近生成处;user 最后
    const parts = buildSimSystemParts({
      conv,
      recentMessages: conv.messages,
    });
    const apiMessages: Pick<Message, "role" | "content">[] = [
      { role: "system", content: parts.stableSystem },
      // 状态先于文本:当前时间+世界状态在历史之前(TextWorld:先改状态再生成文本)
      ...(parts.stateBlock ? [{ role: "system" as const, content: parts.stateBlock }] : []),
      ...conv.messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    if (parts.summary)
      apiMessages.push({ role: "system", content: `【对话摘要】\n${parts.summary}` });
    // 向量记忆注入(27/41):用当前输入召回高相关记忆,注入尾部(变尾,缓存友好;
    // 与摘要互补——摘要管主线,向量管细节)
    try {
      const hits = await memSearch(content, 2);
      const memText = hits
        .filter((h) => h.score > 0.12)
        .map((h) => h.content)
        .join("\n");
      if (memText) {
        apiMessages.push({ role: "system", content: `【相关记忆】\n${memText}` });
      }
    } catch {
      /* 记忆检索失败静默 */
    }
    apiMessages.push({ role: "user", content });
    // 双记忆槽(26):Author's Note 插靠近生成处(短程控制当前推演指令)
    if (conv.note?.trim()) {
      apiMessages.push({ role: "system", content: `【作者注】\n${conv.note.trim()}` });
    }

    // 采样器(会话预设优先,回退模型参数/全局默认)
    const sampler = settingsStore.samplerPresets.find((p) => p.id === conv.samplerPresetId);
    const pick = (
      k:
        | "temperature"
        | "top_p"
        | "top_k"
        | "repetition_penalty"
        | "frequency_penalty"
        | "presence_penalty"
        | "min_p"
        | "mirostat"
        | "mirostat_tau"
        | "mirostat_eta"
        | "dry_multiplier"
        | "dry_base"
        | "dry_allowed_length"
        | "dry_penalty_last_n"
    ): number | null => {
      if (sampler && sampler[k] != null) return sampler[k] as number;
      if (model.parameters && model.parameters[k] != null) return model.parameters[k] as number;
      const d = settingsStore.defaultParameters[k];
      return d != null ? d : null;
    };

    const userMsg: Message = { id: uuid(), role: "user", content, timestamp: nowISO() };
    const asmMsg: Message = {
      id: uuid(),
      role: "assistant",
      content: "",
      timestamp: nowISO(),
      model: model.model || model.name,
    };
    const requestId = uuid();
    const updated = {
      ...conv,
      messages: [...conv.messages, userMsg, asmMsg],
      updated_at: nowISO(),
    };
    set({
      conversations: get().conversations.map((c) => (c.id === conv.id ? updated : c)),
      isStreaming: true,
      activeRequestId: requestId,
    });
    await get().saveConv(updated);

    let finished = false;
    const finish = async (errText?: string) => {
      if (finished) return;
      finished = true;
      const cur = get().conversations.find((c) => c.id === conv.id);
      if (cur) {
        const msgs = cur.messages.map((m) =>
          m.id === asmMsg.id ? { ...m, error: errText || m.error } : m
        );
        await get().saveConv({ ...cur, messages: msgs, updated_at: nowISO() });
      }
      set({ isStreaming: false, activeRequestId: null });
    };

    try {
      // Token 预算(自动模式):发送前按优先级收缩(历史超限整段替换为摘要,保缓存前缀)
      const finalMessages = shrinkMessages(
        apiMessages,
        budgetFor(model, settingsStore.budgetConfig),
        { mode: settingsStore.budgetConfig.mode, summary: conv.summary }
      ).messages;
      await streamChat(
        {
          model_config: {
            name: model.name,
            provider: model.provider || "",
            api_url: model.api_url,
            api_key: model.api_key,
            model: model.model,
          },
          messages: finalMessages,
          temperature: pick("temperature") ?? 0.7,
          max_tokens:
            model.parameters?.max_tokens ?? settingsStore.defaultParameters.max_tokens ?? null,
          top_p: pick("top_p"),
          top_k: pick("top_k"),
          repetition_penalty: pick("repetition_penalty"),
          frequency_penalty: pick("frequency_penalty"),
          presence_penalty: pick("presence_penalty"),
          min_p: pick("min_p"),
          mirostat: pick("mirostat"),
          mirostat_tau: pick("mirostat_tau"),
          mirostat_eta: pick("mirostat_eta"),
          dry_multiplier: pick("dry_multiplier"),
          dry_base: pick("dry_base"),
          dry_allowed_length: pick("dry_allowed_length"),
          dry_penalty_last_n: pick("dry_penalty_last_n"),
          thinking_enabled: settingsStore.thinkingEnabled,
          reasoning_effort: settingsStore.reasoningEffort,
        },
        requestId,
        {
          onToken: (delta) => {
            const convs = get().conversations.map((c) => {
              if (c.id !== conv.id) return c;
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === asmMsg.id ? { ...m, content: m.content + delta } : m
                ),
              };
            });
            set({ conversations: convs });
          },
          onReasoning: (d) => {
            const convs = get().conversations.map((c) => {
              if (c.id !== conv.id) return c;
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === asmMsg.id ? { ...m, reasoning: (m.reasoning || "") + d } : m
                ),
              };
            });
            set({ conversations: convs });
          },
          onDone: () => {
            void finish().then(() => {
              void get().afterTurn(conv.id);
            });
          },
          onError: (e) => {
            console.error("Simulation chat error:", e);
            void finish(typeof e === "string" ? e : String(e ?? ""));
          },
        }
      );
    } catch (e) {
      void finish(String(e ?? ""));
    }
  },

  /** 每轮推演完成后的收尾:记忆卡 + 世界状态同步(按 stateUpdate 策略分派)+ 漂移回锚 */
  afterTurn: async (convId: string) => {
    // 记忆卡(复用记账式阈值)
    if (get().autoSummarize) void get().summarizeIfNeeded(convId);
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv) return;
    // 漂移回锚(39):距上次回锚 ≥ 10 条消息自动产出锚点(防 AI GM 漂移)
    const anchorLast = conv.anchor_msg_count ?? 0;
    if (conv.messages.length - anchorLast >= 10 && !get().isSyncing) {
      void get().anchorNow(convId);
    }
    switch (conv.stateUpdate) {
      case "every":
        await get().updateStateAndTimeline(convId);
        break;
      case "lazy": {
        // 惰性:距上次同步 N 次推演后自动刷一次(手动同步归零由按钮完成)
        const count = (conv.stateSyncCount ?? 0) + 1;
        if (count >= LAZY_SYNC_INTERVAL) {
          await get().updateStateAndTimeline(convId);
        } else {
          await get().patch(convId, { stateSyncCount: count });
        }
        break;
      }
      case "inline": {
        // 内嵌:从推演输出解析(无额外流);解析失败保持旧状态
        const cur = get().conversations.find((c) => c.id === convId);
        const lastAsm = [...(cur?.messages || [])].reverse().find((m) => m.role === "assistant");
        if (cur && lastAsm?.content) {
          const next: Partial<SimulationConversation> = {};
          const time = parseTimeLabel(lastAsm.content, cur.timeLabel || "");
          if (time) next.timeLabel = time;
          const stateText = parseStateText(lastAsm.content);
          if (stateText && cur.stateMode === "text") next.worldState = stateText;
          const table = parseStateTable(lastAsm.content);
          if (table && cur.stateMode === "table") next.stateTable = table;
          const tl = parseTimelineLines(lastAsm.content, time || cur.timeLabel || "当前");
          if (tl.length > 0) next.timeline = [...cur.timeline, ...tl];
          if (Object.keys(next).length > 0) await get().patch(convId, next);
        }
        break;
      }
    }
  },

  continueRounds: async (n) => {
    if (get().isStreaming) return;
    set({ cancelRounds: false });
    const rounds = Math.max(1, Math.floor(n) || 1);
    for (let i = 0; i < rounds; i++) {
      if (get().cancelRounds || !get().getActive()) break;
      await get().sendMessage(
        "继续推演:基于当前局面自然发展,推进剧情/世界演化。若非战术行动无需掷骰。"
      );
      // 等待一帧,让 UI 的取消按钮可见
      await new Promise((r) => setTimeout(r, 50));
    }
  },

  timeStep: async (duration) => {
    if (!duration.trim()) return;
    await get().sendMessage(
      `【时间推进】经过 ${duration.trim()},请推演此间发生的事件,并更新当前时间。`
    );
  },

  updateStateAndTimeline: async (convId) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv || get().isSyncing) return;
    const model = get().resolveModel(conv);
    if (!model) return;

    // 独立流(不污染会话):只输出 JSON,前端解析更新世界状态 + 时间线
    const transcript = conv.messages
      .slice(-10)
      .map((m) => `${m.role === "user" ? "玩家" : "推演"}：\n${m.content.slice(0, 800)}`)
      .join("\n\n---\n\n")
      .slice(0, 9000);
    const sys =
      "你是推演世界状态同步器。根据最近的推演内容,提取当前世界状态与关键事件。" +
      "只输出一个 JSON 对象,不要任何其他文字或 markdown 包裹。格式:" +
      '{"world_state":"2-4句当前局面概括","table":{"键":"值"},"time":"当前时间标签","event":"本次关键事件一句话"}。' +
      "world_state 用中文;table 只在存在明确数值/状态(兵力、资源、士气等)时给出,否则为 {};time 与上一时间不同则更新,相同可省略;event 概括本次最重要进展。";

    set({ isSyncing: true });
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
              { role: "user", content: transcript },
            ],
            temperature: 0.3,
            thinking_enabled: false,
          },
          uuid(),
          {
            onToken: (d) => {
              acc += d;
            },
            onDone: () => resolve(),
            onError: () => resolve(),
          }
        );
      });
      const parsed = extractJsonObject(acc);
      const cur = get().conversations.find((c) => c.id === convId);
      if (parsed && cur) {
        const next: Partial<SimulationConversation> = { stateSyncCount: 0 };
        if (typeof parsed.world_state === "string" && parsed.world_state.trim()) {
          next.worldState = parsed.world_state.trim();
        }
        if (parsed.table && typeof parsed.table === "object") {
          const tbl: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed.table)) {
            const s = typeof v === "string" ? v.trim() : JSON.stringify(v);
            if (s) tbl[k] = s;
          }
          if (Object.keys(tbl).length > 0) next.stateTable = tbl;
        }
        if (typeof parsed.time === "string" && parsed.time.trim()) {
          next.timeLabel = parsed.time.trim();
        }
        if (typeof parsed.event === "string" && parsed.event.trim()) {
          next.timeline = [
            ...cur.timeline,
            {
              time:
                (typeof parsed.time === "string" && parsed.time.trim()) || cur.timeLabel || "当前",
              event: parsed.event.trim(),
            },
          ];
        }
        if (Object.keys(next).length > 0) await get().patch(convId, next);
      }
    } catch {
      /* 同步失败静默,不影响主流程 */
    } finally {
      set({ isSyncing: false });
    }
  },

  summarizeIfNeeded: async (convId) => {
    if (!get().autoSummarize) return;
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv || conv.messages.length === 0) return;
    const model = get().resolveModel(conv);
    if (!model) return;
    const lastCount = conv.summary_msg_count ?? 0;
    if (conv.messages.length - lastCount < SUMMARIZE_THRESHOLD) return;

    const transcript = conv.messages
      .map((m) => `${m.role === "user" ? "玩家" : "推演"}：\n${m.content.slice(0, 800)}`)
      .join("\n\n---\n\n")
      .slice(0, 9000);
    const sys = conv.summary
      ? "你是对话记忆管理员。下面是已有的对话摘要和新增对话。请把新增内容合并进摘要，保留关键事实、局势、人物关系、未决问题，输出一份精炼的中文摘要（500 字内），只输出摘要正文，不要任何前后缀。"
      : "你是对话记忆管理员。请把以下推演对话提炼成精炼的中文摘要（保留关键事实、世界局势、人物关系、未决事件），500 字内，只输出摘要正文。";

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
                content: conv.summary
                  ? `【已有摘要】\n${conv.summary}\n\n【新增对话】\n${transcript}`
                  : transcript,
              },
            ],
            temperature: 0.3,
            thinking_enabled: false,
          },
          uuid(),
          {
            onToken: (d) => {
              acc += d;
            },
            onDone: () => resolve(),
            onError: () => resolve(),
          }
        );
      });
      const summary = acc.trim();
      if (summary) {
        await get().patch(convId, { summary, summary_msg_count: conv.messages.length });
      }
    } catch {
      /* 摘要失败静默 */
    }
  },

  cancelGeneration: () => {
    const { isStreaming, activeRequestId } = get();
    if (isStreaming && activeRequestId) {
      cancelChat(activeRequestId); // Rust 侧中止流
    }
    set({ isStreaming: false, activeRequestId: null, cancelRounds: true });
  },

  getActive: () => get().conversations.find((c) => c.id === get().activeId),
}));

/** 容错 JSON 提取:剥掉 ```json 包裹/前后缀文字,取首个 { 到末个 } */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
