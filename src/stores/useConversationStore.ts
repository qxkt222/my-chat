import { create } from "zustand";
import type { Conversation, Message } from "@/types";
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

function generateId(): string {
  return crypto.randomUUID();
}
function nowISO(): string {
  return new Date().toISOString();
}

/** 归档会话的 localStorage key(与 toggleArchive 共用) */
const ARCHIVED_KEY = "arc_convs";

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
  conversations: Conversation[];
  activeId: string | null;
  tabIds: string[];
  loaded: boolean;
  load: () => Promise<void>;
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

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
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
            errorKind: m.error_kind || "",
            bookmarked: m.bookmarked || false,
          })),
        }));
      result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      set({ conversations: result, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  save: async (conv) => {
    await dbCreateConv({
      id: conv.id,
      title: conv.title,
      model_name: conv.model_name || "",
      system_prompt: conv.system_prompt || "",
      created_at: conv.created_at,
      updated_at: nowISO(),
      character_id: conv.character_id || "",
      persona_id: conv.persona_id || "",
      // 自动记忆(RP 会话在工作模式的扩展):摘要持久化,重启保留
      summary: conv.summary || "",
      summary_msg_count: conv.summary_msg_count ?? 0,
    });
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conv.id ? { ...conv, updated_at: nowISO() } : c
      ),
    }));
  },

  create: async () => {
    const conv: Conversation = {
      id: generateId(),
      title: "New Chat",
      created_at: nowISO(),
      updated_at: nowISO(),
      model_name: "",
      messages: [],
    };
    await dbCreateConv({
      id: conv.id,
      title: conv.title,
      model_name: "",
      system_prompt: "",
      created_at: conv.created_at,
      updated_at: conv.updated_at,
    });
    set((s) => ({
      conversations: [conv, ...s.conversations],
      activeId: conv.id,
      tabIds: [...s.tabIds.filter((id) => id !== conv.id), conv.id],
    }));
    return conv;
  },

  createWithCharacter: async (characterId, opts) => {
    const charStore = useCharacterStore.getState();
    const card = charStore.characters.find((c) => c.id === characterId);
    if (!card) return get().create();
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

    set((s) => ({
      conversations: [conv, ...s.conversations],
      activeId: conv.id,
      tabIds: [...s.tabIds.filter((id) => id !== conv.id), conv.id],
    }));
    return conv;
  },

  remove: async (id) => {
    await dbDeleteConv(id);
    set((s) => {
      const conversations = s.conversations.filter((c) => c.id !== id);
      const tabIds = s.tabIds.filter((tid) => tid !== id);
      return {
        conversations,
        tabIds,
        activeId: s.activeId === id ? tabIds[0] || null : s.activeId,
      };
    });
  },

  setActive: (id) => set({ activeId: id }),
  openTab: (id) =>
    set((s) => ({ tabIds: s.tabIds.includes(id) ? s.tabIds : [...s.tabIds, id], activeId: id })),
  closeTab: (id) =>
    set((s) => {
      const tabIds = s.tabIds.filter((tid) => tid !== id);
      return {
        tabIds,
        activeId: s.activeId === id ? tabIds[tabIds.length - 1] || null : s.activeId,
      };
    }),

  addMessage: async (convId, msg) => {
    // seq: monotonic per-conversation insertion order — timestamps alone are
    // not enough (a 一问多答 turn creates N assistant messages in the same
    // millisecond, so restart would scramble their order).
    const conv = get().conversations.find((c) => c.id === convId);
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
      });
      set((s) => ({ conversations: [...s.conversations] }));
    }
  },

  addMessagesBatch: async (convId, msgs) => {
    const conv = get().conversations.find((c) => c.id === convId);
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
      set((s) => ({ conversations: [...s.conversations] }));
    }
  },

  updateMessage: async (convId, msgId, content) => {
    await dbUpdateMsgContent(msgId, convId, content);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              updated_at: nowISO(),
              messages: c.messages.map((m) => (m.id === msgId ? { ...m, content } : m)),
            }
          : c
      ),
    }));
  },

  updateMessageReasoning: async (convId, msgId, reasoning) => {
    await dbUpdateMsgReasoning(msgId, convId, reasoning);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              updated_at: nowISO(),
              messages: c.messages.map((m) => (m.id === msgId ? { ...m, reasoning } : m)),
            }
          : c
      ),
    }));
  },

  updateMessageError: async (convId, msgId, error, errorKind = "") => {
    await dbUpdateMsgError(msgId, convId, error, errorKind);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              updated_at: nowISO(),
              messages: c.messages.map((m) => (m.id === msgId ? { ...m, error, errorKind } : m)),
            }
          : c
      ),
    }));
  },

  /** 消息书签:切换单条消息书签状态(长会话快速跳回) */
  toggleBookmark: async (convId, msgId) => {
    const conv = get().conversations.find((c) => c.id === convId);
    const msg = conv?.messages.find((m) => m.id === msgId);
    if (!conv || !msg) return;
    const next = !msg.bookmarked;
    await dbSetMsgBookmark(msgId, convId, next);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: c.messages.map((m) => (m.id === msgId ? { ...m, bookmarked: next } : m)),
            }
          : c
      ),
    }));
  },

  /** 批量删除会话:一次 IPC 删除多个会话(替代 N 次单删往返) */
  removeMany: async (ids) => {
    if (ids.length === 0) return;
    await dbBatchDeleteConvs(ids);
    set((s) => ({
      conversations: s.conversations.filter((c) => !ids.includes(c.id)),
      activeId: s.activeId && ids.includes(s.activeId) ? null : s.activeId,
      tabIds: s.tabIds.filter((id) => !ids.includes(id)),
    }));
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
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: c.messages.filter(
                (m, i, arr) => !(m.role === "assistant" && i === arr.length - 1)
              ),
            }
          : c
      ),
    }));
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
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              updated_at: nowISO(),
              messages: updated,
            }
          : c
      ),
    }));
  },

  clearConversation: async (convId) => {
    await dbClearMessages(convId);
    const now = nowISO();
    await dbRenameConv(convId, "New Chat", now);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              updated_at: now,
              messages: [],
              title: "New Chat",
            }
          : c
      ),
    }));
  },

  rename: async (id, title) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    conv.title = title;
    conv.updated_at = nowISO();
    await dbRenameConv(id, title, conv.updated_at);
    set((s) => ({ conversations: [...s.conversations] }));
  },

  updateSummary: async (convId, summary, summaryMsgCount) => {
    const now = nowISO();
    await dbUpdateConvSummary(convId, summary, summaryMsgCount, now);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId ? { ...c, summary, summary_msg_count: summaryMsgCount } : c
      ),
    }));
  },

  getActive: () => get().conversations.find((c) => c.id === get().activeId),

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
