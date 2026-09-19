import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Search,
  Trash2,
  Send,
  Square,
  Settings2,
  FlaskConical,
  Clock,
  RefreshCw,
  Dices,
  BookOpen,
  ScrollText,
  X,
  Save,
  Anchor,
} from "lucide-react";
import { useSimulationStore, type CreateSimOptions } from "@/stores/useSimulationStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useT } from "@/lib/i18n";
import { rollDice } from "@/lib/sim-prompt";
import { askConfirm } from "@/components/ui/ConfirmDialog";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { QuickReplyBar } from "@/components/chat/QuickReplyBar";
import { MessageBubble } from "@/components/chat/MessageBubble";
import type {
  SimPacing,
  SimStateMode,
  SimStateUpdate,
  SimType,
  SimulationConversation,
} from "@/types";

interface Props {
  onOpenSettings: () => void;
}

/** 类型预设卡:推荐状态/节奏/更新策略 + 说明文案 key */
const TYPE_PRESETS: {
  type: SimType;
  stateMode: SimStateMode;
  pacing: SimPacing;
  stateUpdate: SimStateUpdate;
}[] = [
  { type: "story", stateMode: "text", pacing: "turn", stateUpdate: "every" },
  { type: "sandbox", stateMode: "text", pacing: "time", stateUpdate: "lazy" },
  { type: "tactical", stateMode: "table", pacing: "turn", stateUpdate: "every" },
];

const DICE_OPTIONS = ["D100", "D20", "D12", "D10", "D8", "D6", "D4"];

/**
 * 酒馆推演子模式:故事推演(与角色扮演同属创作空间,会话完全隔离)。
 * 左栏 = 推演会话列表(按类型分组);右区 = 推演控制台 + 状态/时间线面板 + 聊天。
 */
