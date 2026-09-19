import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Users,
  Plus,
  Search,
  Trash2,
  Send,
  Square,
  Settings2,
  UserRound,
  Languages,
  BookOpen,
  NotebookPen,
  UsersRound,
  Eye,
  Share2,
  RefreshCw,
  X,
} from "lucide-react";
import { useCharacterStore } from "@/stores/useCharacterStore";
import { useTavernStore } from "@/stores/useTavernStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { SimulationView } from "@/components/simulation/SimulationView";
import { ContextViewer } from "@/components/tavern/ContextViewer";
import { QuickReplyBar } from "@/components/chat/QuickReplyBar";
import { MemoryGraphPanel } from "@/components/tavern/MemoryGraphPanel";
import { extractGraph } from "@/lib/memory-graph";
import { useT } from "@/lib/i18n";
import { detectEmotion, emotionImagePath, emotionImageExists } from "@/lib/emotion";
import { showToast } from "@/components/ui/Toast";
import { askPrompt } from "@/components/ui/ConfirmDialog";
import { MessageBubble } from "@/components/chat/MessageBubble";
import type { Message, TavernConversation } from "@/types";

interface Props {
  onOpenSettings: () => void;
}

/**
 * 酒馆模式(TavernView):独立角色扮演界面,与工作模式会话完全隔离。
 * 左栏 = 角色卡列表 + Persona + RP 会话(按角色分组);右区 = 沉浸聊天。
 */
