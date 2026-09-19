import { useState } from "react";
import { Bot, Send, Wand2, TrendingUp } from "lucide-react";
import { useCharacterStore } from "@/stores/useCharacterStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useCacheStatsStore } from "@/stores/useCacheStatsStore";
import { streamChat } from "@/lib/tauri";
import { useT } from "@/lib/i18n";
import { showToast } from "@/components/ui/Toast";

/** 快捷动作 */
const QUICK_ACTIONS = [
  { key: "card", labelKey: "assistant.actCard" },
  { key: "lore", labelKey: "assistant.actLore" },
  { key: "preset", labelKey: "assistant.actPreset" },
  { key: "explain", labelKey: "assistant.actExplain" },
];

/** 酒馆助手:AI 创作辅助(角色卡/世界书/预设)+ 缓存诊断小卡 */
export function TavernAssistant() {
  const t = useT();
  const charStore = useCharacterStore();
  const settings = useSettingsStore();
  const cache = useCacheStatsStore();
  const [target, setTarget] = useState<"card" | "lore" | "preset">("card");
  const [contextId, setContextId] = useState("");
  const [input, setInput] = useState("");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);

  const model = settings.models.find((m) => m.name === settings.activeModel);
  const avg = cache.avgRate();

  const run = async (prompt: string) => {
    if (!model) {
      showToast("error", t("no.model"));
      return;
    }
    if (busy) return;
    setBusy(true);
    setOut("");
    const requestId = crypto.randomUUID();
    let acc = "";
    // 上下文拼进 system,让助手基于选中对象创作
    let ctxText = "";
    if (target === "card") {
      const card = charStore.characters.find((c) => c.id === contextId);
      if (card)
        ctxText = `角色名:${card.name}\n描述:${card.description}\n性格:${card.personality}\n场景:${card.scenario}`;
    } else if (target === "lore") {
      const book =
        contextId === "__main__" ? charStore.globalLorebook : charStore.lorebooks[contextId];
      if (book)
        ctxText = book.entries
          .map((e) => `关键词:${e.keys.join(",")}\n内容:${e.content}`)
          .join("\n\n");
    } else if (target === "preset") {
      const preset = charStore.getPreset(contextId);
      if (preset) ctxText = preset.template;
    }
    const sys = `你是酒馆(SillyTavern)创作助手,精通角色卡/世界书/提示词预设。
当前辅助对象:${target === "card" ? "角色卡" : target === "lore" ? "世界书" : "预设"}\n${ctxText ? `以下是当前对象内容:\n${ctxText}\n\n` : ""}
请按用户要求创作。输出要求:
- 角色卡相关:给出可直接填入的字段(名称/描述/性格/场景/开场白)。
- 世界书相关:每行一条"关键词1,关键词2:内容"格式。
- 预设相关:给出可直接使用的提示词模板(支持 {{char}}/{{user}}/{{description}} 等宏)。
只输出创作内容,不要解释过程。`;

    await streamChat(
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
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
        thinking_enabled: false,
      },
      requestId,
      {
        onToken: (d) => {
          acc += d;
          setOut(acc);
        },
        onDone: () => setBusy(false),
        onError: (e) => {
          setOut(`❌ ${String(e)}`);
          setBusy(false);
        },
      }
    );
  };

  const quickAction = (key: string) => {
    if (key === "card")
      void run("请帮我完善这个角色卡:补全描述、性格、场景,并写一个吸引人的开场白(first_mes)。");
    else if (key === "lore")
      void run("请为当前世界书补充 5 条新条目(每行 关键词1,关键词2:内容),丰富世界观设定。");
    else if (key === "preset")
      void run("请优化当前预设模板:更简洁有力、更适合角色扮演,保持占位符完整。");
    else void run("请解释当前对象的用途和推荐用法(角色卡/世界书/预设分别说明)。");
  };

  /** 一键应用:世界书条目 → 写入当前世界书 */
  const applyLore = async () => {
    if (!out.trim()) return;
    const lines = out.split("\n").filter((l) => l.includes(":"));
    if (lines.length === 0) {
      showToast("info", t("assistant.noLoreLines"));
      return;
    }
    const book =
      contextId === "__main__" ? charStore.globalLorebook : charStore.lorebooks[contextId];
    if (!book) return;
    const entries = [...(book.entries || [])];
    let added = 0;
    for (const line of lines) {
      const idx = line.indexOf(":");
      const keys = line
        .slice(0, idx)
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const content = line.slice(idx + 1).trim();
      if (keys.length && content) {
        entries.push({ keys, content, insertion_order: entries.length, enabled: true });
        added++;
      }
    }
    if (added > 0) {
      if (contextId === "__main__") await charStore.saveGlobalLorebook({ ...book, entries });
      else await charStore.saveLorebook(contextId, { ...book, entries });
      showToast("success", t("assistant.loreApplied", { n: added }));
    }
  };

  /** 一键应用:预设生成 → 保存为新预设 */
  const applyPreset = async () => {
    if (!out.trim()) return;
    await charStore.savePreset({
      id: `assistant-${crypto.randomUUID()}`,
      name: `助手生成 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
      is_preset: false,
      description: "酒馆助手生成",
      template: out,
      created_at: new Date().toISOString(),
    });
    showToast("success", t("assistant.presetApplied"));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <Bot className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">{t("assistant.title")}</span>
        <span className="text-[10px] text-muted-foreground">{t("assistant.subtitle")}</span>
      </div>

      {/* 缓存小卡 */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-primary/20 bg-primary/5 text-xs">
        <TrendingUp className="w-3.5 h-3.5 text-primary" />
        <span className="text-muted-foreground">{t("cache.title")}:</span>
        <span className="font-bold text-primary">{avg == null ? "—" : `${avg}%`}</span>
        <span className="text-[10px] text-muted-foreground">
          ({cache.records.length} {t("cache.avg", { n: cache.records.length }).split("（")[0]})
        </span>
        <span className="text-[10px] text-muted-foreground ml-auto">
          {t("assistant.cacheHint")}
        </span>
      </div>

      {/* 目标 + 上下文 */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground w-16 shrink-0">{t("assistant.target")}:</span>
        <select
          value={target}
          onChange={(e) => {
            setTarget(e.target.value as "card" | "lore" | "preset");
            setContextId("");
          }}
          className="px-2 py-1.5 bg-background border border-input rounded"
        >
          <option value="card">{t("char.title")}</option>
          <option value="lore">{t("lore.title")}</option>
          <option value="preset">{t("preset.title")}</option>
        </select>
        <select
          value={contextId}
          onChange={(e) => setContextId(e.target.value)}
          className="flex-1 px-2 py-1.5 bg-background border border-input rounded"
        >
          <option value="">{t("assistant.noContext")}</option>
          {target === "card" &&
            charStore.characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          {target === "lore" && (
            <>
              <option value="__main__">{t("lore.main")}</option>
              {Object.entries(charStore.lorebooks).map(([id, b]) => (
                <option key={id} value={id}>
                  {b.name || id}
                </option>
              ))}
            </>
          )}
          {target === "preset" &&
            charStore.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </div>

      {/* 快捷动作 */}
      <div className="flex gap-1.5 flex-wrap">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.key}
            onClick={() => quickAction(a.key)}
            disabled={busy}
            className="px-2 py-1 text-[11px] rounded border border-primary/30 text-primary hover:bg-primary/5 flex items-center gap-1 disabled:opacity-40"
          >
            <Wand2 className="w-3 h-3" /> {t(a.labelKey)}
          </button>
        ))}
      </div>

      {/* 输入 + 输出 */}
      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
          placeholder={t("assistant.inputPlaceholder")}
          className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
        />
        <button
          onClick={() => void run(input)}
          disabled={busy || !input.trim()}
          className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40 self-end flex items-center gap-1"
        >
          <Send className="w-3 h-3" /> {busy ? t("assistant.busy") : t("assistant.send")}
        </button>
      </div>

      {out && (
        <div className="space-y-2">
          <pre className="p-2 text-[11px] bg-muted rounded whitespace-pre-wrap max-h-64 overflow-y-auto">
            {out}
          </pre>
          {/* 一键应用 */}
          <div className="flex gap-2 justify-end">
            {target === "lore" && contextId && (
              <button
                onClick={applyLore}
                className="px-3 py-1 text-xs rounded bg-primary/10 text-primary hover:bg-primary/20"
              >
                {t("assistant.applyLore")}
              </button>
            )}
            {target === "preset" && (
              <button
                onClick={applyPreset}
                className="px-3 py-1 text-xs rounded bg-primary/10 text-primary hover:bg-primary/20"
              >
                {t("assistant.applyPreset")}
              </button>
            )}
            <button
              onClick={() => navigator.clipboard.writeText(out)}
              className="px-3 py-1 text-xs rounded border border-input hover:bg-muted"
            >
              {t("chat.copy")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
