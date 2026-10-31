import { create } from "zustand";
import type { TavernConversation, Message, ModelConfig, CharacterCard } from "@/types";
import { getAppDir, readFile, writeFile, listDir, deleteItem } from "@/lib/tauri";
import { streamChat, cancelChat, logDiag } from "@/lib/tauri";
import { useCharacterStore } from "./useCharacterStore";
import { useSettingsStore } from "./useSettingsStore";
import { useCacheStatsStore } from "./useCacheStatsStore";
import {
  buildRpSystemParts,
  buildGroupSystemParts,
  injectAuthorNote,
  type TimedLoreState,
} from "@/lib/rp-prompt";
import { translateText } from "@/lib/translate";
import { budgetFor, shrinkMessages } from "@/lib/context-budget";
import { maybeWarnBudget } from "@/lib/budget-warning";
import { prepareOutgoingMessages } from "@/lib/outgoing-regex";
import { toModelConfig } from "@/lib/model-config";
import { runSummarize, SUMMARIZE_THRESHOLD } from "@/lib/summarize";
import { askConfirm } from "@/components/ui/ConfirmDialog";
import { showToast } from "@/components/ui/Toast";
import { pluginAPI } from "@/plugin/PluginHost";

// ── 已外移的模块（原本都堆在这个文件里，见各文件头部的拆分说明）──
import { uuid, nowISO } from "./tavern/utils";
import {
  TARGET_KEY,
  AUTO_KEY,
  SUMMARIZE_KEY,
  AUTOSWIPE_KEY,
  AUTOSWIPE_MIN_LEN,
} from "./tavern/constants";
import { resolveConversationVars, mergeTimedLore, buildAttachmentBlock } from "./tavern/prompt";
import { parseGroupOwner } from "./tavern/group-owner";
import { assembleApiMessages, collectLorebooks, makeSamplerPicker } from "./tavern/assembly";
import { createStreamBatcher, applyStreamDeltas } from "@/lib/stream-batcher";
import { lastAssistantIndex } from "@/lib/message-selectors";

/** 流式 token 合帧(rAF):key = assistant 消息 id。
 *  每 token 只进待写缓冲,动画帧内一次 set —— 与工作模式同一套语义(审计 SRC-03)。 */
const tavernStreamBatcher = createStreamBatcher<string>((batch) => {
  useTavernStore.setState((s) => {
    const res = applyStreamDeltas<TavernConversation, Message>(s.conversations, batch);
    // 没有命中的消息时返回原 state,避免空通知
    return res.changed ? { conversations: res.conversations } : s;
  });
});

/**
 * 当前在途生成的收尾入口(T-026)。
 *
 * cancelGeneration 是全局同步动作,拿不到各生成链路里闭包内的 finish();
 * 旧实现取消时只清 isStreaming,cancelChat 又立刻删 handler → Rust 取消后
 * 补发的 done 到不了 onDone,finish 永不执行,磁盘留下 content:""。
 *
 * 每次生成开始时把同一份 finish 登记在这里:取消时直接调用它,先 flush 合帧、
 * 把已生成正文/思考写回消息再 saveConv。finish 自己的 finished 守卫保证取消
 * 宽限窗口内迟到的 done 不会二次落盘。
 */
interface ActiveGeneration {
  convId: string;
  msgId: string;
  finish: (errText?: string) => Promise<void>;
}
let activeGeneration: ActiveGeneration | null = null;

/**
 * 同一会话「读最新 → 合并字段 → 落盘」的串行化队列。
 *
 * 后台任务(自动摘要 / 自动翻译)在 await 期间,会话可能已被发送消息、另一个
 * 后台任务更新或被删除。旧实现用 await 前的快照整对象回写,会把这些更新一起
 * 抹掉(T-002)。现在任务完成后都按 id 重取最新会话、只合并自己负责的字段;
 * 同一会话的写回再串成队列——否则两个任务可能各自读到同一份旧 state 再先后
 * 覆盖,摘要与翻译同开时仍会互相吞掉。
 */
const convPatchQueues = new Map<string, Promise<void>>();

function enqueueConvPatch(convId: string, run: () => Promise<void>): Promise<void> {
  const prev = convPatchQueues.get(convId) ?? Promise.resolve();
  const next = prev.then(run).catch((e: unknown) => {
    logDiag(`Tavern background patch error (${convId}): ${String(e)}`);
  });
  convPatchQueues.set(convId, next);
  void next.then(() => {
    if (convPatchQueues.get(convId) === next) convPatchQueues.delete(convId);
  });
  return next;
}

/**
 * 群聊重试/继续的上下文组装(T-024)。
 *
 * 群聊里点重试/继续此前固定取 conv.character_id 的单卡 + buildRpSystemParts,
 * 结果 prompt 里没有其他在场角色,上下文与发言角色都是错的。这里与
 * sendGroupMessage 的群聊分支对齐:所有在场角色由 buildGroupSystemParts 汇总,
 * 发言者手动模式取 activeCharId、自动模式取说话队列队首。单聊不走这里,
 * 仍保留各自的单角色链路。
 */
function buildGroupReplayParts(args: {
  conv: TavernConversation;
  cards: CharacterCard[];
  history: Message[];
  currentInput: string;
}): {
  stableSystem: string;
  lorebook: string;
  summary: string;
  replyCharName: string;
  timedLore: TimedLoreState;
} {
  const charStore = useCharacterStore.getState();
  const persona =
    charStore.personas.find((p) => p.id === args.conv.persona_id) ||
    charStore.getActivePersona() ||
    null;
  // 与 sendGroupMessage 的群聊分支一致:角色级世界书合并;各卡内嵌书由
  // buildGroupSystemParts 自己收集,这里不重复塞单卡内嵌书
  const books = collectLorebooks({
    globalLorebook: charStore.globalLorebook,
    card: {
      character_book: undefined,
      lorebookIds: args.cards.flatMap((c) => c.lorebookIds || []),
    },
    enabledIds: charStore.enabledLorebookIds,
    personaIds: persona?.lorebookIds || [],
    convIds: args.conv.lorebookIds || [],
    byId: charStore.lorebooks,
  });
  const auto = args.conv.autoRespond === true;
  const queueIdx = args.conv.queueIndex ?? 0;
  const queueChar = args.cards[queueIdx % args.cards.length];
  const activeCard = args.cards.find((c) => c.id === args.conv.activeCharId) || args.cards[0];
  const speaker = auto ? queueChar : activeCard;
  const parts = buildGroupSystemParts({
    cards: args.cards,
    persona,
    personaName: persona?.name,
    lorebooks: books,
    recentMessages: args.history,
    currentInput: args.currentInput,
    summary: args.conv.summary,
    timed: args.conv.timedLore,
    queueCharName: speaker?.name,
  });
  return {
    stableSystem: parts.stableSystem,
    lorebook: parts.lorebook,
    summary: parts.summary,
    replyCharName: speaker?.name || "",
    timedLore: mergeTimedLore(args.conv.timedLore, parts.timedResult),
  };
}

interface TavernState {
  conversations: TavernConversation[];
  activeId: string | null;
  isStreaming: boolean;
  /** 当前流式请求 id(取消用) */
  activeRequestId: string | null;
  /** 内置翻译:目标语言(默认中文) */
  translateTargetLang: string;
  /** 自动翻译:每条 AI 回复完成后自动出译文 */
  autoTranslate: boolean;
  /** 自动摘要(酒馆 Summarize):历史超阈值自动总结,省 token 保记忆 */
  autoSummarize: boolean;
  /** 自动滑卡(酒馆 Auto-Swipe):回复太短自动换一版 */
  autoSwipe: boolean;
  /** 正在翻译中的消息 id(按钮 loading 态) */
  translatingIds: string[];
  loaded: boolean;

