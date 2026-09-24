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
  Anchor,
} from "lucide-react";
import { useSimulationStore } from "@/stores/useSimulationStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useT } from "@/lib/i18n";
import { rollDice } from "@/lib/sim-prompt";
import { askConfirm } from "@/components/ui/ConfirmDialog";
import { QuickReplyBar } from "@/components/chat/QuickReplyBar";
import { MessageBubble } from "@/components/chat/MessageBubble";
import type { SimType } from "@/types";
import { DICE_OPTIONS, filterSimConversations, groupSimByType } from "./presets";
import { NewSimulationModal } from "./NewSimulationModal";
import { StatePanels } from "./StatePanels";

interface Props {
  onOpenSettings: () => void;
}

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

  // 过滤与分组抽到 ./presets.ts（纯函数）
  const filtered = useMemo(
    () => filterSimConversations(sim.conversations, search),
    [sim.conversations, search]
  );

  const byType = useMemo(() => groupSimByType(filtered), [filtered]);

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

// TYPE_PRESETS / DICE_OPTIONS / filterSimConversations / groupSimByType 已移到 ./presets.ts；
// NewSimulationModal 与 StatePanels 已搬到 ./NewSimulationModal.tsx 与 ./StatePanels.tsx。
