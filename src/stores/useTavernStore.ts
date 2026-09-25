import { create } from "zustand";
import type { TavernConversation, Message, ModelConfig } from "@/types";
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
import { applyOutgoingRegex } from "@/lib/outgoing-regex";
import { askConfirm } from "@/components/ui/ConfirmDialog";
import { showToast } from "@/components/ui/Toast";
import { pluginAPI } from "@/plugin/PluginHost";

// ── 已外移的模块（原本都堆在这个文件里，见各文件头部的拆分说明）──
import { uuid, nowISO } from "./tavern/utils";
import {
  TARGET_KEY,
  AUTO_KEY,
  SUMMARIZE_KEY,
  SUMMARIZE_THRESHOLD,
  AUTOSWIPE_KEY,
  AUTOSWIPE_MIN_LEN,
} from "./tavern/constants";
import { resolveConversationVars, mergeTimedLore, buildAttachmentBlock } from "./tavern/prompt";
import { parseGroupOwner } from "./tavern/group-owner";
import { assembleApiMessages, collectLorebooks, makeSamplerPicker } from "./tavern/assembly";

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

    const requestId = uuid();
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
          requestId,
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
        // 记账:记住总结时的消息数(阈值判定用),与摘要一起落盘
        const updated = {
          ...conv,
          summary,
          summary_msg_count: conv.messages.length,
          updated_at: nowISO(),
        };
        await get().saveConv(updated);
      }
    } catch {
      /* 摘要失败静默,不影响主流程 */
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
      const updated = {
        ...conv,
        updated_at: nowISO(),
        messages: conv.messages.map((m) =>
          m.id === msgId ? { ...m, translation: translated } : m
        ),
      };
      await get().saveConv(updated);
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
      const cur = get().conversations.find((c) => c.id === conv.id);
      if (cur) {
        const msgs = cur.messages.map((m) => {
          if (m.id !== asmMsg.id) return m;
          // Swipe:首次生成的最终内容存进 variants[0](可左右切换/生成新版本)
          // 响应后处理钩子(插件 afterResponse):落盘前应用
          const content = pluginAPI.executeAfterResponse(m.content || "");
          return {
            ...m,
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

    try {
      // Token 预算(自动模式):发送前按优先级收缩(历史超限整段替换为摘要,保缓存前缀)
      const shrunk = shrinkMessages(
        resolveConversationVars(apiMessages, conv),
        budgetFor(model, settingsStore.budgetConfig),
        { mode: settingsStore.budgetConfig.mode, summary: conv.summary }
      ).messages;
      // 出站正则清理（酒馆 placement=2 的「只改提示词」脚本）：在收缩之后、发送之前跑，
      // 剥掉 <internal_states> / GFX 块 / <!-- IMG_PROMPT:… --> / 思考块，让发出去的体积更小。
      // ⚠️ 只作用于这份待发副本，绝不回写 conv.messages（界面显示不受影响）。
      const finalMessages = applyOutgoingRegex(shrunk, settingsStore.regexRules);
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
          // 停止字符串(酒馆 Stopping Strings):全局配置,非空才发送
          stopping_strings:
            settingsStore.stoppingStrings.length > 0 ? settingsStore.stoppingStrings : null,
        },
        requestId,
        {
          onToken: (delta) => {
            // 流式期间直接更新该 assistant 消息(tavern 消息量小,单流可接受;
            // MessageBubble 的 memo 保证历史消息不重渲染)
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
      const isLast =
        idx === conv.messages.length - 1 ||
        conv.messages.slice(idx + 1).every((x) => x.role !== "assistant");
      if (!isLast) return;
      await get().swipeGenerate(msgId);
      return;
    }
    const messages = conv.messages.map((x) => (x.id === msgId ? { ...x, variantIndex: next } : x));
    await get().saveConv({ ...conv, messages, updated_at: nowISO() });
  },

  swipeGenerate: async (msgId) => {
    const conv = get().getActive();
    if (!conv || get().isStreaming) return;
    const charStore = useCharacterStore.getState();
    const card = charStore.characters.find((c) => c.id === conv.character_id);
    if (!card) return;
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
    const timedLore = mergeTimedLore(conv.timedLore, parts.timedResult);
    const apiMessages = assembleApiMessages({
      stableSystem: parts.stableSystem,
      pinned: conv.pinned, // 钉住区(40):常驻上下文,重放同样生效
      history: before,
      lorebook: parts.lorebook,
      summary: parts.summary,
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
    if (parts.depthPrompt && before.length >= parts.depthPrompt.depth) {
      const at = Math.min(1 + parts.depthPrompt.depth, apiMessages.length);
      apiMessages.splice(at, 0, {
        role: "system",
        content: `【深度提示词】\n${parts.depthPrompt.prompt}`,
      });
    }

    const sampler = settingsStore.samplerPresets.find((p) => p.id === conv.samplerPresetId);
    const pick = makeSamplerPicker(sampler, model.parameters, settingsStore.defaultParameters);

    // 占位:新版本流式写入该消息,完成后 push 进 variants 指向新版
    const requestId = uuid();
    const updated = {
      ...conv,
      timedLore,
      messages: conv.messages.map((m) => (m.id === msgId ? { ...m, content: "" } : m)),
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
      const cur = get().conversations.find((c) => c.id === conv.id);
      if (cur) {
        const messages = cur.messages.map((m) => {
          if (m.id !== msgId) return m;
          // 响应后处理钩子(插件 afterResponse):新版本落盘前应用
          const processed = pluginAPI.executeAfterResponse(acc);
          const variants = [...(m.variants || [asmMsg.content || ""]), processed];
          return {
            ...m,
            content: processed,
            variants,
            variantIndex: variants.length - 1,
            error: errText || m.error,
          };
        });
        await get().saveConv({ ...cur, messages, updated_at: nowISO() });
      }
      set({ isStreaming: false, activeRequestId: null });
    };

    try {
      // Token 预算(自动模式):发送前按优先级收缩(历史超限整段替换为摘要,保缓存前缀)
      const shrunk = shrinkMessages(
        resolveConversationVars(apiMessages, conv),
        budgetFor(model, settingsStore.budgetConfig),
        { mode: settingsStore.budgetConfig.mode, summary: conv.summary }
      ).messages;
      // 出站正则清理（酒馆 placement=2 的「只改提示词」脚本）：在收缩之后、发送之前跑，
      // 剥掉 <internal_states> / GFX 块 / <!-- IMG_PROMPT:… --> / 思考块，让发出去的体积更小。
      // ⚠️ 只作用于这份待发副本，绝不回写 conv.messages（界面显示不受影响）。
      const finalMessages = applyOutgoingRegex(shrunk, settingsStore.regexRules);
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
          stopping_strings:
            settingsStore.stoppingStrings.length > 0 ? settingsStore.stoppingStrings : null,
        },
        requestId,
        {
          onToken: (d) => {
            acc += d;
            const convs = get().conversations.map((c) => {
              if (c.id !== conv.id) return c;
              return {
                ...c,
                messages: c.messages.map((m) => (m.id === msgId ? { ...m, content: acc } : m)),
              };
            });
            set({ conversations: convs });
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
      cancelChat(activeRequestId); // Rust 侧中止流
    }
    set({ isStreaming: false, activeRequestId: null });
  },

  continueMessage: async (msgId) => {
    // 继续生成(酒馆 Continue):以上一条 assistant 消息的当前内容作为前缀,
    // 重新调模型续写,完成后把新内容 push 进 variants(可回看原版)。
    const conv = get().getActive();
    if (!conv || get().isStreaming) return;
    const charStore = useCharacterStore.getState();
    const card = charStore.characters.find((c) => c.id === conv.character_id);
    if (!card) return;
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
    // 继续 = 把该条当前内容作为前缀,续写其后
    const prefix = asmMsg.content || "";

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
    const timedLore = mergeTimedLore(conv.timedLore, parts.timedResult);
    const apiMessages = assembleApiMessages({
      stableSystem: parts.stableSystem,
      pinned: conv.pinned,
      history: conv.messages.slice(0, idx + 1),
      lorebook: parts.lorebook,
      summary: parts.summary,
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
      const cur = get().conversations.find((c) => c.id === conv.id);
      if (cur) {
        const messages = cur.messages.map((m) => {
          if (m.id !== msgId) return m;
          const full = prefix + acc;
          const variants = [...(m.variants || [asmMsg.content || ""]), full];
          return {
            ...m,
            content: full,
            variants,
            variantIndex: variants.length - 1,
            error: errText || m.error,
          };
        });
        await get().saveConv({ ...cur, messages, updated_at: nowISO() });
      }
      set({ isStreaming: false, activeRequestId: null });
    };

    try {
      const finalMessages = shrinkMessages(
        resolveConversationVars(apiMessages, conv),
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
          stopping_strings:
            settingsStore.stoppingStrings.length > 0 ? settingsStore.stoppingStrings : null,
        },
        requestId,
        {
          onToken: (d) => {
            acc += d;
            const convs = get().conversations.map((c) => {
              if (c.id !== conv.id) return c;
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === msgId ? { ...m, content: prefix + acc } : m
                ),
              };
            });
            set({ conversations: convs });
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

    try {
      // Token 预算(自动模式):发送前按优先级收缩(历史超限整段替换为摘要,保缓存前缀)
      const shrunk = shrinkMessages(
        resolveConversationVars(apiMessages, conv),
        budgetFor(model, settingsStore.budgetConfig),
        { mode: settingsStore.budgetConfig.mode, summary: conv.summary }
      ).messages;
      // 出站正则清理（酒馆 placement=2 的「只改提示词」脚本）：在收缩之后、发送之前跑，
      // 剥掉 <internal_states> / GFX 块 / <!-- IMG_PROMPT:… --> / 思考块，让发出去的体积更小。
      // ⚠️ 只作用于这份待发副本，绝不回写 conv.messages（界面显示不受影响）。
      const finalMessages = applyOutgoingRegex(shrunk, settingsStore.regexRules);
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
          stopping_strings:
            settingsStore.stoppingStrings.length > 0 ? settingsStore.stoppingStrings : null,
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
