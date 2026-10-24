import { create } from "zustand";
import type { Conversation, Message, WorkSubMode } from "@/types";
import {
  dbCreateConv,
  dbLoadAll,
  dbDeleteConv,
  dbRenameConv,
  dbAddMsg,
  dbBatchAddMessages,
  dbUpdateMsgContent,
  dbUpdateMsgReasoning,
  dbUpdateMsgError,
  dbDeleteLastAsmMsg,
  dbClearMessages,
  dbUpdateConvSummary,
  dbSetMsgBookmark,
  dbBatchDeleteConvs,
} from "@/lib/tauri";
import { useCharacterStore } from "./useCharacterStore";
import { useAppModeStore } from "./useAppModeStore";
import { parseErrorKind } from "@/lib/persist-sanitize";

function generateId(): string {
  return crypto.randomUUID();
}
function nowISO(): string {
  return new Date().toISOString();
}

/** 归档会话的 localStorage key(与 toggleArchive 共用) */
const ARCHIVED_KEY = "arc_convs";

/** 每个子模式各自记住的 activeId（刷新/重启后恢复） */
const ACTIVE_KEY = (mode: WorkSubMode) => `conv_active_${mode}`;

/** 读取当前工作子模式。字段由 useAppModeStore 维护；缺失/非法值按 "work" 兜底，
 *  保证升级前建的会话仍落在「工作」列表里。 */
function readWorkSubMode(): WorkSubMode {
  const state = useAppModeStore.getState() as { workSubMode?: WorkSubMode };
  return state.workSubMode === "chat" ? "chat" : "work";
}

/** 前端兜底：旧数据没有 work_mode（或值陌生）一律归到「工作」 */
export function convWorkMode(c: Pick<Conversation, "work_mode">): WorkSubMode {
  return c.work_mode === "chat" ? "chat" : "work";
}

function readActive(mode: WorkSubMode): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY(mode));
  } catch {
    return null;
  }
}

function persistActive(mode: WorkSubMode, id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY(mode), id);
    else localStorage.removeItem(ACTIVE_KEY(mode));
  } catch {
    // localStorage 不可用(隐私模式等)：仅失去跨重启记忆，不影响本次会话
  }
}

function visibleOf(all: Conversation[], mode: WorkSubMode): Conversation[] {
  return all.filter((c) => convWorkMode(c) === mode);
}

/** 选择要恢复的 activeId：优先该模式记住的；否则取最近更新的；没有则 null。 */
function pickActive(visible: Conversation[], remembered: string | null): string | null {
  if (remembered && visible.some((c) => c.id === remembered)) return remembered;
  if (visible.length === 0) return null;
  return (
    [...visible].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    )[0]?.id ?? null
  );
}

/** Build the partial DTO shape the Rust side expects for a stored message */
function toMsgDto(msg: Message, convId: string, seq: number) {
  return {
    id: msg.id,
    conv_id: convId,
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
    token_count: 0,
    model: msg.model || "",
    reasoning: msg.reasoning || "",
    seq,
    error: msg.error || "",
    error_kind: msg.errorKind || "",
    bookmarked: msg.bookmarked || false,
  };
}

