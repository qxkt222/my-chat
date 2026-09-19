import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { generateImage } from "@/lib/tauri";
import { useT } from "@/lib/i18n";

/** 绘图工作区：OpenAI 兼容图片生成端点，提示词 → 生成 → 展示 */
export function DrawingWorkspace() {
  const t = useT();
  const models = useSettingsStore((s) => s.models);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const model = models.find((m) => m.name === activeModel);
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [busy, setBusy] = useState(false);
  const [img, setImg] = useState("");
  const [err, setErr] = useState("");

  const doDraw = async () => {
    if (!model || !prompt.trim() || busy) return;
    setBusy(true);
    setErr("");
    setImg("");
    try {
      // 端点 = {base}/v1/images/generations（build_api_url 兼容裸地址）
      const base = model.api_url.replace(/\/chat\/completions$/, "").replace(/\/v\d$/, "");
      const url = `${base}/v1/images/generations`;
      // Rust 把图片写到临时目录并返回路径（P2-2：避免大 Base64 走 IPC）
      const path = await generateImage(url, model.api_key, prompt, model.model, size);
      if (path) setImg(convertFileSrc(path));
      else setErr(t("draw.noImage"));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full p-4 gap-3 max-w-3xl mx-auto w-full">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{t("draw.title")}</span>
        <select
          value={size}
          onChange={(e) => setSize(e.target.value)}
          className="px-2 py-1 text-xs bg-background border border-input rounded"
        >
          {["256x256", "512x512", "1024x1024"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <span className="text-[11px] text-muted-foreground">
          {t("draw.using", { name: model?.name || t("no.model") })}
        </span>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={t("draw.promptPlaceholder")}
        rows={3}
        className="w-full resize-none px-3 py-2 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex-1 min-h-0 rounded border border-dashed border-border flex items-center justify-center overflow-hidden bg-card">
        {img ? (
          <img src={img} alt="generated" className="max-w-full max-h-full object-contain" />
        ) : (
          <span className="text-xs text-muted-foreground">
            {err || t("draw.resultPlaceholder")}
          </span>
        )}
      </div>
      <div className="flex justify-end">
        <button
          onClick={doDraw}
          disabled={!model || !prompt.trim() || busy}
          className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40"
        >
          {busy ? t("draw.busy") : t("draw.button")}
        </button>
      </div>
    </div>
  );
}