export function TavernView({ onOpenSettings }: Props) {
  const t = useT();
  const charStore = useCharacterStore();
  const tavern = useTavernStore();
  const models = useSettingsStore((s) => s.models);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const settings = useSettingsStore();
  // 酒馆子模式:角色扮演 / 推演(持久化)
  const subMode = useAppModeStore((s) => s.tavernSubMode);
  const setSubMode = useAppModeStore((s) => s.setTavernSubMode);
  const [search, setSearch] = useState("");
  const [convSearch, setConvSearch] = useState("");
  const [input, setInput] = useState("");
  const [showLorePicker, setShowLorePicker] = useState(false);
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [showMemPanel, setShowMemPanel] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [groupSel, setGroupSel] = useState<string[]>([]);
  const [varKey, setVarKey] = useState("");
  const [varVal, setVarVal] = useState("");
  const [attName, setAttName] = useState("");
  const [attContent, setAttContent] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const msgRefs = useRef<Record<string, HTMLElement | null>>({});
  /** 表情图文件不存在的消息 id 集合(破图回退角色头像) */
  const [brokenEmo, setBrokenEmo] = useState<Set<string>>(new Set());

  // 启动加载 tavern 会话(角色卡已在 App 启动加载)
  useEffect(() => {
    void tavern.load();
  }, [tavern]);

  // 群聊/世界书选择弹层 Escape 关闭(此前只能点遮罩或保存按钮)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showGroupPicker) setShowGroupPicker(false);
      if (showLorePicker) setShowLorePicker(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [showGroupPicker, showLorePicker]);

  const cards = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? charStore.characters.filter(
          (c) => c.name.toLowerCase().includes(q) || c.tags.some((x) => x.toLowerCase().includes(q))
        )
      : charStore.characters;
  }, [charStore.characters, search]);

  const convsByChar = useMemo(() => {
    const map: Record<string, TavernConversation[]> = {};
    for (const c of tavern.conversations) {
      // 群聊独立分组(此前塞进首角色名下,分组/搜索错位)
      const key = (c.groupCharIds?.length || 0) >= 2 ? "__group__" : c.character_id;
      (map[key] ||= []).push(c);
    }
    return map;
  }, [tavern.conversations]);

  const active = tavern.getActive();
  const activeCard = active ? charStore.characters.find((c) => c.id === active.character_id) : null;
  const activePersona = active
    ? charStore.personas.find((p) => p.id === active.persona_id) || null
    : null;
  const model = models.find((m) => m.name === activeModel);

  // 自动滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [active?.messages.length, tavern.isStreaming]);

  // 异步校验:检测到表情但文件不存在(如酒馆卡带 emotions 却没上传表情图)的消息,
  // 标记为回退角色头像——此前直接渲染 asset:// 不存在路径导致头像全破
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const broken = new Set<string>();
      const cur = active;
      if (!cur) return;
      for (const m of cur.messages) {
        if (m.role !== "assistant") continue;
        const card =
          (cur.groupCharIds?.length || 0) >= 2
            ? charStore.characters.find((c) => c.name === m.model)
            : activeCard;
        if (!card) continue;
        const emo = detectEmotion(m.content, card);
        const emoPath = emo ? emotionImagePath(card, emo) : null;
        if (emoPath && !(await emotionImageExists(emoPath))) broken.add(m.id);
      }
      if (!cancelled) setBrokenEmo(broken);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [active?.id, active?.messages.length, activeCard, charStore.characters]);

  // 记忆图谱点击跳转:滚动到对应消息并高亮闪烁(此前 onJump 只关面板,跳转是假的)
  const jumpToMessage = (msgId: string) => {
    setShowGraph(false);
    const el = msgRefs.current[msgId];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("bg-primary/10");
    setTimeout(() => el.classList.remove("bg-primary/10"), 1800);
  };

  // 消息编辑:弹输入框,改后落盘到 tavern/{id}.json
  const editMessage = async (msg: Message) => {
    if (!active) return;
    const updated = await askPrompt(t("chat.edit"), msg.content);
    if (updated === null || updated === msg.content) return;
    await tavern.saveConv({
      ...active,
      updated_at: new Date().toISOString(),
      messages: active.messages.map((m) => (m.id === msg.id ? { ...m, content: updated } : m)),
    });
  };

  const startCharacter = async (charId: string) => {
    try {
      const conv = await tavern.createWithCharacter(charId);
      tavern.setActive(conv.id);
    } catch (e) {
      showToast("error", String(e));
    }
  };

  const handleSend = () => {
    const content = input.trim();
    if (!content || tavern.isStreaming) return;
    setInput("");
    void tavern.sendMessage(content);
  };

  const avatarOf = (path?: string) => (path ? convertFileSrc(path) : null);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* 酒馆子模式切换条:角色扮演 / 推演(会话完全隔离,选择持久化) */}
      <div className="flex items-center gap-1 px-4 py-1.5 border-b border-border bg-muted/40 shrink-0">
        <Users className="w-3.5 h-3.5 text-primary mr-1" />
        <button
          onClick={() => setSubMode("rp")}
          className={`px-3 py-1 text-xs rounded-md transition-colors ${subMode === "rp" ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}
        >
          {t("appMode.tavernSub.rp")}
        </button>
        <button
          onClick={() => setSubMode("simulate")}
          className={`px-3 py-1 text-xs rounded-md transition-colors ${subMode === "simulate" ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}
        >
          {t("appMode.tavernSub.simulate")}
        </button>
      </div>
      {subMode === "simulate" ? (
        <SimulationView onOpenSettings={onOpenSettings} />
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* ── 左栏:角色卡 + Persona + RP 会话 ── */}
          <aside className="w-60 bg-card border-r border-border flex flex-col shrink-0">
            {/* 标题 + 管理入口 */}
            <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
              <Users className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold">{t("tavern.title")}</span>
              <div className="flex-1" />
              <button
                onClick={onOpenSettings}
                title={t("tavern.manage")}
                className="p-1 rounded hover:bg-muted text-muted-foreground"
              >
                <Settings2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* 角色卡搜索 */}
            <div className="px-2 pb-1.5">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("tavern.searchChar")}
                  className="w-full pl-7 pr-2 py-1.5 text-xs bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              {/* 群聊入口:多选角色建群聊 */}
              <button
                onClick={() => {
                  setGroupSel([]);
                  setShowGroupPicker(true);
                }}
                className="w-full mt-1.5 px-2 py-1.5 text-[11px] rounded border border-dashed border-primary/40 text-primary hover:bg-primary/5 flex items-center gap-1.5"
              >
                <UsersRound className="w-3.5 h-3.5" /> {t("tavern.groupNew")}
              </button>
            </div>

            {/* 角色卡列表 */}
            <div className="text-[10px] text-[#8899A6] uppercase tracking-[0.6px] px-3.5 pb-1">
              {t("tavern.characters")}
            </div>
            <div className="overflow-y-auto px-1 max-h-44">
              {cards.map((c) => (
                <button
                  key={c.id}
                  onClick={() => startCharacter(c.id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-muted transition-colors text-left"
                  title={t("tavern.start", { name: c.name })}
                >
                  <span className="w-6 h-6 rounded-full overflow-hidden bg-muted shrink-0 flex items-center justify-center">
                    {c.avatarPath ? (
                      <img
                        src={convertFileSrc(c.avatarPath)}
                        alt={c.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Users className="w-3 h-3 text-muted-foreground" />
                    )}
                  </span>
                  <span className="flex-1 truncate">{c.name}</span>
                  <Plus className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
                </button>
              ))}
              {cards.length === 0 && (
                <p className="text-[11px] text-muted-foreground px-3 py-4 text-center">
                  {t("tavern.noChars")}
                </p>
              )}
            </div>

            {/* Persona 切换(全局激活;{{user}} 宏 = 此名) */}
            <div className="border-t border-border mt-2 px-3 pt-2 pb-1.5">
              <div className="flex items-center gap-1 text-[10px] text-[#8899A6] uppercase tracking-[0.6px] mb-1">
                <UserRound className="w-3 h-3" /> {t("persona.title")}
              </div>
              <select
                value={charStore.activePersonaId}
                onChange={(e) => charStore.setActivePersona(e.target.value)}
                className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded"
                title={t("persona.activate")}
              >
                <option value="">{t("tavern.noPersona")}</option>
                {charStore.personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {/* RP 会话列表(按角色分组;支持搜索标题/角色名) */}
            <div className="px-2 pt-1.5 pb-0.5">
              <div className="relative">
                <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={convSearch}
                  onChange={(e) => setConvSearch(e.target.value)}
                  placeholder={t("tavern.searchChats")}
                  className="w-full pl-6 pr-2 py-1 text-[11px] bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-1 pb-2">
              {tavern.conversations.length === 0 && (
                <p className="text-[11px] text-muted-foreground px-3 py-3 text-center">
                  {t("tavern.emptyChats")}
                </p>
              )}
              {Object.entries(convsByChar).map(([charId, convs]) => {
                const isGroup = charId === "__group__";
                const card = isGroup ? null : charStore.characters.find((c) => c.id === charId);
                // 会话搜索:按标题或角色名过滤(群聊按成员名)
                const q = convSearch.trim().toLowerCase();
                const visible = q
                  ? convs.filter((c) => {
                      if (c.title.toLowerCase().includes(q)) return true;
                      const names = (c.groupCharIds || [])
                        .map((id) => charStore.characters.find((x) => x.id === id)?.name || "")
                        .join(" ");
                      return names.toLowerCase().includes(q);
                    })
                  : convs;
                if (visible.length === 0) return null;
                return (
                  <div key={charId} className="mb-1">
                    <div className="text-[10px] text-muted-foreground px-2 py-0.5">
                      {isGroup ? t("tavern.groupSection") : card?.name || "?"}
                    </div>
                    {visible.map((c) => (
                      <div
                        key={c.id}
                        onClick={() => tavern.setActive(c.id)}
                        className={`group flex items-center gap-1.5 px-2 py-1.5 rounded text-xs cursor-pointer transition-colors ${tavern.activeId === c.id ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"}`}
                      >
                        <span className="flex-1 truncate">{c.title}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            tavern.removeConv(c.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </aside>

          {/* ── 右区:RP 会话聊天 ── */}
          <main className="flex-1 flex flex-col overflow-hidden">
            {!active ? (
              <div className="flex-1 flex items-center justify-center text-center text-muted-foreground">
                <div>
                  <p className="text-lg mb-2">{t("tavern.welcome")}</p>
                  <p className="text-sm">{t("tavern.hint")}</p>
                </div>
              </div>
            ) : (
              <>
                {/* 会话信息条:角色头像+名 + Persona 下拉 + 状态 */}
                <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/30 shrink-0">
                  {activeCard?.avatarPath && (
                    <img
                      src={convertFileSrc(activeCard.avatarPath)}
                      alt={active.character_name}
                      className="w-6 h-6 rounded-full object-cover"
                    />
                  )}
                  <span className="text-sm font-semibold">{active.character_name}</span>
                  {activeCard?.description && (
                    <span className="text-[10px] text-muted-foreground truncate max-w-[240px]">
                      {activeCard.description}
                    </span>
                  )}
                  <div className="flex-1" />
                  {/* 群聊:当前发言角色 + 自动回应开关 */}
                  {(active.groupCharIds?.length || 0) >= 2 && (
                    <>
                      <select
                        value={active.activeCharId || ""}
                        onChange={(e) => tavern.setGroupActiveChar(active.id, e.target.value)}
                        className="px-1.5 py-0.5 text-[11px] bg-background border border-input rounded max-w-[110px]"
                        title={t("tavern.groupActiveChar")}
                      >
                        {charStore.characters
                          .filter((c) => active.groupCharIds?.includes(c.id))
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                      <label
                        className="flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap"
                        title={t("tavern.groupAutoHint")}
                      >
                        <input
                          type="checkbox"
                          checked={!!active.autoRespond}
                          onChange={(e) => tavern.setAutoRespond(active.id, e.target.checked)}
                          className="accent-[#1A6FB5]"
                        />
                        {t("tavern.groupAuto")}
                      </label>
                      {/* 群聊说话队列:自动模式下显示当前轮到谁 */}
                      {!!active.autoRespond && active.groupCharIds && (
                        <span className="text-[10px] text-primary whitespace-nowrap" title="群聊说话队列:自动模式按角色顺序轮转">
                          队列:{(() => {
                            const idx = active.queueIndex ?? 0;
                            const qc = active.groupCharIds[idx % active.groupCharIds.length];
                            return charStore.characters.find((c) => c.id === qc)?.name || "?";
                          })()}
                        </span>
                      )}
                    </>
                  )}
                  {/* 自动记忆(酒馆 Summarize):历史超阈值自动总结保记忆 */}
                  <label
                    className="flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap"
                    title={t("tavern.autoSummarizeHint")}
                  >
                    <NotebookPen className="w-3 h-3 text-primary" />
                    <input
                      type="checkbox"
                      checked={tavern.autoSummarize}
                      onChange={(e) => tavern.setAutoSummarize(e.target.checked)}
                      className="accent-[#1A6FB5]"
                    />
                    {t("tavern.autoSummarize")}
                  </label>
                  {/* 自动滑卡(Auto-Swipe):回复太短自动换一版 */}
                  <label
                    className="flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap"
                    title="回复过短时自动生成新版本(酒馆 Auto-Swipe)"
                  >
                    <RefreshCw className="w-3 h-3 text-primary" />
                    <input
                      type="checkbox"
                      checked={tavern.autoSwipe}
                      onChange={(e) => tavern.setAutoSwipe(e.target.checked)}
                      className="accent-[#1A6FB5]"
                    />
                    自动滑卡
                  </label>
                  {/* 内置翻译:目标语言 + 自动翻译开关(AI 回复自动出译文) */}
                  <label
                    className="flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap"
                    title={t("tavern.autoTranslateHint")}
                  >
                    <Languages className="w-3 h-3 text-primary" />
                    <select
                      value={tavern.translateTargetLang}
                      onChange={(e) => tavern.setTranslateTargetLang(e.target.value)}
                      className="px-1.5 py-0.5 text-[11px] bg-background border border-input rounded max-w-[100px]"
                      title={t("tavern.targetLang")}
                    >
                      {[
                        "中文",
                        "English",
                        "日本語",
                        "한국어",
                        "Français",
                        "Deutsch",
                        "Русский",
                      ].map((l) => (
                        <option key={l}>{l}</option>
                      ))}
                    </select>
                    <input
                      type="checkbox"
                      checked={tavern.autoTranslate}
                      onChange={(e) => tavern.setAutoTranslate(e.target.checked)}
                      className="accent-[#1A6FB5]"
                    />
                    {t("tavern.autoTranslate")}
                  </label>
                  {/* Persona 切换(会话级,{{user}} 宏跟随) */}
                  <select
                    value={active.persona_id || ""}
                    onChange={(e) => tavern.setPersona(active.id, e.target.value || null)}
                    className="px-1.5 py-0.5 text-[11px] bg-background border border-input rounded max-w-[120px]"
                    title={t("persona.activate")}
                  >
                    <option value="">{t("tavern.noPersona")}</option>
                    {charStore.personas.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {/* 模型选择(会话级,共用工作模式模型配置;不被全局 activeModel 绑死) */}
                  <select
                    value={active.model_name || ""}
                    onChange={(e) => tavern.setModel(active.id, e.target.value || "")}
                    className="px-1.5 py-0.5 text-[11px] bg-background border border-input rounded max-w-[150px]"
                    title={t("tavern.model")}
                  >
                    <option value="">
                      {t("tavern.modelGlobal", { name: model?.name || t("no.model") })}
                    </option>
                    {models.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  {/* 采样器预设(会话级,酒馆 API 响应配置) */}
                  <select
                    value={active.samplerPresetId || ""}
                    onChange={(e) => tavern.setSamplerPreset(active.id, e.target.value || null)}
                    className="px-1.5 py-0.5 text-[11px] bg-background border border-input rounded max-w-[140px]"
                    title={t("tavern.sampler")}
                  >
                    <option value="">{t("tavern.samplerDefault")}</option>
                    {settings.samplerPresets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {/* 会话级世界书(聊天级绑定,多选) */}
                  <button
                    onClick={() => setShowLorePicker(true)}
                    title={t("tavern.lorebooks")}
                    className={`p-1 rounded border flex items-center gap-0.5 text-[11px] ${(active.lorebookIds?.length || 0) > 0 ? "border-primary text-primary bg-primary/10" : "border-input text-muted-foreground hover:text-foreground"}`}
                  >
                    <BookOpen className="w-3 h-3" /> {active.lorebookIds?.length || 0}
                  </button>
                  {/* 上下文查看器(25):生成前看 prompt 拼装预览 */}
                  <button
                    onClick={() => setShowContext(true)}
                    title={t("context.title")}
                    className="p-1 rounded border border-input text-muted-foreground hover:text-foreground"
                  >
                    <Eye className="w-3 h-3" />
                  </button>
                  {/* 记忆图谱(33):人物/地点/话题关系图(B 树形连线,点击跳转消息) */}
                  <button
                    onClick={() => setShowGraph(!showGraph)}
                    title={t("graph.title")}
                    className={`p-1 rounded border flex items-center gap-0.5 text-[11px] ${
                      showGraph
                        ? "border-primary text-primary bg-primary/10"
                        : "border-input text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Share2 className="w-3 h-3" />
                  </button>
                  {/* 双记忆槽 + 钉住 + 软重置:作者注(靠近生成处)/ 钉住(常驻)/ Chat Break */}
                  <button
                    onClick={() => setShowMemPanel(!showMemPanel)}
                    title={t("tavern.memPanel")}
                    className={`p-1 rounded border flex items-center gap-0.5 text-[11px] ${
                      showMemPanel || active.note?.trim() || active.pinned?.trim()
                        ? "border-primary text-primary bg-primary/10"
                        : "border-input text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <NotebookPen className="w-3 h-3" />
                  </button>
                </div>

                {/* 记忆弹层:作者注 / 钉住区 / 变量 / Chat Break 软重置 */}
                {showMemPanel && active && (
                  <div className="px-4 py-2 border-b border-border bg-card/60 shrink-0">
                    <div className="max-w-3xl mx-auto grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-[10px] text-muted-foreground mb-0.5">
                          {t("tavern.authorNote")}
                        </div>
                        <textarea
                          value={active.note || ""}
                          onChange={(e) => void tavern.setNote(active.id, e.target.value)}
                          rows={2}
                          placeholder={t("tavern.authorNoteHint")}
                          className="w-full px-2 py-1 text-[11px] bg-background border border-input rounded resize-none"
                        />
                      </div>
                      <div>
                        <div className="text-[10px] text-muted-foreground mb-0.5">
                          {t("tavern.pinned")}
                        </div>
                        <textarea
                          value={active.pinned || ""}
                          onChange={(e) => void tavern.setPinned(active.id, e.target.value)}
                          rows={2}
                          placeholder={t("tavern.pinnedHint")}
                          className="w-full px-2 py-1 text-[11px] bg-background border border-input rounded resize-none"
                        />
                      </div>
                    </div>
                    {/* 会话消息变量(酒馆 {{var::name}} 宏):每行 key=value,发送时替换 */}
                    <div className="max-w-3xl mx-auto mt-1.5">
                      <div className="text-[10px] text-muted-foreground mb-0.5">
                        {t("tavern.variables")}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(active.variables || {}).map(([k, v]) => (
                          <span
                            key={k}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border text-[10px] text-muted-foreground"
                          >
                            {k}={v}
                            <button
                              onClick={() => void tavern.removeVariable(active.id, k)}
                              className="text-destructive hover:bg-destructive/10 rounded p-px"
                              title="删除变量"
                            >
                              <X className="w-2.5 h-2.5" />
                            </button>
                          </span>
                        ))}
                        <span className="flex items-center gap-1">
                          <input
                            value={varKey}
                            onChange={(e) => setVarKey(e.target.value)}
                            placeholder="name"
                            className="w-16 px-1 py-0.5 text-[10px] bg-background border border-input rounded"
                          />
                          <input
                            value={varVal}
                            onChange={(e) => setVarVal(e.target.value)}
                            placeholder="value"
                            className="w-32 px-1 py-0.5 text-[10px] bg-background border border-input rounded"
                          />
                          <button
                            onClick={() => {
                              if (!varKey.trim()) return;
                              void tavern.setVariable(active.id, varKey, varVal);
                              setVarKey("");
                              setVarVal("");
                            }}
                            className="px-1.5 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 text-[10px]"
                          >
                            +
                          </button>
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          prompt 中使用 {`{{var::name}}`} 引用
                        </span>
                      </div>
                    </div>
                    {/* 数据银行/聊天附件(酒馆 Data Bank):会话级附件,发送时注入 */}
                    <div className="max-w-3xl mx-auto mt-1.5">
                      <div className="text-[10px] text-muted-foreground mb-0.5">
                        {t("tavern.attachments")}
                      </div>
                      <div className="flex flex-wrap gap-1.5 items-center">
                        {(active.attachments || []).map((a) => (
                          <span
                            key={a.id}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border text-[10px] text-muted-foreground max-w-[240px]"
                            title={a.content}
                          >
                            <span className="truncate">📎 {a.name}</span>
                            <button
                              onClick={() => void tavern.removeAttachment(active.id, a.id)}
                              className="text-destructive hover:bg-destructive/10 rounded p-px"
                              title="删除附件"
                            >
                              <X className="w-2.5 h-2.5" />
                            </button>
                          </span>
                        ))}
                        <span className="flex items-center gap-1">
                          <input
                            value={attName}
                            onChange={(e) => setAttName(e.target.value)}
                            placeholder="名称"
                            className="w-16 px-1 py-0.5 text-[10px] bg-background border border-input rounded"
                          />
                          <input
                            value={attContent}
                            onChange={(e) => setAttContent(e.target.value)}
                            placeholder="附件内容(注入上下文)"
                            className="w-44 px-1 py-0.5 text-[10px] bg-background border border-input rounded"
                          />
                          <button
                            onClick={() => {
                              if (!attName.trim()) return;
                              void tavern.addAttachment(active.id, attName, attContent);
                              setAttName("");
                              setAttContent("");
                            }}
                            className="px-1.5 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 text-[10px]"
                          >
                            +
                          </button>
                        </span>
                      </div>
                    </div>
                    <div className="max-w-3xl mx-auto flex items-center gap-2 mt-1.5">
                      <button
                        onClick={() => void tavern.softReset(active.id)}
                        className="px-2 py-1 text-[10px] rounded border border-destructive/40 text-destructive hover:bg-destructive/10"
                        title={t("tavern.softResetHint")}
                      >
                        {t("tavern.softReset")}
                      </button>
                      <span className="text-[9px] text-muted-foreground">
                        {t("tavern.softResetHint")}
                      </span>
                    </div>
                  </div>
                )}

                {/* 消息区 */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto">
                  <div className="max-w-3xl mx-auto px-4 py-3 space-y-3">
                    {active.messages.map((m, mi) => {
                      // 群聊:按消息角色名解析头像/显示名;单角色:会话级
                      const isGroup = (active.groupCharIds?.length || 0) >= 2;
                      const charCard = isGroup
                        ? charStore.characters.find((c) => c.name === m.model)
                        : activeCard;
                      const charName = isGroup
                        ? charCard?.name || m.model || active.character_name
                        : active.character_name;
                      // 重新生成(酒馆语义):仅最后一条 assistant 支持重放——此前硬编码
                      // 工作模式 useChatStore.regenerate 导致酒馆点它静默失效
                      const isLastAssistant =
                        m.role === "assistant" &&
                        active.messages.slice(mi + 1).every((x) => x.role !== "assistant");
                      // 表情图片:assistant 完成回复按情绪关键词命中切换(未命中回退角色头像);
                      // 表情图文件不存在(未上传)时同样回退角色头像,避免破图
                      let charAvatar = avatarOf(charCard?.avatarPath);
                      if (
                        m.role === "assistant" &&
                        charCard &&
                        !m.content.includes("▍") &&
                        !brokenEmo.has(m.id)
                      ) {
                        const emo = detectEmotion(m.content, charCard);
                        const emoPath = emo ? emotionImagePath(charCard, emo) : null;
                        if (emoPath) charAvatar = avatarOf(emoPath);
                      }
                      return (
                        <div
                          key={m.id}
                          ref={(el) => {
                            msgRefs.current[m.id] = el;
                          }}
                          className="transition-colors rounded"
                        >
                          <MessageBubble
                            message={m}
                            rpCharName={charName}
                            rpCharAvatar={charAvatar}
                            rpUserName={activePersona?.name}
                            rpUserAvatar={avatarOf(activePersona?.avatarPath)}
                            onTranslate={(msg) => tavern.translateMessage(active.id, msg.id)}
                            translating={tavern.translatingIds.includes(m.id)}
                            onSwipe={(msg, dir) => tavern.swipe(msg.id, dir)}
                            onRetry={
                              isLastAssistant
                                ? (msg) => void tavern.swipeGenerate(msg.id)
                                : undefined
                            }
                            onContinue={
                              isLastAssistant ? (msg) => void tavern.continueMessage(msg.id) : undefined
                            }
                            onEdit={editMessage}
                          />
                        </div>
                      );
                    })}
                    {tavern.isStreaming && (
                      <div className="flex items-center gap-1 text-muted-foreground text-sm px-1">
                        <span className="animate-pulse-dot w-1.5 h-1.5 bg-primary rounded-full" />
                        <span
                          className="animate-pulse-dot w-1.5 h-1.5 bg-primary rounded-full"
                          style={{ animationDelay: "0.2s" }}
                        />
                        <span
                          className="animate-pulse-dot w-1.5 h-1.5 bg-primary rounded-full"
                          style={{ animationDelay: "0.4s" }}
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* 输入区 */}
                <div className="border-t border-border p-3 shrink-0">
                  {/* Quick Reply 快捷按钮(30+32):掷骰/继续/加注 + 自定义 */}
                  <QuickReplyBar
                    input={input}
                    vars={{ char: active.character_name, user: activePersona?.name || "User" }}
                    disabled={tavern.isStreaming}
                    onSend={(text) => {
                      setInput(text);
                      void tavern.sendMessage(text);
                    }}
                  />
                  <div className="max-w-3xl mx-auto flex gap-2 items-end">
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleSend();
                        }
                      }}
                      rows={1}
                      placeholder={`${t("tavern.inputPlaceholder")} (Enter 发送)`}
                      className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring max-h-32"
                      style={{ height: "auto", minHeight: "38px" }}
                    />
                    {tavern.isStreaming ? (
                      <button
                        onClick={() => tavern.cancelGeneration()}
                        className="p-2 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 shrink-0"
                        title={t("chat.stop")}
                      >
                        <Square className="w-4 h-4" />
                      </button>
                    ) : (
                      <>
                        {/* 冒充回复(酒馆 Impersonate):以角色身份手动写一条,不走 AI */}
                        <button
                          onClick={() => {
                            const c = input.trim();
                            if (!c) return;
                            setInput("");
                            void tavern.impersonate(c);
                          }}
                          disabled={!input.trim()}
                          className="p-2 rounded-md border border-input text-muted-foreground hover:text-foreground hover:bg-muted shrink-0 disabled:opacity-40"
                          title={t("chat.impersonate")}
                        >
                          <UserRound className="w-4 h-4" />
                        </button>
                        <button
                          onClick={handleSend}
                          disabled={!input.trim() || !tavern.resolveModel(active)}
                          className="p-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 shrink-0 disabled:opacity-50"
                          title={t("chat.send")}
                        >
                          <Send className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </>
            )}
          </main>

          {/* 群聊角色选择弹层 */}
          {showGroupPicker && (
            <div
              className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center"
              onClick={() => setShowGroupPicker(false)}
            >
              <div
                className="w-[380px] max-w-[90vw] bg-card border border-border rounded-lg shadow-xl p-4"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1.5 mb-3">
                  <UsersRound className="w-4 h-4 text-primary" />
                  <span className="text-sm font-semibold">{t("tavern.groupNew")}</span>
                  <span className="text-[10px] text-muted-foreground">{t("tavern.groupHint")}</span>
                </div>
                <div className="space-y-1 max-h-[40vh] overflow-y-auto">
                  {cards.map((c) => {
                    const on = groupSel.includes(c.id);
                    return (
                      <label
                        key={c.id}
                        className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted cursor-pointer text-xs select-none"
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setGroupSel((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id]))
                          }
                          className="accent-[#1A6FB5]"
                        />
                        <span
                          className={`w-5 h-5 rounded-full overflow-hidden bg-muted shrink-0 flex items-center justify-center`}
                        >
                          {c.avatarPath ? (
                            <img
                              src={convertFileSrc(c.avatarPath)}
                              alt={c.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <Users className="w-2.5 h-2.5 text-muted-foreground" />
                          )}
                        </span>
                        <span className={on ? "text-primary font-medium" : "text-muted-foreground"}>
                          {c.name}
                        </span>
                      </label>
                    );
                  })}
                  {cards.length === 0 && (
                    <p className="text-xs text-muted-foreground py-3 text-center">
                      {t("tavern.noChars")}
                    </p>
                  )}
                </div>
                <div className="flex justify-end mt-3">
                  <button
                    onClick={() => {
                      if (groupSel.length >= 2) {
                        void tavern.createGroupChat(groupSel).then(() => setShowGroupPicker(false));
                      }
                    }}
                    className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                    disabled={groupSel.length < 2}
                    title={groupSel.length < 2 ? t("tavern.groupNeed2") : ""}
                  >
                    {t("tavern.groupCreate")}（{groupSel.length}）
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 会话级世界书选择弹层(聊天级绑定,酒馆 Chat Lore) */}
          {showLorePicker && active && (
            <div
              className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center"
              onClick={() => setShowLorePicker(false)}
            >
              <div
                className="w-[380px] max-w-[90vw] bg-card border border-border rounded-lg shadow-xl p-4"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1.5 mb-3">
                  <BookOpen className="w-4 h-4 text-primary" />
                  <span className="text-sm font-semibold">{t("tavern.lorebooks")}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {t("tavern.lorebooksHint")}
                  </span>
                </div>
                {Object.keys(charStore.lorebooks).length === 0 ? (
                  <p className="text-xs text-muted-foreground py-3 text-center">
                    {t("lore.noBooks")}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {Object.entries(charStore.lorebooks).map(([id, b]) => {
                      const on = active.lorebookIds?.includes(id) ?? false;
                      return (
                        <label
                          key={id}
                          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted cursor-pointer text-xs select-none"
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => {
                              const cur = active.lorebookIds || [];
                              const next = on ? cur.filter((x) => x !== id) : [...cur, id];
                              tavern.setLorebooks(active.id, next);
                            }}
                            className="accent-[#1A6FB5]"
                          />
                          <span
                            className={on ? "text-primary font-medium" : "text-muted-foreground"}
                          >
                            {b.name || id}
                          </span>
                          <span className="text-[10px] text-muted-foreground ml-auto">
                            {b.entries.length} 条
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="flex justify-end mt-3">
                  <button
                    onClick={() => setShowLorePicker(false)}
                    className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {t("settings.save")}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 上下文查看器(25):生成前看 prompt 拼装预览(三段式各段/token 占比)
              对齐真实发送:currentInput 传当前输入,世界书合并全部来源
              (全局启用 + Persona 绑定 + 会话绑定 + 角色卡绑定) */}
          {showContext && active && activeCard && (
            <ContextViewer
              card={activeCard}
              persona={
                charStore.personas.find((p) => p.id === active.persona_id) ||
                charStore.getActivePersona() ||
                null
              }
              preset={charStore.getPreset(activeCard.presetId || "preset-classic-char") || null}
              lorebooks={
                [
                  charStore.globalLorebook,
                  activeCard.character_book,
                  ...[
                    ...charStore.enabledLorebookIds,
                    ...(charStore.personas.find((p) => p.id === active.persona_id)?.lorebookIds ||
                      charStore.getActivePersona()?.lorebookIds ||
                      []),
                    ...(active.lorebookIds || []),
                    ...(activeCard.lorebookIds || []),
                  ].map((id) => charStore.lorebooks[id]),
                ].filter((b) => !!b) as NonNullable<typeof activeCard.character_book>[]
              }
              recentMessages={active.messages}
              currentInput={input}
              summary={active.summary}
              onClose={() => setShowContext(false)}
            />
          )}

          {/* 记忆图谱(33):从消息+世界书提取关系图,树形连线,点击节点跳转消息 */}
          {showGraph && active && (
            <div className="px-4 py-2 border-b border-border bg-card/60 shrink-0">
              <div className="max-w-3xl mx-auto">
                <MemoryGraphPanel
                  graph={extractGraph(
                    active.messages.map((m) => ({ id: m.id, role: m.role, content: m.content })),
                    activeCard?.character_book?.entries.map((e) => e.content).join("\n") || "",
                    30
                  )}
                  onJump={jumpToMessage}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