  load: () => Promise<void>;
  createWithCharacter: (
    characterId: string,
    opts?: { personaId?: string }
  ) => Promise<TavernConversation>;
  /** 群聊:多选角色建群聊会话(≥2);开场白 = 各角色 first_mes 依次写入 */
  createGroupChat: (
    charIds: string[],
    opts?: { personaId?: string }
  ) => Promise<TavernConversation>;
  /** 群聊:切换当前选中发言角色(手动模式) */
  setGroupActiveChar: (convId: string, charId: string) => Promise<void>;
  /** 群聊:自动回应开关 */
  setAutoRespond: (convId: string, on: boolean) => Promise<void>;
  saveConv: (conv: TavernConversation) => Promise<void>;
  removeConv: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
  setPersona: (convId: string, personaId: string | null) => Promise<void>;
  /** 会话绑定模型(共用工作模式模型配置;空 = 全局 activeModel) */
  setModel: (convId: string, modelName: string) => Promise<void>;
  /** 会话绑定采样器预设(酒馆 API 响应配置;空 = 模型参数 ?? 全局默认) */
  setSamplerPreset: (convId: string, presetId: string | null) => Promise<void>;
  /** 会话绑定世界书(聊天级,可多选) */
  setLorebooks: (convId: string, lorebookIds: string[]) => Promise<void>;
  /** 双记忆槽(26):Author's Note 第二槽(靠近生成处的当前指令) */
  setNote: (convId: string, note: string) => Promise<void>;
  /** 钉住区(40):关键承诺/伏笔/人物关系钉入常驻上下文 */
  setPinned: (convId: string, pinned: string) => Promise<void>;
  /** Chat Break 软重置(29):清短程历史,保留摘要/世界书状态/Persona/时间线 */
  softReset: (convId: string) => Promise<void>;
  setTranslateTargetLang: (lang: string) => void;
  setAutoTranslate: (on: boolean) => void;
  setAutoSummarize: (on: boolean) => void;
  setAutoSwipe: (on: boolean) => void;
  /** 自动摘要:历史超阈值 → 用当前模型总结合并进 conv.summary */
  summarizeIfNeeded: (convId: string) => Promise<void>;
  /** 翻译指定消息(译文存进消息 translation 并落盘) */
  translateMessage: (convId: string, msgId: string) => Promise<void>;
  /** 解析会话实际使用的模型(会话绑定优先,回退全局) */
  resolveModel: (conv: TavernConversation) => ModelConfig | undefined;
  /** 流式发送 RP 消息(独立于工作模式 sendMessage,直连 streamChat) */
  sendMessage: (content: string) => Promise<void>;
  /** 群聊发送(内部:手动 = activeCharId 角色回复;自动 = AI 自选角色) */
  sendGroupMessage: (content: string) => Promise<void>;
  /** Swipe 滑卡:◀/▶ 切换回复版本;到边界(向右)则重放生成新版本 */
  swipe: (msgId: string, direction: -1 | 1) => Promise<void>;
  /** 重放生成新版本(仅最后一条 assistant 支持,酒馆语义) */
  swipeGenerate: (msgId: string) => Promise<void>;
  /** 继续生成(酒馆 Continue):以上一条回复结尾为前缀,续写生成新内容 */
  continueMessage: (msgId: string) => Promise<void>;
  /** 编辑消息正文:variants 是版本展示真源,同步写回 variants[variantIndex] */
  editMessage: (msgId: string, content: string) => Promise<void>;
  /** 冒充回复(酒馆 Impersonate):以当前角色身份手动写入一条 assistant 消息,不走 AI */
  impersonate: (content: string) => Promise<void>;
  /** 会话消息变量(酒馆 {{var::x}} 宏):设置单个变量并落盘 */
  setVariable: (convId: string, name: string, value: string) => Promise<void>;
  /** 移除会话消息变量 */
  removeVariable: (convId: string, name: string) => Promise<void>;
  /** 数据银行/聊天附件:添加附件(名字+内容)并落盘 */
  addAttachment: (convId: string, name: string, content: string) => Promise<void>;
  /** 数据银行/聊天附件:删除附件 */
  removeAttachment: (convId: string, attachmentId: string) => Promise<void>;
  cancelGeneration: () => void;
  getActive: () => TavernConversation | undefined;
}

/**
 * load() 幂等守卫(SRC-01)。
 *
 * TavernView 用 `useEffect(() => { void tavern.load(); }, [tavern])` 触发加载,
 * 而 zustand 每次 set() 都产生新的 state 对象 → 依赖变化 → effect 重跑 →
 * load() 又 set() → 挂载即无限读盘(审计实测 500ms 内 34 次)。
 *
 * 这里做两层:
 * - `loaded`:成功或失败过一次就不再尝试(界面只有挂载时这一个调用点,
 *   失败也置位是为了在磁盘不可用时避免按帧重试);
 * - `loadInFlight`:并发调用(React StrictMode 双挂载)共享同一次读盘,
 *   否则两个调用都会在 `loaded=false` 时通过守卫。
 * 依赖侧的修法见 TavernView.tsx / SimulationView.tsx(改用稳定动作 `s.load`)。
 */
let loadInFlight: Promise<void> | null = null;