export function SimulationView({ onOpenSettings }: Props) {
  const t = useT();
  const sim = useSimulationStore();
  const models = useSettingsStore((s) => s.models);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const settings = useSettingsStore();
  const [search, setSearch] = useState("");
  const [input, setInput] = useState("");
  const [showNew, setShowNew] = useState(false);
  // 状态/时间线面板折叠
  const [showState, setShowState] = useState(true);
  const [showTimeline, setShowTimeline] = useState(true);
  // 控制条
  const [rounds, setRounds] = useState(3);
  const [timeDur, setTimeDur] = useState("");
  const [diceSel, setDiceSel] = useState("D100");
  const [diceTh, setDiceTh] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void sim.load();
  }, [sim]);

  const active = sim.getActive();
  const model = models.find((m) => m.name === activeModel);

  // 自动滚动
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [active?.messages.length, sim.isStreaming]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? sim.conversations.filter(
          (c) => c.title.toLowerCase().includes(q) || c.setup.toLowerCase().includes(q)
        )
      : sim.conversations;
  }, [sim.conversations, search]);

  const byType = useMemo(() => {
    const map: Record<SimType, typeof filtered> = { story: [], sandbox: [], tactical: [] };
    for (const c of filtered) map[c.type].push(c);
    return map;
  }, [filtered]);

  const handleSend = () => {
    const content = input.trim();
    if (!content || sim.isStreaming) return;
    setInput("");
    void sim.sendMessage(content);
  };

  const syncNow = () => {
    if (active && !sim.isSyncing) void sim.updateStateAndTimeline(active.id);
  };

  const doRoll = () => {
    const th = diceTh.trim() ? Number(diceTh.trim()) : null;
    // 骰子数据化(37):结构化结果拼入输入,tactical 指令让模型读结构化骰子(可展开判定明细)
    const r = rollDice(diceSel, Number.isFinite(th) ? th : null);
    const line = r.threshold != null ? r.text : r.text;
    setInput((p) => (p ? `${p}\n${line}` : line));
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ── 左栏:推演会话列表 ── */}
      <aside className="w-60 bg-card border-r border-border flex flex-col shrink-0">
        <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
          <FlaskConical className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">{t("sim.title")}</span>
          <div className="flex-1" />
          <button
            onClick={onOpenSettings}
            title={t("sim.manage")}
            className="p-1 rounded hover:bg-muted text-muted-foreground"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 新建推演 */}
        <div className="px-2 pb-1.5">
          <button
            onClick={() => setShowNew(true)}
            className="w-full px-2 py-1.5 text-[11px] rounded bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 justify-center"
          >
            <Plus className="w-3.5 h-3.5" /> {t("sim.new")}
          </button>
        </div>

        {/* 会话搜索 */}
        <div className="px-2 pb-1.5">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("sim.search")}
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        {/* 会话列表(按类型分组) */}
        <div className="flex-1 overflow-y-auto px-1 pb-2">
          {sim.conversations.length === 0 && (
            <p className="text-[11px] text-muted-foreground px-3 py-4 text-center">
              {t("sim.emptyChats")}
            </p>
          )}
          {(["story", "sandbox", "tactical"] as SimType[]).map((type) => {
            const convs = byType[type];
            if (convs.length === 0) return null;
            return (
              <div key={type} className="mb-1">
                <div className="text-[10px] text-muted-foreground px-2 py-0.5 flex items-center gap-1">
                  <span
                    className={`px-1 py-px rounded text-[9px] ${
                      type === "story"
                        ? "bg-primary/10 text-primary"
                        : type === "sandbox"
                          ? "bg-emerald-500/10 text-emerald-500"
                          : "bg-amber-500/10 text-amber-500"
                    }`}
                  >
                    {t(`sim.type.${type}`)}
                  </span>
                </div>
                {convs.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => sim.setActive(c.id)}
                    className={`group flex items-center gap-1.5 px-2 py-1.5 rounded text-xs cursor-pointer transition-colors ${sim.activeId === c.id ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted"}`}
                    title={c.setup || c.title}
                  >
                    <span className="flex-1 truncate">{c.title}</span>
                    {c.timeLabel && (
                      <span className="text-[9px] text-muted-foreground shrink-0">
                        {c.timeLabel}
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void (async () => {
                          if (await askConfirm(t("sim.deleteConfirm"))) sim.removeConv(c.id);
                        })();
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

      {/* ── 右区:推演控制台 + 聊天 ── */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {!active ? (
          <div className="flex-1 flex items-center justify-center text-center text-muted-foreground">
            <div>
              <p className="text-lg mb-2">{t("sim.welcome")}</p>
              <p className="text-sm">{t("sim.hint")}</p>
            </div>
          </div>
        ) : (
          <>
            {/* 顶栏信息条:类型徽标 + 时间 + 同步 + 模型 + 采样器 + 自动记忆 + 面板开关 */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/30 shrink-0">
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  active.type === "story"
                    ? "bg-primary/10 text-primary"
                    : active.type === "sandbox"
                      ? "bg-emerald-500/10 text-emerald-500"
                      : "bg-amber-500/10 text-amber-500"
                }`}
              >
                {t(`sim.type.${active.type}`)}
              </span>
              {active.timeLabel && (
                <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                  <Clock className="w-3 h-3" /> {active.timeLabel}
                </span>
              )}
              <div className="flex-1" />
              {/* 手动同步状态(every 自动刷;lazy/inline 提供手动入口) */}
              {active.stateUpdate !== "every" && (
                <button
                  onClick={syncNow}
                  disabled={sim.isSyncing}
                  className="p-1 rounded border border-input text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px] disabled:opacity-50"
                  title={t("sim.syncHint")}
                >
                  <RefreshCw className={`w-3 h-3 ${sim.isSyncing ? "animate-spin" : ""}`} />
                  {t("sim.sync")}
                </button>
              )}
              {/* 状态/时间线面板开关 */}
              <button
                onClick={() => setShowState(!showState)}
                className={`p-1 rounded border flex items-center gap-0.5 text-[11px] ${showState ? "border-primary text-primary bg-primary/10" : "border-input text-muted-foreground hover:text-foreground"}`}
                title={t("sim.statePanel")}
              >
                <BookOpen className="w-3 h-3" />
              </button>
              <button
                onClick={() => setShowTimeline(!showTimeline)}
                className={`p-1 rounded border flex items-center gap-0.5 text-[11px] ${showTimeline ? "border-primary text-primary bg-primary/10" : "border-input text-muted-foreground hover:text-foreground"}`}
                title={t("sim.timelinePanel")}
              >
                <ScrollText className="w-3 h-3" />
              </button>
              {/* 观察/干预双通道(43):旁观模式——AI 自主推进,玩家只观察 */}
              <label
                className="flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap"
                title={t("sim.observerHint")}
              >
                <input
                  type="checkbox"
                  checked={!!active.observerMode}
                  onChange={(e) => void sim.setObserverMode(active.id, e.target.checked)}
                  className="accent-[#1A6FB5]"
                />
                {t("sim.observer")}
              </label>
              {/* 漂移回锚(39):产出既定事实锚点(防 AI 漂移) */}
              <button
                onClick={() => void sim.anchorNow(active.id)}
                disabled={sim.isSyncing}
                className="p-1 rounded border border-input text-muted-foreground hover:text-foreground flex items-center gap-0.5 text-[11px] disabled:opacity-50"
                title={t("sim.anchorHint")}
              >
                <Anchor className="w-3 h-3" />
              </button>
              {/* 自动记忆(复用酒馆 Summarize 机制) */}
              <label
                className="flex items-center gap-1 text-[10px] text-muted-foreground whitespace-nowrap"
                title={t("tavern.autoSummarizeHint")}
              >
                <input
                  type="checkbox"
                  checked={sim.autoSummarize}
                  onChange={(e) => sim.setAutoSummarize(e.target.checked)}
                  className="accent-[#1A6FB5]"
                />
                {t("sim.autoSummarize")}
              </label>
              {/* 模型选择(会话级) */}
              <select
                value={active.model_name || ""}
                onChange={(e) => sim.patch(active.id, { model_name: e.target.value || undefined })}
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
              {/* 采样器预设(会话级) */}
              <select
                value={active.samplerPresetId || ""}
                onChange={(e) =>
                  sim.patch(active.id, { samplerPresetId: e.target.value || undefined })
                }
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
            </div>

            {/* 状态/时间线面板(key=会话 id:切会话重挂载,草稿跟随) */}
            {(showState || showTimeline) && (
              <StatePanels
                key={active.id}
                conv={active}
                showState={showState}
                showTimeline={showTimeline}
              />
            )}

            {/* 消息区 */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto">
              <div className="max-w-3xl mx-auto px-4 py-3 space-y-3">
                {active.messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    rpCharName={m.role === "assistant" ? t("sim.aiName") : undefined}
                    rpCharAvatar={null}
                  />
                ))}
                {sim.isStreaming && (
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

            {/* 推演控制条 */}
            <div className="border-t border-border px-4 pt-2 pb-0.5 shrink-0">
              <div className="max-w-3xl mx-auto flex flex-wrap items-center gap-1.5 text-[11px]">
                {/* 继续推演 N 轮 */}
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => void sim.continueRounds(rounds)}
                    disabled={sim.isStreaming}
                    className="px-2 py-1 rounded border border-primary/40 text-primary hover:bg-primary/5 disabled:opacity-40 flex items-center gap-1"
                    title={t("sim.continueHint")}
                  >
                    <RefreshCw className="w-3 h-3" /> {t("sim.continue")}
                  </button>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={rounds}
                    onChange={(e) => setRounds(Math.max(1, +e.target.value || 1))}
                    className="w-12 px-1 py-1 text-[11px] bg-background border border-input rounded"
                  />
                  <span className="text-muted-foreground">{t("sim.rounds")}</span>
                </div>
                {/* 时间步进 */}
                <div className="flex items-center gap-1">
                  <input
                    value={timeDur}
                    onChange={(e) => setTimeDur(e.target.value)}
                    placeholder={t("sim.timeStepPlaceholder")}
                    className="w-28 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void sim.timeStep(timeDur);
                        setTimeDur("");
                      }
                    }}
                  />
                  <button
                    onClick={() => {
                      void sim.timeStep(timeDur);
                      setTimeDur("");
                    }}
                    disabled={sim.isStreaming || !timeDur.trim()}
                    className="px-2 py-1 rounded border border-input text-muted-foreground hover:text-foreground disabled:opacity-40 flex items-center gap-1"
                  >
                    <Clock className="w-3 h-3" /> {t("sim.timeStepGo")}
                  </button>
                </div>
                {/* 掷骰(tactical 型) */}
                {active.type === "tactical" && (
                  <div className="flex items-center gap-1">
                    <select
                      value={diceSel}
                      onChange={(e) => setDiceSel(e.target.value)}
                      className="px-1 py-1 text-[11px] bg-background border border-input rounded"
                    >
                      {DICE_OPTIONS.map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                    <input
                      value={diceTh}
                      onChange={(e) => setDiceTh(e.target.value)}
                      placeholder={t("sim.diceThreshold")}
                      className="w-16 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
                    />
                    <button
                      onClick={doRoll}
                      className="px-2 py-1 rounded border border-amber-500/40 text-amber-500 hover:bg-amber-500/5 flex items-center gap-1"
                      title={t("sim.diceHint")}
                    >
                      <Dices className="w-3 h-3" /> {t("sim.dice")}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* 输入区 */}
            <div className="border-t border-border p-3 shrink-0">
              {/* Quick Reply 快捷按钮(30+32):掷骰/继续/加注 + 自定义 */}
              <QuickReplyBar
                input={input}
                vars={{ char: t(`sim.type.${active.type}`), user: "玩家" }}
                disabled={sim.isStreaming}
                onSend={(text) => {
                  setInput(text);
                  void sim.sendMessage(text);
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
                  placeholder={`${t("sim.inputPlaceholder")} (Enter 发送)`}
                  className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring max-h-32"
                  style={{ height: "auto", minHeight: "38px" }}
                />
                {sim.isStreaming ? (
                  <button
                    onClick={() => sim.cancelGeneration()}
                    className="p-2 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 shrink-0"
                    title={t("chat.stop")}
                  >
                    <Square className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!input.trim() || !model}
                    className="p-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 shrink-0 disabled:opacity-50"
                    title={t("chat.send")}
                  >
                    <Send className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {/* 新建推演弹层:三张类型预设卡 + 高级选项 */}
      {showNew && <NewSimulationModal onClose={() => setShowNew(false)} />}
    </div>
  );
}

/** 新建推演弹层:类型预设卡 + 高级选项(形态/状态/节奏/更新策略) */
function NewSimulationModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const sim = useSimulationStore();
  // Escape 关闭(此前只有遮罩点击 + 底部取消)
  useEscapeClose(onClose);
  const [draft, setDraft] = useState<CreateSimOptions>({
    type: "story",
    stateMode: "text",
    pacing: "turn",
    stateUpdate: "every",
    autoRounds: 3,
    setup: "",
  });
  const [advanced, setAdvanced] = useState(false);
  const [setupDraft, setSetupDraft] = useState("");

  const pickType = (p: (typeof TYPE_PRESETS)[number]) => {
    // 点卡片重置高级选项为该卡推荐
    setDraft((d) => ({
      ...d,
      type: p.type,
      stateMode: p.stateMode,
      pacing: p.pacing,
      stateUpdate: p.stateUpdate,
    }));
  };

  const create = async () => {
    await sim.create({ ...draft, setup: setupDraft.trim() });
    onClose();
  };

  const typeCard = (p: (typeof TYPE_PRESETS)[number]) => {
    const on = draft.type === p.type;
    return (
      <button
        key={p.type}
        onClick={() => pickType(p)}
        className={`text-left p-3 rounded-lg border transition-colors ${
          on ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
        }`}
      >
        <div className="flex items-center gap-1.5 mb-1">
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
              p.type === "story"
                ? "bg-primary/10 text-primary"
                : p.type === "sandbox"
                  ? "bg-emerald-500/10 text-emerald-500"
                  : "bg-amber-500/10 text-amber-500"
            }`}
          >
            {t(`sim.type.${p.type}`)}
          </span>
          {on && <span className="text-[10px] text-primary font-medium">✓</span>}
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {t(`sim.typeDesc.${p.type}`)}
        </p>
      </button>
    );
  };

  const sel = (
    label: string,
    value: string,
    options: { v: string; label: string }[],
    onChange: (v: string) => void
  ) => (
    <label className="flex items-center gap-2 text-[11px]">
      <span className="text-muted-foreground w-20 shrink-0">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[92vw] bg-card border border-border rounded-lg shadow-xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 mb-3">
          <FlaskConical className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">{t("sim.new")}</span>
          <span className="text-[10px] text-muted-foreground">{t("sim.newHint")}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1 rounded hover:bg-muted text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 类型预设卡 */}
        <div className="grid grid-cols-3 gap-2 mb-3">{TYPE_PRESETS.map(typeCard)}</div>

        {/* 世界观设定 */}
        <div className="mb-2">
          <label className="text-[10px] text-muted-foreground block mb-0.5">
            {t("sim.setupLabel")}
          </label>
          <textarea
            value={setupDraft}
            onChange={(e) => setSetupDraft(e.target.value)}
            rows={3}
            placeholder={t("sim.setupPlaceholder")}
            className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
          />
        </div>

        {/* 高级选项 */}
        <button
          onClick={() => setAdvanced(!advanced)}
          className="text-[11px] text-primary hover:underline flex items-center gap-1"
        >
          {advanced ? "▾" : "▸"} {t("sim.advanced")}
        </button>
        {advanced && (
          <div className="mt-2 space-y-1.5 p-2 rounded border border-border bg-muted/30">
            {sel(
              t("sim.stateModeLabel"),
              draft.stateMode,
              [
                { v: "text", label: t("sim.stateMode.text") },
                { v: "table", label: t("sim.stateMode.table") },
                { v: "none", label: t("sim.stateMode.none") },
              ],
              (v) => setDraft((d) => ({ ...d, stateMode: v as SimStateMode }))
            )}
            {sel(
              t("sim.pacingLabel"),
              draft.pacing,
              [
                { v: "turn", label: t("sim.pacing.turn") },
                { v: "time", label: t("sim.pacing.time") },
                { v: "auto", label: t("sim.pacing.auto") },
              ],
              (v) => setDraft((d) => ({ ...d, pacing: v as SimPacing }))
            )}
            {sel(
              t("sim.stateUpdateLabel"),
              draft.stateUpdate,
              [
                { v: "every", label: t("sim.stateUpdate.every") },
                { v: "lazy", label: t("sim.stateUpdate.lazy") },
                { v: "inline", label: t("sim.stateUpdate.inline") },
              ],
              (v) => setDraft((d) => ({ ...d, stateUpdate: v as SimStateUpdate }))
            )}
            <label className="flex items-center gap-2 text-[11px]">
              <span className="text-muted-foreground w-20 shrink-0">{t("sim.autoRounds")}</span>
              <input
                type="number"
                min={1}
                max={10}
                value={draft.autoRounds}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, autoRounds: Math.max(1, +e.target.value || 1) }))
                }
                className="w-16 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
              />
            </label>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-3">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-input text-muted-foreground hover:text-foreground"
          >
            {t("settings.cancel")}
          </button>
          <button
            onClick={create}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {t("sim.create")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 世界状态 + 事件时间线面板(key=会话 id 重挂载,草稿跟随激活会话) */
function StatePanels({
  conv,
  showState,
  showTimeline,
}: {
  conv: SimulationConversation;
  showState: boolean;
  showTimeline: boolean;
}) {
  const t = useT();
  const sim = useSimulationStore();
  // 草稿本地态:挂载时从会话初始化(编辑后点保存才落盘)
  const [wsDraft, setWsDraft] = useState(conv.worldState);
  const [tableDraft, setTableDraft] = useState<[string, string][]>(Object.entries(conv.stateTable));
  // 时间线手动新增
  const [tlTime, setTlTime] = useState("");
  const [tlEvent, setTlEvent] = useState("");

  const saveWorldState = async () => {
    await sim.patch(conv.id, { worldState: wsDraft.trim() });
  };

  const saveTable = async () => {
    const table: Record<string, string> = {};
    for (const [k, v] of tableDraft) {
      if (k.trim() && v.trim()) table[k.trim()] = v.trim();
    }
    await sim.patch(conv.id, { stateTable: table });
  };

  const addTimeline = () => {
    void sim.addTimelineEntry(conv.id, tlTime, tlEvent);
    setTlTime("");
    setTlEvent("");
  };

  return (
    <div className="border-b border-border bg-card/60 px-4 py-2 shrink-0 max-h-[40%] overflow-y-auto">
      <div className="max-w-3xl mx-auto grid grid-cols-2 gap-3">
        {/* 世界状态 */}
        {showState && (
          <div>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
              <BookOpen className="w-3 h-3 text-primary" />
              {t("sim.statePanel")}
              <span className="text-[9px] opacity-70">{t(`sim.stateMode.${conv.stateMode}`)}</span>
            </div>
            {conv.stateMode === "text" && (
              <>
                <textarea
                  value={wsDraft}
                  onChange={(e) => setWsDraft(e.target.value)}
                  rows={4}
                  placeholder={t("sim.worldStatePlaceholder")}
                  className="w-full px-2 py-1.5 text-[11px] bg-background border border-input rounded resize-none"
                />
                <button
                  onClick={saveWorldState}
                  className="mt-1 px-2 py-1 text-[10px] rounded bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-1"
                >
                  <Save className="w-3 h-3" /> {t("sim.saveState")}
                </button>
              </>
            )}
            {conv.stateMode === "table" && (
              <>
                <div className="space-y-1">
                  {tableDraft.map(([k, v], i) => (
                    <div key={i} className="flex gap-1">
                      <input
                        value={k}
                        onChange={(e) =>
                          setTableDraft((p) =>
                            p.map((r, j) => (j === i ? [e.target.value, r[1]] : r))
                          )
                        }
                        placeholder={t("sim.tableKey")}
                        className="w-1/3 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
                      />
                      <input
                        value={v}
                        onChange={(e) =>
                          setTableDraft((p) =>
                            p.map((r, j) => (j === i ? [r[0], e.target.value] : r))
                          )
                        }
                        placeholder={t("sim.tableValue")}
                        className="flex-1 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
                      />
                      <button
                        onClick={() => setTableDraft((p) => p.filter((_, j) => j !== i))}
                        className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-1 mt-1">
                  <button
                    onClick={() => setTableDraft((p) => [...p, ["", ""]])}
                    className="px-2 py-1 text-[10px] rounded border border-dashed border-primary/40 text-primary hover:bg-primary/5"
                  >
                    + {t("sim.tableAdd")}
                  </button>
                  <button
                    onClick={saveTable}
                    className="px-2 py-1 text-[10px] rounded bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-1"
                  >
                    <Save className="w-3 h-3" /> {t("sim.saveState")}
                  </button>
                </div>
              </>
            )}
            {conv.stateMode === "none" && (
              <p className="text-[11px] text-muted-foreground">{t("sim.stateNone")}</p>
            )}
          </div>
        )}

        {/* 事件时间线 */}
        {showTimeline && (
          <div>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
              <ScrollText className="w-3 h-3 text-primary" />
              {t("sim.timelinePanel")}
            </div>
            <div className="space-y-1 max-h-36 overflow-y-auto">
              {conv.timeline.length === 0 && (
                <p className="text-[11px] text-muted-foreground">{t("sim.timelineEmpty")}</p>
              )}
              {[...conv.timeline].reverse().map((e, ri) => {
                const idx = conv.timeline.length - 1 - ri;
                return (
                  <div key={idx} className="flex items-start gap-1.5 text-[11px] group">
                    {/* 时间线分层(38):milestone 高亮/ log 弱化 / event 常规 */}
                    <span
                      className={`shrink-0 font-mono ${
                        e.kind === "milestone"
                          ? "text-amber-500"
                          : e.kind === "log"
                            ? "text-muted-foreground/50"
                            : "text-muted-foreground"
                      }`}
                    >
                      {e.kind === "milestone" ? "★" : e.kind === "log" ? "·" : ""}
                      {e.time || "—"}
                    </span>
                    <span
                      className={`flex-1 ${
                        e.kind === "log" ? "text-muted-foreground/60" : "text-foreground/90"
                      }`}
                    >
                      {e.event}
                    </span>
                    <button
                      onClick={() => sim.removeTimelineEntry(conv.id, idx)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-1 mt-1">
              <input
                value={tlTime}
                onChange={(e) => setTlTime(e.target.value)}
                placeholder={t("sim.timelineTime")}
                className="w-1/4 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
              />
              <input
                value={tlEvent}
                onChange={(e) => setTlEvent(e.target.value)}
                placeholder={t("sim.timelineEvent")}
                className="flex-1 px-1.5 py-1 text-[11px] bg-background border border-input rounded"
                onKeyDown={(e) => {
                  if (e.key === "Enter") addTimeline();
                }}
              />
              <button
                onClick={addTimeline}
                className="px-2 py-1 text-[10px] rounded border border-dashed border-primary/40 text-primary hover:bg-primary/5"
              >
                +
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
