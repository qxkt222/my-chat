import { useState } from "react";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { streamChat } from "@/lib/tauri";
import { useT } from "@/lib/i18n";

/** 翻译工作区：源文本 → 激活模型流式翻译 → 对照显示（独立流，不污染会话） */
export function TranslationWorkspace() {
  const t = useT();
  const models = useSettingsStore((s) => s.models);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const model = models.find((m) => m.name === activeModel);
  const [src, setSrc] = useState("");
  const [target, setTarget] = useState("中文");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);

  const doTranslate = async () => {
    if (!model || !src.trim() || busy) return;
    setBusy(true);
    setOut("");
    const requestId = crypto.randomUUID();
    const sys = `你是专业翻译。把用户输入翻译成${target}，只输出译文，不要解释。`;
    await streamChat(
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
          { role: "user", content: src },
        ],
        temperature: 0.3,
        thinking_enabled: false,
      },
      requestId,
      {
        onToken: (d) => setOut((prev) => prev + d),
        onDone: () => setBusy(false),
        onError: (e) => {
          setOut((prev) => prev + `${t("trans.fail")}${e}`);
          setBusy(false);
        },
      }
    );
  };

  return (
    <div className="flex flex-col h-full p-4 gap-3 max-w-4xl mx-auto w-full">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{t("trans.title")}</span>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="px-2 py-1 text-xs bg-background border border-input rounded"
        >
          {["中文", "English", "日本語", "한국어", "Français", "Deutsch", "Русский"].map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
        <span className="text-[11px] text-muted-foreground">
          {t("trans.usingModel", { name: model?.name || t("no.model") })}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 flex-1 min-h-0">
        <textarea
          value={src}
          onChange={(e) => setSrc(e.target.value)}
          placeholder={t("trans.srcPlaceholder")}
          className="w-full h-full resize-none px-3 py-2 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <textarea
          value={out}
          readOnly
          placeholder={t("trans.outPlaceholder")}
          className="w-full h-full resize-none px-3 py-2 text-sm bg-card border border-border rounded"
        />
      </div>
      <div className="flex justify-end">
        <button
          onClick={doTranslate}
          disabled={!model || !src.trim() || busy}
          className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40"
        >
          {busy ? t("trans.busy") : t("trans.button")}
        </button>
      </div>
    </div>
  );
}
