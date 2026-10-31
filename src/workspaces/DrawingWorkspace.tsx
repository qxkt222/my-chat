import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useSettingsStore, type DrawEngineSetting } from "@/stores/useSettingsStore";
import { generateImage } from "@/lib/tauri";
import { useT } from "@/lib/i18n";
import type { DrawRequest, GenImage } from "@/types";

/**
 * AppShell 用条件渲染切工作区（`view === "drawing" && <DrawingWorkspace />`），
 * 离开就会卸载组件。把输入与结果放在模块级缓存里，回来时 useState 从缓存初始化，
 * 用户不会丢失刚写的提示词/负面词或已生成的多张图。
 * （阶段 2c2：先低成本保住状态；后续如需跨会话持久化再提升到 store。）
 */
const uiCache: {
  prompt: string;
  negative: string;
  size: string | null;
  steps: string | null;
  cfg: string | null;
  seed: string | null;
  sampler: string;
  images: GenImage[];
  error: string;
} = {
  prompt: "",
  negative: "",
  size: null,
  steps: null,
  cfg: null,
  seed: null,
  sampler: "",
  images: [],
  error: "",
};

const SIZE_OPTIONS = ["512x512", "768x768", "1024x1024", "1024x1536", "1536x1024"];

function parseNum(raw: string): number | null {
  const n = Number(raw.trim());
  return raw.trim() !== "" && Number.isFinite(n) ? n : null;
}

/** 缓存只允许模块作用域写入：组件内直接改模块变量会被 react-hooks/immutability 拦下 */
function rememberUi<K extends keyof typeof uiCache>(key: K, value: (typeof uiCache)[K]): void {
  uiCache[key] = value;
}