export const useTavernStore = create<TavernState>((set, get) => ({
  conversations: [],
  activeId: null,
  isStreaming: false,
  activeRequestId: null,
  translateTargetLang: localStorage.getItem(TARGET_KEY) || "中文",
  autoTranslate: localStorage.getItem(AUTO_KEY) === "1",
  autoSummarize: localStorage.getItem(SUMMARIZE_KEY) === "1",
  autoSwipe: localStorage.getItem(AUTOSWIPE_KEY) === "1",
  translatingIds: [],
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    if (loadInFlight) return loadInFlight;

    loadInFlight = (async () => {
      try {
        const appDir = await getAppDir();
        const names = await listDir(`${appDir}/tavern`);
        const convs: TavernConversation[] = [];
        for (const f of names) {
          if (!f.endsWith(".json")) continue;
          try {
            const raw = await readFile(`${appDir}/tavern/${f}`);
            const c = JSON.parse(raw) as TavernConversation;
            if (c.id && c.character_id) convs.push(c);
          } catch {
            /* 坏文件跳过 */
          }
        }
        convs.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
        set({ conversations: convs, loaded: true });
      } catch {
        set({ loaded: true });
      }
    })();

    try {
      await loadInFlight;
    } finally {
      loadInFlight = null;
    }
  },

  createWithCharacter: async (characterId, opts) => {
    const charStore = useCharacterStore.getState();
    const card = charStore.characters.find((c) => c.id === characterId);
    if (!card) throw new Error("角色不存在");
    const personaId = (opts?.personaId ?? charStore.activePersonaId) || undefined;
    // 新会话默认用全局 activeModel(可在会话内随时切换)
    const settingsStore = useSettingsStore.getState();
    const n = get().conversations.filter((c) => c.character_id === characterId).length + 1;
    const conv: TavernConversation = {
      id: uuid(),
      character_id: characterId,
      character_name: card.name,
      persona_id: personaId,
      model_name: settingsStore.activeModel || undefined,
      title: `${card.name} #${n}`,
      created_at: nowISO(),
      updated_at: nowISO(),
      messages: [],
    };
    // 开场白多版(酒馆 Swipe):first_mes + alternate_greetings 全部存 variants,
    // 第一版 = first_mes,swipe 可切换不同开场白({{user}}/{{char}} 宏替换)
    if (card.first_mes?.trim()) {
      const persona = charStore.personas.find((p) => p.id === personaId);
      const userName = persona?.name || "User";
      const render = (tpl: string) =>
        tpl.split("{{user}}").join(userName).split("{{char}}").join(card.name);
      const variants = [
        render(card.first_mes),
        ...(card.alternate_greetings || []).map(render).filter(Boolean),
      ];
      const first = variants[0] ?? "";
      conv.messages.push({
        id: uuid(),
        role: "assistant",
        content: first,
        timestamp: nowISO(),
        model: card.name,
        variants,
      });
    }
    await get().saveConv(conv);
    set((s) => ({ conversations: [conv, ...s.conversations], activeId: conv.id }));
    return conv;
  },

  createGroupChat: async (charIds, opts) => {
    const charStore = useCharacterStore.getState();
    const cards = charIds
      .map((id) => charStore.characters.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c);
    if (cards.length < 2) throw new Error("群聊至少需要 2 个角色");
    const firstCard = cards[0];
    if (!firstCard) throw new Error("群聊至少需要 2 个角色");
    const personaId = (opts?.personaId ?? charStore.activePersonaId) || undefined;
    const settingsStore = useSettingsStore.getState();
    const names = cards.map((c) => c.name).join("、");
    const conv: TavernConversation = {
      id: uuid(),
      character_id: firstCard.id,
      character_name: names,
      groupCharIds: cards.map((c) => c.id),
      activeCharId: firstCard.id,
      autoRespond: false,
      persona_id: personaId,
      model_name: settingsStore.activeModel || undefined,
      title: `👥 ${names}`,
      created_at: nowISO(),
      updated_at: nowISO(),
      messages: [],
    };
    // 开场白:每个角色的 first_mes 依次写入(assistant 消息 model=角色名)
    const persona = charStore.personas.find((p) => p.id === personaId);
    const userName = persona?.name || "User";
    for (const card of cards) {
      if (!card.first_mes?.trim()) continue;
      const content = card.first_mes
        .split("{{user}}")
        .join(userName)
        .split("{{char}}")
        .join(card.name);
      conv.messages.push({
        id: uuid(),
        role: "assistant",
        content,
        timestamp: nowISO(),
        model: card.name,
      });
    }
    await get().saveConv(conv);
    set((s) => ({ conversations: [conv, ...s.conversations], activeId: conv.id }));
    return conv;
  },

  setGroupActiveChar: async (convId, charId) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const updated = { ...conv, activeCharId: charId, updated_at: nowISO() };
    await get().saveConv(updated);
  },

  setAutoRespond: async (convId, on) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const updated = { ...conv, autoRespond: on, updated_at: nowISO() };
    await get().saveConv(updated);
  },

  saveConv: async (conv) => {
    const appDir = await getAppDir();
    await writeFile(`${appDir}/tavern/${conv.id}.json`, JSON.stringify(conv, null, 2));
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conv.id ? conv : c)),
    }));
  },

  removeConv: async (id) => {
    const appDir = await getAppDir();
    try {
      await deleteItem(`${appDir}/tavern/${id}.json`);
    } catch {
      /* ignore */
    }
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    }));
  },

  setActive: (id) => set({ activeId: id }),

  setPersona: async (convId, personaId) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const updated = { ...conv, persona_id: personaId || undefined, updated_at: nowISO() };
    await get().saveConv(updated);
  },

  setModel: async (convId, modelName) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const updated = { ...conv, model_name: modelName || undefined, updated_at: nowISO() };
    await get().saveConv(updated);
  },

  setSamplerPreset: async (convId, presetId) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const updated = { ...conv, samplerPresetId: presetId || undefined, updated_at: nowISO() };
    await get().saveConv(updated);
  },

  setLorebooks: async (convId, lorebookIds) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const updated = { ...conv, lorebookIds, updated_at: nowISO() };
    await get().saveConv(updated);
  },

  setNote: async (convId, note) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const updated = { ...conv, note, updated_at: nowISO() };
    await get().saveConv(updated);
  },

  setPinned: async (convId, pinned) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const updated = { ...conv, pinned, updated_at: nowISO() };
    await get().saveConv(updated);
  },

  /** Chat Break 软重置(29,对齐 Kindroid):清短程历史,保留摘要/世界书/Persona/时间线 */
  softReset: async (convId) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv) return;
    if (!(await askConfirm("软重置:清空对话历史,但保留摘要/世界书/人设/时间线,开始新章节?")))
      return;
    const updated = {
      ...conv,
      messages: [],
      updated_at: nowISO(),
      // 保留 summary/summary_msg_count/note/pinned/lorebookIds/persona/模型配置
    };
    await get().saveConv(updated);
  },

  setTranslateTargetLang: (lang) => {
    localStorage.setItem(TARGET_KEY, lang);
    set({ translateTargetLang: lang });
  },

  setAutoTranslate: (on) => {
    localStorage.setItem(AUTO_KEY, on ? "1" : "0");
    set({ autoTranslate: on });
  },

  setAutoSummarize: (on) => {
    localStorage.setItem(SUMMARIZE_KEY, on ? "1" : "0");
    set({ autoSummarize: on });
  },

  setAutoSwipe: (on) => {
    localStorage.setItem(AUTOSWIPE_KEY, on ? "1" : "0");
    set({ autoSwipe: on });
  },

  summarizeIfNeeded: async (convId) => {
    if (!get().autoSummarize) return;
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv || conv.messages.length === 0) return;
    // 记账式阈值:距上次摘要新增消息数 ≥ N 才总结(修复旧实现每轮重复总结的缺陷)
    const lastCount = conv.summary_msg_count ?? 0;
    if (conv.messages.length - lastCount < SUMMARIZE_THRESHOLD) return;
    const model = get().resolveModel(conv);
    if (!model) return;

    // 已有摘要 + 全部消息 → 合并式总结;无摘要 → 首轮总结
    const transcript = conv.messages
      .map((m) => `${m.role === "user" ? "用户" : "角色"}：\n${m.content.slice(0, 800)}`)
      .join("\n\n---\n\n")
      .slice(0, 9000);
    const sys = conv.summary
      ? "你是对话记忆管理员。下面是已有的对话摘要和新增对话。请把新增内容合并进摘要，保留关键事实、关系、未决问题，输出一份精炼的中文摘要（500 字内），只输出摘要正文，不要任何前后缀。"
      : "你是对话记忆管理员。请把以下对话提炼成精炼的中文摘要（保留关键事实、人物关系、设定、未决问题），500 字内，只输出摘要正文。";

    const result = await runSummarize({
      model,
      systemPrompt: sys,
      userContent: conv.summary
        ? `【已有摘要】\n${conv.summary}\n\n【新增对话】\n${transcript}`
        : transcript,
      label: "tavern-summarize",
    });
    const summary = result.summary;
    // 只有完整结束才落盘：中断时的半截摘要会覆盖掉上一份好摘要
    if (result.complete && summary) {
      // 记账:本次摘要覆盖到的消息数 = 任务开始时的条数。await 期间新到的消息
      // 还没进这份摘要,必须留给下一轮(用完成时的长度会把它们标成「已摘要」)。
      const coveredCount = conv.messages.length;
      await enqueueConvPatch(convId, async () => {
        // await 后按 id 重取最新会话:期间可能追加消息、被另一个后台任务更新
        // 或整个被删除 —— 旧快照整对象回写会把这些更新一并抹掉。
        const latest = get().conversations.find((c) => c.id === convId);
        // 会话已删除:放弃写回,否则 saveConv 会把刚删掉的文件重新创建出来
        if (!latest) return;
        // 只合并本次任务负责的字段(messages/标题等仍用最新状态)
        await get().saveConv({
          ...latest,
          summary,
          summary_msg_count: coveredCount,
          updated_at: nowISO(),
        });
      });
    }
  },

  resolveModel: (conv) => {
    const settingsStore = useSettingsStore.getState();
    // 会话绑定的模型优先(酒馆模式独立选择,不被工作模式绑死),空则回退全局 activeModel
    return (
      settingsStore.models.find((m) => m.name === conv.model_name) ||
      settingsStore.models.find((m) => m.name === settingsStore.activeModel)
    );
  },

  translateMessage: async (convId, msgId) => {
    const conv = get().conversations.find((c) => c.id === convId);
    const msg = conv?.messages.find((m) => m.id === msgId);
    if (!conv || !msg || !msg.content.trim()) return;
    if (get().translatingIds.includes(msgId)) return;

    set((s) => ({ translatingIds: [...s.translatingIds, msgId] }));
    try {
      // 非 AI 引擎:专业翻译服务(Google 免key 默认/DeepL/Libre),不消耗对话模型
      const target = get().translateTargetLang;
      const translated = await translateText(msg.content, target);
      if (!translated) return;
      await enqueueConvPatch(convId, async () => {
        // await 后按 id 重取最新会话:期间的新消息、摘要结果不能被旧快照抹掉
        const latest = get().conversations.find((c) => c.id === convId);
        if (!latest) return; // 会话已删除:放弃写回,不重建文件
        if (!latest.messages.some((m) => m.id === msgId)) return; // 消息已不存在
        // 只合并这条消息的 translation;其余消息(含 await 期间新增的)保持最新
        await get().saveConv({
          ...latest,
          updated_at: nowISO(),
          messages: latest.messages.map((m) =>
            m.id === msgId ? { ...m, translation: translated } : m
          ),
        });
      });
    } catch (e) {
      logDiag(`Tavern translate error: ${String(e)}`);
    } finally {
      set((s) => ({ translatingIds: s.translatingIds.filter((id) => id !== msgId) }));
    }
  },

  sendMessage: async (content) => {
    const conv = get().getActive();
    if (!conv || get().isStreaming || !content.trim()) return;
    // 群聊分叉:群聊走 sendGroupMessage(手动/自动两种模式)
    if (conv.groupCharIds && conv.groupCharIds.length >= 2) {
      return get().sendGroupMessage(content);
    }
    const charStore = useCharacterStore.getState();
    const card = charStore.characters.find((c) => c.id === conv.character_id);
    if (!card) return;
    const settingsStore = useSettingsStore.getState();
    const model = get().resolveModel(conv);
    if (!model) {
      // 无模型时静默退出 → 明确提示(此前用户发消息没反应,且不知原因)
      showToast("error", "未配置模型:请在设置 → 模型 中添加模型,或在会话顶栏选择。");
      return;
    }

    const persona =
      charStore.personas.find((p) => p.id === conv.persona_id) ||
      charStore.getActivePersona() ||
      null;

    // RP system_prompt:角色卡 + Persona + 预设 + 世界书(复用 rp-prompt 组装)
    // 世界书合并(酒馆四类来源):主(恒) + 全局启用的独立书 + 角色内嵌 + Persona 多选 + 会话绑定
    const books = collectLorebooks({
      globalLorebook: charStore.globalLorebook,
      card,
      enabledIds: charStore.enabledLorebookIds,
      personaIds: persona?.lorebookIds || [],
      convIds: conv.lorebookIds || [],
      byId: charStore.lorebooks,
    });
    // 三段式(DeepSeek 缓存核心):stableSystem 前缀恒定,世界书/摘要尾部可变
    const parts = buildRpSystemParts({
      card,
      persona,
      preset: charStore.presets,
      lorebooks: books,
      recentMessages: conv.messages,
      currentInput: content,
      summary: conv.summary,
      timed: conv.timedLore,
    });
    // 定时世界书:更新会话 sticky/cooldown 状态(不落盘,下次 saveConv 带出)
    const timedLore = mergeTimedLore(conv.timedLore, parts.timedResult);

    // 采样器回退链细节见 ./tavern/assembly.ts（会话预设 → 模型参数 → 全局默认 → 不发送）
    const sampler = settingsStore.samplerPresets.find((p) => p.id === conv.samplerPresetId);
    const pick = makeSamplerPicker(sampler, model.parameters, settingsStore.defaultParameters);

    // API messages 三段式:system(stable) 前缀 + 历史 + 世界书/摘要尾部 + user 最后
    // （顺序细节抽到 ./tavern/assembly.ts，那边有钉住顺序的回归测试守着）
    const apiMessages = assembleApiMessages({
      stableSystem: parts.stableSystem,
      // 钉住区(40):关键承诺/伏笔/人物关系钉入稳定前缀区(缓存友好,永远在场)
      pinned: conv.pinned,
      history: conv.messages,
      lorebook: parts.lorebook,
      summary: parts.summary,
      // 数据银行/聊天附件(酒馆 Data Bank):注入可变尾部,缓存友好
      attachmentBlock: buildAttachmentBlock(conv),
      userContent: content,
    });
    // 双记忆槽(26)+ 作者注四维(酒馆 note:depth/position/role)——按配置注入;
    // position="in_chat" 在历史第 N 条后插入,role 决定消息角色
    if (conv.note?.trim()) {
      const withNote = injectAuthorNote(apiMessages, {
        text: conv.note,
        depth: conv.note_depth,
        position: conv.note_position,
        role: conv.note_role,
      });
      apiMessages.length = 0;
      apiMessages.push(...withNote);
    }
    // V3 扩展:深度提示词(对话到第 depth 条消息时注入;注入点固定文本恒定 → 缓存友好)
    if (parts.depthPrompt && conv.messages.length >= parts.depthPrompt.depth) {
      const at = Math.min(1 + parts.depthPrompt.depth, apiMessages.length);
      apiMessages.splice(at, 0, {
        role: "system",
        content: `【深度提示词】\n${parts.depthPrompt.prompt}`,
      });
    }

    // 新建 user + assistant 占位
    const userMsg: Message = { id: uuid(), role: "user", content, timestamp: nowISO() };
    const asmMsg: Message = {
      id: uuid(),
      role: "assistant",
      content: "",
      timestamp: nowISO(),
      model: card.name,
    };
    const requestId = uuid();
    const updated = {
      ...conv,
      timedLore,
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
      if (activeGeneration?.msgId === asmMsg.id) activeGeneration = null;
      // 收尾前先落出挂起帧:finish 读的是 store 里的最终内容/acc,且不能让
      // 未刷新的增量在收尾之后才 apply(会重复拼接)
      tavernStreamBatcher.flush();
      const cur = get().conversations.find((c) => c.id === conv.id);
      if (cur) {
        const msgs = cur.messages.map((m) => {
          if (m.id !== asmMsg.id) return m;
          // Swipe:首次生成的最终内容存进 variants[0](可左右切换/生成新版本)
          // 响应后处理钩子(插件 afterResponse):落盘前应用
          const content = pluginAPI.executeAfterResponse(m.content || "");
          return {
            ...m,
            // variants 与 content 同步(T-025):插件后处理改写的正文也要落进 content,
            // 否则界面(variants)与发送上下文(content)再次分叉
            content,
            error: errText || m.error,
            variants: m.variants || [content],
            variantIndex: m.variantIndex ?? 0,
          };
        });
        const final = { ...cur, messages: msgs, updated_at: nowISO() };
        await get().saveConv(final);
      }
      set({ isStreaming: false, activeRequestId: null });
    };
    // T-026:取消路径与正常完成共用同一份收尾(落盘已生成正文/思考)
    activeGeneration = { convId: conv.id, msgId: asmMsg.id, finish };

    try {
      // 发送前准备(三条链路共用):预算收缩(自动模式,历史超限整段替换为摘要)
      // → 出站正则清理（placement=2 的「只改提示词」脚本，剥掉 internal_states /
      // GFX 块 / IMG_PROMPT / 思考块）。
      // ⚠️ 只作用于这份待发副本，绝不回写 conv.messages（界面显示不受影响）。
      const shrunk = prepareOutgoingMessages(resolveConversationVars(apiMessages, conv), {
        budget: budgetFor(model, settingsStore.budgetConfig),
        mode: settingsStore.budgetConfig.mode,
        summary: conv.summary,
        regexRules: settingsStore.regexRules,
      });
      // 接近/超出预算时主动提醒(只弹 Toast,不影响发送)
      maybeWarnBudget(conv.id, shrunk.total, shrunk.budget);
      const finalMessages = shrunk.messages;
      await streamChat(
        {
          model_config: toModelConfig(model),
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
          // 停止字符串(酒馆 Stopping Strings):全局配置,非空才发送
          stopping_strings:
            settingsStore.stoppingStrings.length > 0 ? settingsStore.stoppingStrings : null,
        },
        requestId,
        {
          onToken: (delta) => {
            // 只进待写缓冲,rAF 帧内一次 set(审计 SRC-03)
            tavernStreamBatcher.add(asmMsg.id, { content: delta });
          },
          onReasoning: (d) => {
            tavernStreamBatcher.add(asmMsg.id, { reasoning: d });
          },
          onDone: (cache) => {
            // DeepSeek 缓存诊断:记录命中率(验证三段式优化)
            if (cache && cache.hit + cache.miss > 0) {
              useCacheStatsStore.getState().recordCache(model.name, cache.hit, cache.miss);
            }
            void finish().then(() => {
              // 自动翻译:开启时对刚完成的 AI 回复自动出译文
              if (get().autoTranslate) {
                void get().translateMessage(conv.id, asmMsg.id);
              }
              // 自动摘要(酒馆 Summarize):历史超阈值自动总结
              if (get().autoSummarize) {
                void get().summarizeIfNeeded(conv.id);
              }
              // 自动滑卡(酒馆 Auto-Swipe):回复太短 → 自动重放生成新版本
              if (get().autoSwipe) {
                const cur = get().conversations.find((c) => c.id === conv.id);
                const m = cur?.messages.find((x) => x.id === asmMsg.id);
                if (m && m.content && !m.error && m.content.trim().length < AUTOSWIPE_MIN_LEN) {
                  void get().swipeGenerate(asmMsg.id);
                }
              }
            });
          },
          onError: (e) => {
            logDiag(`Tavern chat error: ${String(e)}`);
            void finish(typeof e === "string" ? e : String(e ?? ""));
          },
        }
      );
    } catch (e) {
      void finish(String(e ?? ""));
    }
  },

  swipe: async (msgId, direction) => {
    const conv = get().getActive();
    if (!conv || get().isStreaming) return;
    const idx = conv.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    const m = conv.messages[idx];
    if (!m || m.role !== "assistant") return;
    const variants = m.variants || [m.content || ""];
    const cur = m.variantIndex ?? 0;
    const next = cur + direction;
    if (next < 0) return; // 左到头停
    if (next >= variants.length) {
      // 右到头 → 生成新版本(仅最后一条 assistant 支持重放)
      if (idx !== lastAssistantIndex(conv.messages)) return;
      await get().swipeGenerate(msgId);
      return;
    }
    // variants 是版本展示真源,content 必须同步为当前版本(T-025):
    // 否则界面显示 B,发送/摘要/翻译读到的还是切换前的 A
    const messages = conv.messages.map((x) =>
      x.id === msgId ? { ...x, variantIndex: next, content: variants[next] ?? x.content } : x
    );
    await get().saveConv({ ...conv, messages, updated_at: nowISO() });
  },

  swipeGenerate: async (msgId) => {
    const conv = get().getActive();
    if (!conv || get().isStreaming) return;
    const charStore = useCharacterStore.getState();
    // 群聊分支(T-024):与 sendGroupMessage 同一套群聊 prompt,不再固定取单卡
    const isGroup = (conv.groupCharIds?.length || 0) >= 2;
    const groupCards = isGroup
      ? (conv.groupCharIds || [])
          .map((id) => charStore.characters.find((c) => c.id === id))
          .filter((c): c is CharacterCard => !!c)
      : [];
    if (isGroup && groupCards.length < 2) return;
    const card = isGroup ? undefined : charStore.characters.find((c) => c.id === conv.character_id);
    const settingsStore = useSettingsStore.getState();
    const model = get().resolveModel(conv);
    if (!model) {
      showToast("error", "未配置模型:请在设置 → 模型 中添加模型,或在会话顶栏选择。");
      return;
    }
    const idx = conv.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    const asmMsg = conv.messages[idx];
    if (!asmMsg || asmMsg.role !== "assistant") return;

    // 重放上下文:该条之前的消息 + 之前的最后一条 user 输入
    const before = conv.messages.slice(0, idx);
    const lastUser = [...before].reverse().find((m) => m.role === "user");
    if (!lastUser) return;

    // 三段式(与 sendMessage 同链):stableSystem 前缀 + 历史 + 世界书/摘要尾部 + 原 user 输入
    // 群聊走 buildGroupReplayParts(全部在场角色 + activeChar/队首);
    // 单聊保持原来的单角色链路。
    const auto = isGroup && conv.autoRespond === true;
    let stableSystem: string;
    let lorebook: string;
    let summaryPart: string;
    let timedLore: TimedLoreState;
    let depthPrompt: { depth: number; prompt: string } | undefined;
    let replyCharName = "";
    if (isGroup) {
      const groupParts = buildGroupReplayParts({
        conv,
        cards: groupCards,
        history: before,
        currentInput: lastUser.content,
      });
      stableSystem = groupParts.stableSystem;
      lorebook = groupParts.lorebook;
      summaryPart = groupParts.summary;
      timedLore = groupParts.timedLore;
      replyCharName = groupParts.replyCharName;
    } else {
      if (!card) return;
      const persona =
        charStore.personas.find((p) => p.id === conv.persona_id) ||
        charStore.getActivePersona() ||
        null;
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
        lorebooks: books,
        recentMessages: before,
        currentInput: lastUser.content,
        summary: conv.summary,
        timed: conv.timedLore,
      });
      stableSystem = parts.stableSystem;
      lorebook = parts.lorebook;
      summaryPart = parts.summary;
      timedLore = mergeTimedLore(conv.timedLore, parts.timedResult);
      depthPrompt = parts.depthPrompt;
    }
    const apiMessages = assembleApiMessages({
      stableSystem,
      pinned: conv.pinned, // 钉住区(40):常驻上下文,重放同样生效
      history: before,
      // 自动/手动群聊沿用 sendGroupMessage 的设定块标题
      lorebook: isGroup && lorebook ? `【世界观设定】\n${lorebook}` : lorebook,
      summary: summaryPart,
      // 数据银行/聊天附件(酒馆 Data Bank):重放同样注入
      attachmentBlock: buildAttachmentBlock(conv),
      userContent: lastUser.content,
    });
    // 双记忆槽(26)+ 作者注四维(酒馆 note:depth/position/role)
    if (conv.note?.trim()) {
      const withNote = injectAuthorNote(apiMessages, {
        text: conv.note,
        depth: conv.note_depth,
        position: conv.note_position,
        role: conv.note_role,
      });
      apiMessages.length = 0;
      apiMessages.push(...withNote);
    }
    // V3 扩展:深度提示词(重放上下文同样生效;注入点固定文本恒定 → 缓存友好)
    if (depthPrompt && before.length >= depthPrompt.depth) {
      const at = Math.min(1 + depthPrompt.depth, apiMessages.length);
      apiMessages.splice(at, 0, {
        role: "system",
        content: `【深度提示词】\n${depthPrompt.prompt}`,
      });
    }

    const sampler = settingsStore.samplerPresets.find((p) => p.id === conv.samplerPresetId);
    const pick = makeSamplerPicker(sampler, model.parameters, settingsStore.defaultParameters);

    // 占位:新版本流式写入该消息,完成后 push 进 variants 指向新版
    const requestId = uuid();
    // T-026：绝不「先清空 content 再落盘」。生成中只在内存里把 content 清空
    // 用于展示流式增量；旧正文仍保存在 variants / asmMsg 快照中，正常完成、
    // 取消或出错时再由 finish 一次性落盘。旧实现这一笔 saveConv({content:""})
    // 在取消时会让磁盘永久留下空正文，而 variants 还是旧文。
    set({
      conversations: get().conversations.map((c) =>
        c.id === conv.id
          ? {
              ...conv,
              timedLore,
              messages: conv.messages.map((m) => (m.id === msgId ? { ...m, content: "" } : m)),
              updated_at: nowISO(),
            }
          : c
      ),
      isStreaming: true,
      activeRequestId: requestId,
    });

    let acc = "";
    let finished = false;
    const finish = async (errText?: string) => {
      if (finished) return;
      finished = true;
      if (activeGeneration?.msgId === msgId) activeGeneration = null;
      // 收尾前先落出挂起帧:finish 读的是 store 里的最终内容/acc,且不能让
      // 未刷新的增量在收尾之后才 apply(会重复拼接)
      tavernStreamBatcher.flush();
      const cur = get().conversations.find((c) => c.id === conv.id);
      if (cur) {
        const messages = cur.messages.map((m) => {
          if (m.id !== msgId) return m;
          // 响应后处理钩子(插件 afterResponse):新版本落盘前应用
          const processed = pluginAPI.executeAfterResponse(acc);
          // 群聊:自动模式按首行【角色名】归属,手动模式固定为当前 activeChar;
          // 单聊保持原来的 model 不变(T-024)
          let content = processed;
          let modelName = m.model;
          if (isGroup) {
            const parsed = auto
              ? parseGroupOwner(
                  processed,
                  groupCards.map((c) => c.name)
                )
              : null;
            content = parsed?.content ?? processed;
            modelName = parsed?.owner || replyCharName || m.model;
          }
          // 取消得太早/空生成:恢复旧版本,绝不把 content 落成空串 ——
          // MessageBubble 的操作栏依赖非空内容,留空后无法复制/编辑/滑卡。
          const previous = m.variants?.[m.variantIndex ?? 0] ?? asmMsg.content ?? "";
          if (!content) {
            return {
              ...m,
              content: previous,
              error: errText || m.error,
              ...(isGroup ? { model: modelName } : {}),
            };
          }
          // variants 与 content 同步(T-025)
          const variants = [...(m.variants || [asmMsg.content || ""]), content];
          return {
            ...m,
            content,
            variants,
            variantIndex: variants.length - 1,
            error: errText || m.error,
            ...(isGroup ? { model: modelName } : {}),
          };
        });
        await get().saveConv({ ...cur, messages, updated_at: nowISO() });
      }
      set({ isStreaming: false, activeRequestId: null });
    };
    // T-026:取消路径与正常完成共用同一份收尾(落盘半截正文)
    activeGeneration = { convId: conv.id, msgId, finish };

    try {
      // 发送前准备(三条链路共用):预算收缩(自动模式,历史超限整段替换为摘要)
      // → 出站正则清理（placement=2 的「只改提示词」脚本，剥掉 internal_states /
      // GFX 块 / IMG_PROMPT / 思考块）。
      // ⚠️ 只作用于这份待发副本，绝不回写 conv.messages（界面显示不受影响）。
      const shrunk = prepareOutgoingMessages(resolveConversationVars(apiMessages, conv), {
        budget: budgetFor(model, settingsStore.budgetConfig),
        mode: settingsStore.budgetConfig.mode,
        summary: conv.summary,
        regexRules: settingsStore.regexRules,
      });
      // 接近/超出预算时主动提醒(只弹 Toast,不影响发送)
      maybeWarnBudget(conv.id, shrunk.total, shrunk.budget);
      const finalMessages = shrunk.messages;
      await streamChat(
        {
          model_config: toModelConfig(model),
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
          stopping_strings:
            settingsStore.stoppingStrings.length > 0 ? settingsStore.stoppingStrings : null,
        },
        requestId,
        {
          onToken: (d) => {
            acc += d; // finish() 用完整 acc 落盘(variants/插件后处理)
            tavernStreamBatcher.add(msgId, { content: d });
          },
          onReasoning: () => {
            /* swipe 版本不保留 reasoning 差异 */
          },
          onDone: (cache) => {
            if (cache && cache.hit + cache.miss > 0) {
              useCacheStatsStore.getState().recordCache(model.name, cache.hit, cache.miss);
            }
            void finish();
          },
          onError: (e) => {
            void finish(typeof e === "string" ? e : String(e ?? ""));
          },
        }
      );
    } catch (e) {
      void finish(String(e ?? ""));
    }
  },

  impersonate: async (content) => {
    const conv = get().getActive();
    if (!conv || !content.trim()) return;
    const name = conv.character_name;
    const asmMsg: Message = {
      id: uuid(),
      role: "assistant",
      content,
      timestamp: nowISO(),
      model: name,
    };
    const updated = {
      ...conv,
      messages: [...conv.messages, asmMsg],
      updated_at: nowISO(),
    };
    await get().saveConv(updated);
  },

  setVariable: async (convId, name, value) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv || !name.trim()) return;
    const variables = { ...(conv.variables || {}), [name.trim()]: value };
    await get().saveConv({ ...conv, variables, updated_at: nowISO() });
  },

  removeVariable: async (convId, name) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const variables = { ...(conv.variables || {}) };
    delete variables[name];
    await get().saveConv({ ...conv, variables, updated_at: nowISO() });
  },

  addAttachment: async (convId, name, content) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv || !name.trim()) return;
    const attachments = [
      ...(conv.attachments || []),
      { id: uuid(), name: name.trim(), content, created_at: nowISO() },
    ];
    await get().saveConv({ ...conv, attachments, updated_at: nowISO() });
  },

  removeAttachment: async (convId, attachmentId) => {
    const conv = get().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const attachments = (conv.attachments || []).filter((a) => a.id !== attachmentId);
    await get().saveConv({ ...conv, attachments, updated_at: nowISO() });
  },

  cancelGeneration: () => {
    const { isStreaming, activeRequestId } = get();
    if (!isStreaming) return;
    if (activeRequestId) {
      // 先发取消请求。cancelChat 会保留 handler 一个短窗口,让 Rust 取消路径
      // 补发的 done 仍能到达 onDone(T-026);这里不依赖那次 done。
      cancelChat(activeRequestId);
    }
    // 合帧补偿:先把已生成但未刷新的 token 应用到 store,收尾才能读到
    tavernStreamBatcher.flush();
    const gen = activeGeneration;
    if (gen) {
      // 与正常完成共用同一份 finish:flush → 已生成正文/思考写回消息 → saveConv。
      // 磁盘上不再是空 content;内容为空时 finish 会恢复旧版本(variants)。
      void gen.finish().catch((e: unknown) => {
        logDiag(`Tavern cancel persist error (${gen.convId}): ${String(e)}`);
      });
    } else {
      set({ isStreaming: false, activeRequestId: null });
    }
  },

  continueMessage: async (msgId) => {
    // 继续生成(酒馆 Continue):以上一条 assistant 消息的当前内容作为前缀,
    // 重新调模型续写,完成后把新内容 push 进 variants(可回看原版)。
    const conv = get().getActive();
    if (!conv || get().isStreaming) return;
    const charStore = useCharacterStore.getState();
    // 群聊分支(T-024):与 sendGroupMessage 同一套群聊 prompt,不再固定取单卡
    const isGroup = (conv.groupCharIds?.length || 0) >= 2;
    const groupCards = isGroup
      ? (conv.groupCharIds || [])
          .map((id) => charStore.characters.find((c) => c.id === id))
          .filter((c): c is CharacterCard => !!c)
      : [];
    if (isGroup && groupCards.length < 2) return;
    const card = isGroup ? undefined : charStore.characters.find((c) => c.id === conv.character_id);
    const settingsStore = useSettingsStore.getState();
    const model = get().resolveModel(conv);
    if (!model) {
      showToast("error", "未配置模型:请在设置 → 模型 中添加模型,或在会话顶栏选择。");
      return;
    }
    const idx = conv.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    const asmMsg = conv.messages[idx];
    if (!asmMsg || asmMsg.role !== "assistant") return;
    // 继续 = 把该条当前版本作为前缀,续写其后(variants 为真源,旧数据 content 兜底)
    const prefix = asmMsg.variants?.[asmMsg.variantIndex ?? 0] ?? asmMsg.content ?? "";

    const auto = isGroup && conv.autoRespond === true;
    let stableSystem: string;
    let lorebook: string;
    let summaryPart: string;
    let timedLore: TimedLoreState;
    let replyCharName = "";
    if (isGroup) {
      const groupParts = buildGroupReplayParts({
        conv,
        cards: groupCards,
        history: conv.messages.slice(0, idx + 1),
        currentInput: "",
      });
      stableSystem = groupParts.stableSystem;
      lorebook = groupParts.lorebook;
      summaryPart = groupParts.summary;
      timedLore = groupParts.timedLore;
      replyCharName = groupParts.replyCharName;
    } else {
      if (!card) return;
      const persona =
        charStore.personas.find((p) => p.id === conv.persona_id) ||
        charStore.getActivePersona() ||
        null;
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
        lorebooks: books,
        recentMessages: conv.messages.slice(0, idx),
        currentInput: "",
        summary: conv.summary,
        timed: conv.timedLore,
      });
      stableSystem = parts.stableSystem;
      lorebook = parts.lorebook;
      summaryPart = parts.summary;
      timedLore = mergeTimedLore(conv.timedLore, parts.timedResult);
    }
    const apiMessages = assembleApiMessages({
      stableSystem,
      pinned: conv.pinned,
      history: conv.messages.slice(0, idx + 1),
      lorebook: isGroup && lorebook ? `【世界观设定】\n${lorebook}` : lorebook,
      summary: summaryPart,
      // 数据银行/聊天附件(酒馆 Data Bank):续写同样注入
      attachmentBlock: buildAttachmentBlock(conv),
      // 明确要求续写:以原回复结尾为起点继续
      userContent: "(请从最后一句继续刚才的回复,保持语气与视角,直接续写不要解释)",
    });
    // 双记忆槽(26)+ 作者注四维(酒馆 note:depth/position/role)
    if (conv.note?.trim()) {
      const withNote = injectAuthorNote(apiMessages, {
        text: conv.note,
        depth: conv.note_depth,
        position: conv.note_position,
        role: conv.note_role,
      });
      apiMessages.length = 0;
      apiMessages.push(...withNote);
    }

    const sampler = settingsStore.samplerPresets.find((p) => p.id === conv.samplerPresetId);
    const pick = makeSamplerPicker(sampler, model.parameters, settingsStore.defaultParameters);

    const requestId = uuid();
    const updated = {
      ...conv,
      timedLore,
      messages: conv.messages.map((m) => (m.id === msgId ? { ...m, content: prefix } : m)),
      updated_at: nowISO(),
    };
    set({
      conversations: get().conversations.map((c) => (c.id === conv.id ? updated : c)),
      isStreaming: true,
      activeRequestId: requestId,
    });
    await get().saveConv(updated);

    let acc = "";
    let finished = false;
    const finish = async (errText?: string) => {
      if (finished) return;
      finished = true;
      if (activeGeneration?.msgId === msgId) activeGeneration = null;
      // 收尾前先落出挂起帧:finish 读的是 store 里的最终内容/acc,且不能让
      // 未刷新的增量在收尾之后才 apply(会重复拼接)
      tavernStreamBatcher.flush();
      const cur = get().conversations.find((c) => c.id === conv.id);
      if (cur) {
        const messages = cur.messages.map((m) => {
          if (m.id !== msgId) return m;
          const full = prefix + acc;
          // 群聊:自动模式仍按首行【角色名】归属,手动模式固定当前 activeChar(T-024)
          let content = full;
          let modelName = m.model;
          if (isGroup) {
            const parsed = auto
              ? parseGroupOwner(
                  full,
                  groupCards.map((c) => c.name)
                )
              : null;
            content = parsed?.content ?? full;
            modelName = parsed?.owner || replyCharName || m.model;
          }
          // 取消得太早(还没有任何续写 token):保留原回复,不追加重复版本
          const previous = m.variants?.[m.variantIndex ?? 0] ?? asmMsg.content ?? "";
          if (content === previous) {
            return {
              ...m,
              error: errText || m.error,
              ...(isGroup ? { model: modelName } : {}),
            };
          }
          // variants 与 content 同步(T-025)
          const variants = [...(m.variants || [asmMsg.content || ""]), content];
          return {
            ...m,
            content,
            variants,
            variantIndex: variants.length - 1,
            error: errText || m.error,
            ...(isGroup ? { model: modelName } : {}),
          };
        });
        await get().saveConv({ ...cur, messages, updated_at: nowISO() });
      }
      set({ isStreaming: false, activeRequestId: null });
    };
    // T-026:取消路径与正常完成共用同一份收尾(落盘半截续写)
    activeGeneration = { convId: conv.id, msgId, finish };

    try {
      // ⚠️ 续写保持历史行为：只做预算收缩，不跑出站正则（改动会改变对外行为）。
      // 其余三条酒馆发送链路已统一走 prepareOutgoingMessages。
      const budgetResult = shrinkMessages(
        resolveConversationVars(apiMessages, conv),
        budgetFor(model, settingsStore.budgetConfig),
        { mode: settingsStore.budgetConfig.mode, summary: conv.summary }
      );
      // 接近/超出预算时主动提醒(只弹 Toast,不影响发送)
      maybeWarnBudget(conv.id, budgetResult.total, budgetResult.budget);
      const finalMessages = budgetResult.messages;
      await streamChat(
        {
          model_config: toModelConfig(model),
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
          stopping_strings:
            settingsStore.stoppingStrings.length > 0 ? settingsStore.stoppingStrings : null,
        },
        requestId,
        {
          onToken: (d) => {
            acc += d; // finish() 用 prefix + acc 落盘
            // 续写开始时消息内容已置为 prefix → 增量追加即可
            tavernStreamBatcher.add(msgId, { content: d });
          },
          onReasoning: () => {
            /* 继续不保留 reasoning 差异 */
          },
          onDone: () => {
            void finish();
          },
          onError: (e) => {
            void finish(typeof e === "string" ? e : String(e ?? ""));
          },
        }
      );
    } catch (e) {
      void finish(String(e ?? ""));
    }
  },

  editMessage: async (msgId, content) => {
    // 编辑正文:variants 是版本展示真源(T-025)。旧实现只写 content,
    // 而 MessageBubble 渲染 variants[variantIndex] → 编辑后界面毫无变化。
    // 这里把新内容同时写回当前版本,其余历史版本保持不变。
    const conv = get().getActive();
    if (!conv) return;
    const messages = conv.messages.map((m) => {
      if (m.id !== msgId) return m;
      if (!m.variants || m.variants.length === 0) return { ...m, content };
      const idx = Math.min(Math.max(m.variantIndex ?? 0, 0), m.variants.length - 1);
      const variants = m.variants.map((v, i) => (i === idx ? content : v));
      return { ...m, content, variants, variantIndex: idx };
    });
    await get().saveConv({ ...conv, messages, updated_at: nowISO() });
  },

  sendGroupMessage: async (content) => {
    const conv = get().getActive();
    if (!conv || get().isStreaming || !content.trim()) return;
    const charStore = useCharacterStore.getState();
    const cards = (conv.groupCharIds || [])
      .map((id) => charStore.characters.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c);
    if (cards.length < 2) return;
    const settingsStore = useSettingsStore.getState();
    const model = get().resolveModel(conv);
    if (!model) {
      showToast("error", "未配置模型:请在设置 → 模型 中添加模型,或在会话顶栏选择。");
      return;
    }
    if (cards.length < 2) return;

    const persona =
      charStore.personas.find((p) => p.id === conv.persona_id) ||
      charStore.getActivePersona() ||
      null;
    // 群聊:各角色卡绑定的独立世界书一并合并(角色级);不注入单个角色的内嵌书
    const books = collectLorebooks({
      globalLorebook: charStore.globalLorebook,
      card: {
        character_book: undefined,
        lorebookIds: cards.flatMap((c) => c.lorebookIds || []),
      },
      enabledIds: charStore.enabledLorebookIds,
      personaIds: persona?.lorebookIds || [],
      convIds: conv.lorebookIds || [],
      byId: charStore.lorebooks,
    });

    // 手动模式:activeCharId 角色回复;自动模式:AI 自选角色
    const auto = conv.autoRespond === true;
    let stableSystem: string;
    let lorebook: string;
    let summaryPart: string;
    let replyCharName: string;
    // V3 扩展:深度提示词(仅手动单角色模式,自动模式多角色不注入)
    let depthPrompt: { depth: number; prompt: string } | undefined;
    let timedLore: TimedLoreState | undefined = conv.timedLore;
    let queueNextIdx = conv.queueIndex ?? 0;
    if (auto) {
      // 群聊说话队列:自动模式下按 groupCharIds 顺序轮转,指定这轮发言者
      const queueIdx = conv.queueIndex ?? 0;
      const queueChar = cards[queueIdx % cards.length];
      const parts = buildGroupSystemParts({
        cards,
        persona,
        personaName: persona?.name,
        lorebooks: books,
        recentMessages: conv.messages,
        currentInput: content,
        summary: conv.summary,
        timed: conv.timedLore,
        queueCharName: queueChar?.name,
      });
      stableSystem = parts.stableSystem;
      lorebook = parts.lorebook;
      summaryPart = parts.summary;
      replyCharName = ""; // 完成后解析首行【角色名】
      timedLore = mergeTimedLore(conv.timedLore, parts.timedResult);
      // 预推进队列(发言后轮到下一位;归属解析失败也按此推进)
      queueNextIdx = (queueIdx + 1) % Math.max(1, cards.length);
    } else {
      const activeCard = cards.find((c) => c.id === conv.activeCharId) || cards[0];
      if (!activeCard) return;
      const parts = buildRpSystemParts({
        card: activeCard,
        persona,
        preset: charStore.presets,
        lorebooks: collectLorebooks({
          globalLorebook: charStore.globalLorebook,
          card: {
            character_book: activeCard.character_book,
            lorebookIds: cards.flatMap((c) => c.lorebookIds || []),
          },
          enabledIds: charStore.enabledLorebookIds,
          personaIds: persona?.lorebookIds || [],
          convIds: conv.lorebookIds || [],
          byId: charStore.lorebooks,
        }),
        recentMessages: conv.messages,
        currentInput: content,
        summary: conv.summary,
        timed: conv.timedLore,
      });
      stableSystem = parts.stableSystem;
      lorebook = parts.lorebook;
      summaryPart = parts.summary;
      replyCharName = activeCard.name;
      // V3 扩展:手动群聊(单角色回复)同样支持深度提示词
      depthPrompt = parts.depthPrompt;
      timedLore = mergeTimedLore(conv.timedLore, parts.timedResult);
    }

    const sampler = settingsStore.samplerPresets.find((p) => p.id === conv.samplerPresetId);
    const pick = makeSamplerPicker(sampler, model.parameters, settingsStore.defaultParameters);

    // 三段式(DeepSeek 缓存核心):stableSystem 前缀 + 历史 + 世界书/摘要尾部 + user 最后
    const apiMessages = assembleApiMessages({
      stableSystem,
      pinned: conv.pinned, // 钉住区(40):常驻上下文,群聊同样生效
      history: conv.messages,
      // 自动模式的设定块自带标题,手动模式沿用原文
      lorebook: auto && lorebook ? `【世界观设定】\n${lorebook}` : lorebook,
      summary: summaryPart,
      // 数据银行/聊天附件(酒馆 Data Bank):群聊同样注入
      attachmentBlock: buildAttachmentBlock(conv),
      userContent: content,
    });
    // 双记忆槽(26)+ 作者注四维(酒馆 note:depth/position/role)
    if (conv.note?.trim()) {
      const withNote = injectAuthorNote(apiMessages, {
        text: conv.note,
        depth: conv.note_depth,
        position: conv.note_position,
        role: conv.note_role,
      });
      apiMessages.length = 0;
      apiMessages.push(...withNote);
    }
    // V3 扩展:深度提示词(手动群聊单角色模式;注入点固定文本恒定 → 缓存友好)
    if (depthPrompt && conv.messages.length >= depthPrompt.depth) {
      const at = Math.min(1 + depthPrompt.depth, apiMessages.length);
      apiMessages.splice(at, 0, {
        role: "system",
        content: `【深度提示词】\n${depthPrompt.prompt}`,
      });
    }

    const userMsg: Message = { id: uuid(), role: "user", content, timestamp: nowISO() };
    const asmMsg: Message = {
      id: uuid(),
      role: "assistant",
      content: "",
      timestamp: nowISO(),
      model: replyCharName,
    };
    const requestId = uuid();
    const updated = {
      ...conv,
      timedLore,
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
      if (activeGeneration?.msgId === asmMsg.id) activeGeneration = null;
      // 收尾前先落出挂起帧:finish 读的是 store 里的最终内容/acc,且不能让
      // 未刷新的增量在收尾之后才 apply(会重复拼接)
      tavernStreamBatcher.flush();
      const cur = get().conversations.find((c) => c.id === conv.id);
      if (cur) {
        const msgs = cur.messages.map((m) => {
          if (m.id !== asmMsg.id) return m;
          // 自动模式:鲁棒解析归属角色(多格式+模糊匹配;失败智能回退)。
          // 纯响应后处理,不碰三段式前缀 → 零缓存影响。
          // 响应后处理钩子(插件 afterResponse):落盘前应用
          let final = {
            ...m,
            content: pluginAPI.executeAfterResponse(m.content),
            error: errText || m.error,
          };
          if (auto) {
            const parsed = parseGroupOwner(
              m.content,
              cards.map((c) => c.name)
            );
            if (parsed) {
              final.model = parsed.owner;
              final.content = parsed.content;
            } else {
              // 回退:优先 activeCharId;其次上一条 assistant 的角色(连话);再 cards[0]
              const prevOwner = [...cur.messages]
                .slice(0, cur.messages.indexOf(m))
                .reverse()
                .find(
                  (x) => x.role === "assistant" && x.model && cards.some((c) => c.name === x.model)
                )?.model;
              final.model =
                cards.find((c) => c.id === conv.activeCharId)?.name ||
                prevOwner ||
                cards[0]?.name ||
                "角色";
            }
          }
          return final;
        });
        await get().saveConv({
          ...cur,
          // 群聊说话队列:自动模式完成后推进到下一位
          ...(auto ? { queueIndex: queueNextIdx } : {}),
          messages: msgs,
          updated_at: nowISO(),
        });
      }
      set({ isStreaming: false, activeRequestId: null });
    };
    // T-026:取消路径与正常完成共用同一份收尾(落盘半截群聊回复)
    activeGeneration = { convId: conv.id, msgId: asmMsg.id, finish };

    try {
      // 发送前准备(三条链路共用):预算收缩(自动模式,历史超限整段替换为摘要)
      // → 出站正则清理（placement=2 的「只改提示词」脚本，剥掉 internal_states /
      // GFX 块 / IMG_PROMPT / 思考块）。
      // ⚠️ 只作用于这份待发副本，绝不回写 conv.messages（界面显示不受影响）。
      const shrunk = prepareOutgoingMessages(resolveConversationVars(apiMessages, conv), {
        budget: budgetFor(model, settingsStore.budgetConfig),
        mode: settingsStore.budgetConfig.mode,
        summary: conv.summary,
        regexRules: settingsStore.regexRules,
      });
      // 接近/超出预算时主动提醒(只弹 Toast,不影响发送)
      maybeWarnBudget(conv.id, shrunk.total, shrunk.budget);
      const finalMessages = shrunk.messages;
      await streamChat(
        {
          model_config: toModelConfig(model),
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
          stopping_strings:
            settingsStore.stoppingStrings.length > 0 ? settingsStore.stoppingStrings : null,
        },
        requestId,
        {
          onToken: (delta) => {
            tavernStreamBatcher.add(asmMsg.id, { content: delta });
          },
          onReasoning: (d) => {
            tavernStreamBatcher.add(asmMsg.id, { reasoning: d });
          },
          onDone: (cache) => {
            if (cache && cache.hit + cache.miss > 0) {
              useCacheStatsStore.getState().recordCache(model.name, cache.hit, cache.miss);
            }
            void finish().then(() => {
              if (get().autoTranslate) void get().translateMessage(conv.id, asmMsg.id);
              if (get().autoSummarize) void get().summarizeIfNeeded(conv.id);
            });
          },
          onError: (e) => {
            logDiag(`Tavern group chat error: ${String(e)}`);
            void finish(typeof e === "string" ? e : String(e ?? ""));
          },
        }
      );
    } catch (e) {
      void finish(String(e ?? ""));
    }
  },

  getActive: () => get().conversations.find((c) => c.id === get().activeId),
}));

// parseGroupOwner / matchRole 已移到 ./tavern/group-owner.ts（配套单测 group-owner.test.ts）