interface ConversationState {
  /** 全量会话：工作模式下除 RP 外的全部会话（跨越 chat/work 两个子模式） */
  allConversations: Conversation[];
  /** 当前子模式可见的会话（allConversations 的过滤视图） */
  conversations: Conversation[];
  /** 当前工作子模式：对话 / 工作 */
  workSubMode: WorkSubMode;
  /** 每个子模式各自记住的 activeId */
  activeByMode: Record<WorkSubMode, string | null>;
  /** 每个子模式各自的标签集合（切换模式不串台） */
  tabsByMode: Record<WorkSubMode, string[]>;
  activeId: string | null;
  tabIds: string[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 模式切换方调用：重算可见列表 / activeId / tabIds，并恢复该模式上次的会话 */
  applyWorkSubMode: (mode: WorkSubMode) => void;
  save: (conv: Conversation) => Promise<void>;
  create: () => Promise<Conversation>;
  /** 新建绑定角色的角色扮演会话(酒馆风格:标题=角色名,自动写入开场白 first_mes) */
  createWithCharacter: (
    characterId: string,
    opts?: { personaId?: string; title?: string }
  ) => Promise<Conversation>;
  remove: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  openTab: (id: string) => void;
  closeTab: (id: string) => void;
  addMessage: (convId: string, msg: Message) => Promise<void>;
  /** P1 热路径批量化：一次 IPC 插入多条消息并更新会话标题/时间戳 */
  addMessagesBatch: (convId: string, msgs: Message[]) => Promise<void>;
  updateMessage: (convId: string, msgId: string, content: string) => Promise<void>;
  updateMessageReasoning: (convId: string, msgId: string, reasoning: string) => Promise<void>;
  updateMessageError: (
    convId: string,
    msgId: string,
    error: string,
    errorKind?: string
  ) => Promise<void>;
  /** 消息书签:切换单条消息书签状态 */
  toggleBookmark: (convId: string, msgId: string) => Promise<void>;
  /** 批量删除会话(一次 IPC) */
  removeMany: (ids: string[]) => Promise<void>;
  /** 批量归档/取消归档 */
  toggleArchiveMany: (ids: string[], archived: boolean) => Promise<void>;
  removeLastAssistantMessage: (convId: string) => Promise<void>;
  /** Context compression: wipe all messages, then seed the summary (Chatbox style) */
  replaceMessages: (convId: string, seed: Message[]) => Promise<void>;
  /** 自动记忆:持久化会话摘要 + 摘要时的消息数记账(轻量 IPC,不重写其他字段) */
  updateSummary: (convId: string, summary: string, summaryMsgCount: number) => Promise<void>;
  /** 会话重置:清空当前对话消息、上下文归零、标题回到 "New Chat"(会话保留) */
  clearConversation: (convId: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  getActive: () => Conversation | undefined;
  favorites: string[];
  archived: string[];
  toggleFavorite: (id: string) => void;
  toggleArchive: (id: string) => void;
  isFavorite: (id: string) => boolean;
  isArchived: (id: string) => boolean;
}

/** 全量列表读取：优先 allConversations；为空时回退到 conversations，
 *  兼容测试/旧调用方直接 `setState({ conversations })` 的写法。 */
function allOf(s: Pick<ConversationState, "allConversations" | "conversations">): Conversation[] {
  return s.allConversations.length > 0 ? s.allConversations : s.conversations;
}

/** 把「全量列表 + 当前子模式」同步成可见列表。
 *  fallback 模式下（allConversations 为空、数据由 `setState({conversations})` 注入）
 *  不回写 allConversations —— 否则注入的数据会被固化成"全量源"，跨用例/跨调用残留。 */
function withAll(s: ConversationState, all: Conversation[]) {
  if (s.allConversations.length === 0) {
    return { conversations: visibleOf(all, s.workSubMode) };
  }
  return { allConversations: all, conversations: visibleOf(all, s.workSubMode) };
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  allConversations: [],
  conversations: [],
  workSubMode: readWorkSubMode(),
  activeByMode: { chat: readActive("chat"), work: readActive("work") },
  tabsByMode: { chat: [], work: [] },
  activeId: null,
  tabIds: [],
  loaded: false,

  load: async () => {
    try {
      // P1-3: 单次 IPC 批量加载全部会话 + 消息（替代 N+1 次 list_msgs）
      const { conversations: convs, messages: msgsMap } = await dbLoadAll();
      const result: Conversation[] = convs
        // 酒馆模式隔离:工作模式只显示普通会话,RP 会话(character_id 非空)
        // 完全留给酒馆模式,永不交叉
        .filter((c) => !c.character_id)
        .map((c) => ({
          id: c.id,
          title: c.title,
          created_at: c.created_at,
          updated_at: c.updated_at,
          model_name: c.model_name,
          system_prompt: c.system_prompt || "",
          character_id: c.character_id || "",
          persona_id: c.persona_id || "",
          // 旧库/旧导入件无 work_mode → 归到「工作」，升级后会话不消失
          work_mode: convWorkMode(c),
          // 自动记忆(RP 会话在工作模式的扩展):摘要从 sled 恢复
          summary: c.summary || "",
          summary_msg_count: c.summary_msg_count ?? 0,
          messages: (msgsMap[c.id] || []).map((m) => ({
            id: m.id,
            role: m.role as Message["role"],
            content: m.content,
            timestamp: m.timestamp,
            model: m.model || "",
            reasoning: m.reasoning || "",
            seq: m.seq ?? 0,
            error: m.error || "",
            // 后端/旧库里的陌生字符串不能 `as ErrorKind` 硬塞，否则渲染层按枚举分支会失准
            errorKind: parseErrorKind(m.error_kind),
            bookmarked: m.bookmarked || false,
          })),
        }));
      result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      const s = get();
      const mode = s.workSubMode;
      const visible = visibleOf(result, mode);
      const visibleIds = new Set(visible.map((c) => c.id));
      // 启动时只恢复「该模式记住的」会话；没有记忆则保持空态（不擅自打开旧会话）
      const remembered = s.activeByMode[mode];
      const activeId = remembered && visibleIds.has(remembered) ? remembered : null;
      let tabIds = s.tabsByMode[mode].filter((id) => visibleIds.has(id));
      if (activeId && !tabIds.includes(activeId)) tabIds = [...tabIds, activeId];

      set({
        allConversations: result,
        conversations: visible,
        activeId,
        tabIds,
        activeByMode: { ...s.activeByMode, [mode]: activeId },
        tabsByMode: { ...s.tabsByMode, [mode]: tabIds },
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  applyWorkSubMode: (mode) => {
    const s = get();
    const all = allOf(s);
    const visible = visibleOf(all, mode);
    const activeId = pickActive(visible, s.activeByMode[mode]);
    const visibleIds = new Set(visible.map((c) => c.id));
    let tabIds = s.tabsByMode[mode].filter((id) => visibleIds.has(id));
    // 恢复的会话也要出现在标签栏，行为与 create/openTab 一致
    if (activeId && !tabIds.includes(activeId)) tabIds = [...tabIds, activeId];

    persistActive(mode, activeId);
    set({
      workSubMode: mode,
      conversations: visible,
      activeId,
      tabIds,
      activeByMode: { ...s.activeByMode, [mode]: activeId },
      tabsByMode: { ...s.tabsByMode, [mode]: tabIds },
    });
  },

  save: async (conv) => {
    const updatedAt = nowISO();
    const workMode = convWorkMode(conv);
    await dbCreateConv({
      id: conv.id,
      title: conv.title,
      model_name: conv.model_name || "",
      system_prompt: conv.system_prompt || "",
      created_at: conv.created_at,
      updated_at: updatedAt,
      character_id: conv.character_id || "",
      persona_id: conv.persona_id || "",
      // 自动记忆(RP 会话在工作模式的扩展):摘要持久化,重启保留
      summary: conv.summary || "",
      summary_msg_count: conv.summary_msg_count ?? 0,
      work_mode: workMode,
    });
    const saved: Conversation = { ...conv, updated_at: updatedAt, work_mode: workMode };
    set((s) => {
      const all = allOf(s).map((c) => (c.id === conv.id ? saved : c));
      return withAll(s, all);
    });
  },

  create: async () => {
    const mode = get().workSubMode;
    const conv: Conversation = {
      id: generateId(),
      title: "New Chat",
      created_at: nowISO(),
      updated_at: nowISO(),
      model_name: "",
      messages: [],
      work_mode: mode,
    };
    await dbCreateConv({
      id: conv.id,
      title: conv.title,
      model_name: "",
      system_prompt: "",
      created_at: conv.created_at,
      updated_at: conv.updated_at,
      work_mode: mode,
    });
    const s = get();
    const all = [conv, ...allOf(s)];
    const tabIds = [...s.tabIds.filter((id) => id !== conv.id), conv.id];
    persistActive(mode, conv.id);
    set({
      // 新建即建立全量源（即使此前是零会话），避免后续 applyWorkSubMode 丢失它
      allConversations: all,
      conversations: visibleOf(all, mode),
      activeId: conv.id,
      tabIds,
      activeByMode: { ...s.activeByMode, [mode]: conv.id },
      tabsByMode: { ...s.tabsByMode, [mode]: tabIds },
    });
    return conv;
  },

  createWithCharacter: async (characterId, opts) => {
    const charStore = useCharacterStore.getState();
    const card = charStore.characters.find((c) => c.id === characterId);
    if (!card) return get().create();
    const mode = get().workSubMode;
    const personaId = opts?.personaId ?? charStore.activePersonaId;
    const conv: Conversation = {
      id: generateId(),
      title: opts?.title || card.name || "New Chat",
      created_at: nowISO(),
      updated_at: nowISO(),
      model_name: "",
      messages: [],
      character_id: characterId,
      persona_id: personaId || undefined,
      work_mode: mode,
    };
    await dbCreateConv({
      id: conv.id,
      title: conv.title,
      model_name: "",
      system_prompt: "",
      created_at: conv.created_at,
      updated_at: conv.updated_at,
      character_id: characterId,
      persona_id: personaId || "",
      work_mode: mode,
    });

    // 开场白:first_mes({{user}}/{{char}} 替换后)作为首条 assistant 消息
    if (card.first_mes?.trim()) {
      const persona = charStore.personas.find((p) => p.id === personaId);
      const userName = persona?.name || "User";
      const content = card.first_mes
        .split("{{user}}")
        .join(userName)
        .split("{{char}}")
        .join(card.name);
      const opening: Message = {
        id: generateId(),
        role: "assistant",
        content,
        timestamp: nowISO(),
        model: card.name,
        seq: 1,
      };
      conv.messages.push(opening);
      await dbBatchAddMessages(
        conv.id,
        [toMsgDto(opening, conv.id, 1)],
        conv.title,
        conv.updated_at
      );
    }

    const s = get();
    const all = [conv, ...allOf(s)];
    const tabIds = [...s.tabIds.filter((id) => id !== conv.id), conv.id];
    persistActive(mode, conv.id);
    set({
      allConversations: all,
      conversations: visibleOf(all, mode),
      activeId: conv.id,
      tabIds,
      activeByMode: { ...s.activeByMode, [mode]: conv.id },
      tabsByMode: { ...s.tabsByMode, [mode]: tabIds },
    });
    return conv;
  },

  remove: async (id) => {
    const s = get();
    await dbDeleteConv(id);
    const all = allOf(s).filter((c) => c.id !== id);
    const tabIds = s.tabIds.filter((tid) => tid !== id);
    const activeId = s.activeId === id ? tabIds[0] || null : s.activeId;
    persistActive(s.workSubMode, activeId);
    set({
      ...withAll(s, all),
      tabIds,
      activeId,
      activeByMode: { ...s.activeByMode, [s.workSubMode]: activeId },
      tabsByMode: { ...s.tabsByMode, [s.workSubMode]: tabIds },
    });
  },

  setActive: (id) => {
    const s = get();
    persistActive(s.workSubMode, id);
    set({
      activeId: id,
      activeByMode: { ...s.activeByMode, [s.workSubMode]: id },
    });
  },

  openTab: (id) => {
    const s = get();
    const tabIds = s.tabIds.includes(id) ? s.tabIds : [...s.tabIds, id];
    persistActive(s.workSubMode, id);
    set({
      tabIds,
      activeId: id,
      activeByMode: { ...s.activeByMode, [s.workSubMode]: id },
      tabsByMode: { ...s.tabsByMode, [s.workSubMode]: tabIds },
    });
  },

  closeTab: (id) => {
    const s = get();
    const tabIds = s.tabIds.filter((tid) => tid !== id);
    const activeId = s.activeId === id ? tabIds[tabIds.length - 1] || null : s.activeId;
    persistActive(s.workSubMode, activeId);
    set({
      tabIds,
      activeId,
      activeByMode: { ...s.activeByMode, [s.workSubMode]: activeId },
      tabsByMode: { ...s.tabsByMode, [s.workSubMode]: tabIds },
    });
  },

  addMessage: async (convId, msg) => {
    // seq: monotonic per-conversation insertion order — timestamps alone are
    // not enough (a 一问多答 turn creates N assistant messages in the same
    // millisecond, so restart would scramble their order).
    const conv = allOf(get()).find((c) => c.id === convId);
    const seq = (conv ? Math.max(0, ...conv.messages.map((m) => m.seq ?? 0)) : 0) + 1;
    await dbAddMsg(toMsgDto(msg, convId, seq));
    if (conv) {
      const stored = { ...msg, seq };
      conv.messages.push(stored);
      if (conv.messages.length === 1 && msg.role === "user") conv.title = msg.content.slice(0, 50);
      conv.updated_at = nowISO();
      await dbCreateConv({
        id: conv.id,
        title: conv.title,
        model_name: conv.model_name || "",
        system_prompt: conv.system_prompt || "",
        created_at: conv.created_at,
        updated_at: conv.updated_at,
        character_id: conv.character_id || "",
        persona_id: conv.persona_id || "",
        // 整条重写会话记录：必须带上原 work_mode，否则 chat 会话会被默认值改回 work
        work_mode: convWorkMode(conv),
      });
      set((s) => withAll(s, allOf(s)));
    }
  },

  addMessagesBatch: async (convId, msgs) => {
    const conv = allOf(get()).find((c) => c.id === convId);
    const base = conv ? Math.max(0, ...conv.messages.map((m) => m.seq ?? 0)) : 0;
    const updated = msgs.map((m, i) => ({ ...m, seq: base + i + 1 }));
    await dbBatchAddMessages(
      convId,
      updated.map((m, i) => toMsgDto(m, convId, base + i + 1)),
      conv?.title || "New Chat",
      nowISO()
    );
    if (conv) {
      conv.messages.push(...updated);
      if (conv.messages.length === msgs.length) {
        const firstUser = updated.find((m) => m.role === "user");
        if (firstUser) conv.title = firstUser.content.slice(0, 50);
      }
      conv.updated_at = nowISO();
      set((s) => withAll(s, allOf(s)));
    }
  },

  updateMessage: async (convId, msgId, content) => {
    await dbUpdateMsgContent(msgId, convId, content);
    set((s) => {
      const all = allOf(s).map((c) =>
        c.id === convId
          ? {
              ...c,
              updated_at: nowISO(),
              messages: c.messages.map((m) => (m.id === msgId ? { ...m, content } : m)),
            }
          : c
      );
      return withAll(s, all);
    });
  },

  updateMessageReasoning: async (convId, msgId, reasoning) => {
    await dbUpdateMsgReasoning(msgId, convId, reasoning);
    set((s) => {
      const all = allOf(s).map((c) =>
        c.id === convId
          ? {
              ...c,
              updated_at: nowISO(),
              messages: c.messages.map((m) => (m.id === msgId ? { ...m, reasoning } : m)),
            }
          : c
      );
      return withAll(s, all);
    });
  },

  updateMessageError: async (convId, msgId, error, errorKind = "") => {
    await dbUpdateMsgError(msgId, convId, error, errorKind);
    set((s) => {
      const all = allOf(s).map((c) =>
        c.id === convId
          ? {
              ...c,
              updated_at: nowISO(),
              messages: c.messages.map((m) =>
                m.id === msgId ? { ...m, error, errorKind: parseErrorKind(errorKind) } : m
              ),
            }
          : c
      );
      return withAll(s, all);
    });
  },

  /** 消息书签:切换单条消息书签状态(长会话快速跳回) */
  toggleBookmark: async (convId, msgId) => {
    const conv = allOf(get()).find((c) => c.id === convId);
    const msg = conv?.messages.find((m) => m.id === msgId);
    if (!conv || !msg) return;
    const next = !msg.bookmarked;
    await dbSetMsgBookmark(msgId, convId, next);
    set((s) => {
      const all = allOf(s).map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: c.messages.map((m) => (m.id === msgId ? { ...m, bookmarked: next } : m)),
            }
          : c
      );
      return withAll(s, all);
    });
  },

  /** 批量删除会话:一次 IPC 删除多个会话(替代 N 次单删往返) */
  removeMany: async (ids) => {
    if (ids.length === 0) return;
    const s = get();
    await dbBatchDeleteConvs(ids);
    const all = allOf(s).filter((c) => !ids.includes(c.id));
    const tabIds = s.tabIds.filter((id) => !ids.includes(id));
    const activeId = s.activeId && ids.includes(s.activeId) ? null : s.activeId;
    persistActive(s.workSubMode, activeId);
    set({
      ...withAll(s, all),
      tabIds,
      activeId,
      activeByMode: { ...s.activeByMode, [s.workSubMode]: activeId },
      tabsByMode: { ...s.tabsByMode, [s.workSubMode]: tabIds },
    });
  },

  /** 批量归档/取消归档:切换多个会话的归档状态(localStorage,与单条一致) */
  toggleArchiveMany: async (ids, archived) => {
    const cur = new Set(get().archived);
    for (const id of ids) {
      if (archived) cur.add(id);
      else cur.delete(id);
    }
    const next = [...cur];
    localStorage.setItem(ARCHIVED_KEY, JSON.stringify(next));
    set({ archived: next });
  },

  removeLastAssistantMessage: async (convId) => {
    await dbDeleteLastAsmMsg(convId);
    set((s) => {
      const all = allOf(s).map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: c.messages.filter(
                (m, i, arr) => !(m.role === "assistant" && i === arr.length - 1)
              ),
            }
          : c
      );
      return withAll(s, all);
    });
  },

  replaceMessages: async (convId, seed) => {
    await dbClearMessages(convId);
    const updated = seed.map((m, i) => ({ ...m, seq: i + 1 }));
    await dbBatchAddMessages(
      convId,
      updated.map((m, i) => toMsgDto(m, convId, i + 1)),
      "New Chat",
      nowISO()
    );
    set((s) => {
      const all = allOf(s).map((c) =>
        c.id === convId
          ? {
              ...c,
              updated_at: nowISO(),
              messages: updated,
            }
          : c
      );
      return withAll(s, all);
    });
  },

  clearConversation: async (convId) => {
    await dbClearMessages(convId);
    const now = nowISO();
    await dbRenameConv(convId, "New Chat", now);
    set((s) => {
      const all = allOf(s).map((c) =>
        c.id === convId
          ? {
              ...c,
              updated_at: now,
              messages: [],
              title: "New Chat",
            }
          : c
      );
      return withAll(s, all);
    });
  },

  rename: async (id, title) => {
    const conv = allOf(get()).find((c) => c.id === id);
    if (!conv) return;
    conv.title = title;
    conv.updated_at = nowISO();
    await dbRenameConv(id, title, conv.updated_at);
    set((s) => withAll(s, allOf(s)));
  },

  updateSummary: async (convId, summary, summaryMsgCount) => {
    const now = nowISO();
    await dbUpdateConvSummary(convId, summary, summaryMsgCount, now);
    set((s) => {
      const all = allOf(s).map((c) =>
        c.id === convId ? { ...c, summary, summary_msg_count: summaryMsgCount } : c
      );
      return withAll(s, all);
    });
  },

  getActive: () => allOf(get()).find((c) => c.id === get().activeId),

  // Favorites & Archive (stored in localStorage)
  favorites: JSON.parse(localStorage.getItem("fav_convs") || "[]") as string[],
  archived: JSON.parse(localStorage.getItem("arc_convs") || "[]") as string[],
  toggleFavorite: (id) =>
    set((s) => {
      const favs = s.favorites.includes(id)
        ? s.favorites.filter((f) => f !== id)
        : [...s.favorites, id];
      localStorage.setItem("fav_convs", JSON.stringify(favs));
      return { favorites: favs };
    }),
  toggleArchive: (id) =>
    set((s) => {
      const arch = s.archived.includes(id)
        ? s.archived.filter((a) => a !== id)
        : [...s.archived, id];
      localStorage.setItem("arc_convs", JSON.stringify(arch));
      return { archived: arch };
    }),
  isFavorite: (id) => get().favorites.includes(id),
  isArchived: (id) => get().archived.includes(id),
}));