/** 绘图工作区：OpenAI 兼容 / ComfyUI / SD WebUI，提示词 → 生成 → 多图展示 */
export function DrawingWorkspace() {
  const t = useT();
  const models = useSettingsStore((s) => s.models);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const drawConfig = useSettingsStore((s) => s.drawConfig);
  const setDrawConfig = useSettingsStore((s) => s.setDrawConfig);
  const model = models.find((m) => m.name === activeModel);

  const [prompt, setPromptState] = useState(uiCache.prompt);
  const [negative, setNegativeState] = useState(uiCache.negative);
  const [size, setSizeState] = useState(uiCache.size ?? drawConfig.defaults.size);
  const [steps, setStepsState] = useState(uiCache.steps ?? String(drawConfig.defaults.steps));
  const [cfg, setCfgState] = useState(uiCache.cfg ?? String(drawConfig.defaults.cfgScale));
  const [seed, setSeedState] = useState(uiCache.seed ?? String(drawConfig.defaults.seed));
  const [sampler, setSamplerState] = useState(uiCache.sampler || drawConfig.defaults.sampler);
  const [images, setImagesState] = useState<GenImage[]>(uiCache.images);
  const [err, setErrState] = useState(uiCache.error);
  const [busy, setBusy] = useState(false);

  // 受控 setter：同步模块级缓存，组件卸载后回来仍能恢复
  const setPrompt = (v: string) => {
    rememberUi("prompt", v);
    setPromptState(v);
  };
  const setNegative = (v: string) => {
    rememberUi("negative", v);
    setNegativeState(v);
  };
  const setSize = (v: string) => {
    rememberUi("size", v);
    setSizeState(v);
  };
  const setSteps = (v: string) => {
    rememberUi("steps", v);
    setStepsState(v);
  };
  const setCfg = (v: string) => {
    rememberUi("cfg", v);
    setCfgState(v);
  };
  const setSeed = (v: string) => {
    rememberUi("seed", v);
    setSeedState(v);
  };
  const setSampler = (v: string) => {
    rememberUi("sampler", v);
    setSamplerState(v);
  };
  const setImages = (v: GenImage[]) => {
    rememberUi("images", v);
    setImagesState(v);
  };
  const setErr = (v: string) => {
    rememberUi("error", v);
    setErrState(v);
  };

  const isServiceEngine = drawConfig.engine !== "chat-model";
  const engineLabel = (e: DrawEngineSetting): string => {
    if (e === "comfyui") return t("draw.engineComfyui");
    if (e === "sdwebui") return t("draw.engineSdwebui");
    if (e === "openai") return t("draw.engineOpenai");
    return t("draw.engineChatModel");
  };

  /** 组装 Rust DrawRequest：chat-model 沿用旧行为（从当前聊天模型推导），
   *  其余引擎直接用全局绘图设置；URL 归一化交给 Rust，前端不再做字符串手术。 */
  const buildRequest = (): DrawRequest | null => {
    const base = {
      prompt: prompt.trim(),
      negativePrompt: negative.trim() || null,
      size,
    };
    if (drawConfig.engine === "chat-model") {
      if (!model) return null;
      return {
        ...base,
        engine: "openai",
        baseUrl: model.api_url,
        apiKey: model.api_key || null,
        model: model.model || null,
      };
    }
    return {
      ...base,
      engine: drawConfig.engine,
      baseUrl: drawConfig.baseUrl.trim(),
      apiKey: drawConfig.apiKey || null,
      model: drawConfig.model.trim() || null,
      steps: parseNum(steps),
      cfgScale: parseNum(cfg),
      seed: parseNum(seed),
      sampler: sampler.trim() || null,
      workflowJson:
        drawConfig.engine === "comfyui" && drawConfig.comfyWorkflow.trim()
          ? drawConfig.comfyWorkflow
          : null,
    };
  };

  const canGenerate =
    !busy &&
    prompt.trim().length > 0 &&
    (drawConfig.engine === "chat-model" ? !!model : drawConfig.baseUrl.trim().length > 0);

  const doDraw = async () => {
    const req = buildRequest();
    if (!req || !req.prompt || busy) return;
    setBusy(true);
    setErr("");
    setImages([]);
    try {
      // Rust 把图片写到本地目录并返回路径（避免大 Base64 走 IPC）
      const out = await generateImage(req);
      setImages(out);
      if (out.length === 0) setErr(t("draw.noImage"));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const sizeOptions = Array.from(new Set([...SIZE_OPTIONS, size]));

  return (
    <div className="flex flex-col h-full p-4 gap-3 max-w-3xl mx-auto w-full">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{t("draw.title")}</span>
        <select
          aria-label={t("draw.engine")}
          value={drawConfig.engine}
          onChange={(e) => void setDrawConfig({ engine: e.target.value as DrawEngineSetting })}
          className="px-2 py-1 text-xs bg-background border border-input rounded"
        >
          <option value="chat-model">{t("draw.engineChatModel")}</option>
          <option value="openai">{t("draw.engineOpenai")}</option>
          <option value="comfyui">{t("draw.engineComfyui")}</option>
          <option value="sdwebui">{t("draw.engineSdwebui")}</option>
        </select>
        <select
          aria-label={t("draw.size")}
          value={size}
          onChange={(e) => setSize(e.target.value)}
          className="px-2 py-1 text-xs bg-background border border-input rounded"
        >
          {sizeOptions.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <span className="text-[11px] text-muted-foreground">
          {isServiceEngine
            ? t("draw.usingService", {
                engine: engineLabel(drawConfig.engine),
                url: drawConfig.baseUrl,
              })
            : t("draw.using", { name: model?.name || t("no.model") })}
        </span>
      </div>

      <textarea
        aria-label={t("draw.prompt")}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={t("draw.promptPlaceholder")}
        rows={3}
        className="w-full resize-none px-3 py-2 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <textarea
        aria-label={t("draw.negative")}
        value={negative}
        onChange={(e) => setNegative(e.target.value)}
        placeholder={t("draw.negativePlaceholder")}
        rows={2}
        className="w-full resize-none px-3 py-2 text-xs bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
      />

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <label htmlFor="draw-steps" className="flex items-center gap-1">
          {t("draw.steps")}
          <input
            id="draw-steps"
            type="number"
            min="1"
            step="1"
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
            className="w-16 px-1.5 py-1 bg-background border border-input rounded"
          />
        </label>
        <label htmlFor="draw-cfg" className="flex items-center gap-1">
          {t("draw.cfg")}
          <input
            id="draw-cfg"
            type="number"
            min="0"
            step="0.1"
            value={cfg}
            onChange={(e) => setCfg(e.target.value)}
            className="w-16 px-1.5 py-1 bg-background border border-input rounded"
          />
        </label>
        <label htmlFor="draw-seed" className="flex items-center gap-1">
          {t("draw.seed")}
          <input
            id="draw-seed"
            type="number"
            step="1"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            className="w-20 px-1.5 py-1 bg-background border border-input rounded"
          />
        </label>
        <label htmlFor="draw-sampler" className="flex items-center gap-1">
          {t("draw.sampler")}
          <input
            id="draw-sampler"
            value={sampler}
            onChange={(e) => setSampler(e.target.value)}
            placeholder={t("draw.samplerHint")}
            className="w-32 px-1.5 py-1 bg-background border border-input rounded"
          />
        </label>
      </div>

      <div className="flex-1 min-h-0 rounded border border-dashed border-border flex items-center justify-center overflow-auto bg-card p-2">
        {images.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 w-full">
            {images.map((im, i) => (
              <img
                key={`${im.path}-${i}`}
                src={convertFileSrc(im.path)}
                alt={`generated ${i + 1}`}
                className="w-full h-auto rounded object-contain"
              />
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{t("draw.resultPlaceholder")}</span>
        )}
      </div>

      {images.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          {t("draw.imagesCount", { n: images.length })}
        </div>
      )}
      {err && (
        <div
          role="alert"
          className="px-2 py-1.5 text-xs rounded border border-destructive/40 bg-destructive/10 text-destructive whitespace-pre-wrap"
        >
          ❌ {err}
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={() => void doDraw()}
          disabled={!canGenerate}
          className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40"
        >
          {busy ? t("draw.busy") : t("draw.button")}
        </button>
      </div>
    </div>
  );
}
