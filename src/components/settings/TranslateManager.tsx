import { useState } from "react";
import { Languages } from "lucide-react";
import { useTranslateStore } from "@/stores/useTranslateStore";
import { useLlamaStore } from "@/stores/useLlamaStore";
import { useT } from "@/lib/i18n";
import { pickFile, probeLocalLlm } from "@/lib/tauri";
import { translateText } from "@/lib/translate";
import type { TranslateEngine } from "@/types";

/** Ollama 默认 OpenAI 兼容端点；留空时探测/测试都回退到这里 */
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";

/** 空串 = 未填写（null）；非数字不提交，避免把输入中途的 "-" 当成配置。 */
function parseOptionalInt(raw: string): number | null | undefined {
  const v = raw.trim();
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * 翻译引擎配置:Google(免key)/ DeepL(需key)/ LibreTranslate(自托管)/
 * 本地(OpenAI 兼容:Ollama / LM Studio / llama.cpp server)
 */
export function TranslateManager() {
  const t = useT();
  const store = useTranslateStore();
  const llama = useLlamaStore();
  const [testText, setTestText] = useState("");
  const [testOut, setTestOut] = useState("");
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelHint, setModelHint] = useState("");

  const pathsMissing = !llama.serverPath.trim() || !llama.modelPath.trim();

  const chooseServer = async () => {
    const path = await pickFile("llama-server 可执行文件", ["exe"]);
    if (path) await llama.setServerPath(path);
  };

  const chooseModel = async () => {
    const path = await pickFile("GGUF 模型", ["gguf"]);
    if (path) await llama.setModelPath(path);
  };

  const onOptionalIntChange = (raw: string, setter: (v: number | null) => Promise<void>) => {
    const v = parseOptionalInt(raw);
    if (v !== undefined) void setter(v);
  };

  // 状态徽标：启动中 > 运行中(端口/pid) > 失败 > 未运行
  const llamaBadge = llama.starting
    ? { cls: "bg-muted text-muted-foreground", text: t("translate.llama.starting") }
    : llama.status.running
      ? {
          cls: "bg-emerald-500/15 text-emerald-600",
          text: t("translate.llama.running", {
            port: llama.status.port ?? "?",
            pid: llama.status.pid ?? "?",
          }),
        }
      : llama.status.error
        ? { cls: "bg-destructive/15 text-destructive", text: t("translate.llama.failed") }
        : { cls: "bg-muted text-muted-foreground", text: t("translate.llama.stopped") };

  const onEngineChange = async (engine: TranslateEngine) => {
    await store.setEngine(engine);
    // 首次切到本地引擎时填上 Ollama 默认地址,避免用户面对空输入框无从下手
    if (engine === "local" && !store.localBaseUrl.trim()) {
      await store.setLocalBaseUrl(DEFAULT_LOCAL_BASE_URL);
    }
  };

  const fetchModels = async () => {
    if (fetchingModels) return;
    setFetchingModels(true);
    setModelHint("");
    try {
      const list = await probeLocalLlm(
        store.localBaseUrl.trim() || DEFAULT_LOCAL_BASE_URL,
        store.localApiKey
      );
      setModels(list);
      setModelHint(
        list.length > 0
          ? t("translate.localModelsFetched", { n: list.length })
          : t("translate.localModelsEmpty")
      );
    } catch (e) {
      setModelHint(`❌ ${String(e)}`);
    }
    setFetchingModels(false);
  };

  const runTest = async () => {
    if (!testText.trim() || testing) return;
    setTesting(true);
    setTestOut("");
    try {
      // 走当前引擎与全局配置(含 local 块),语言码由 lib/translate 统一映射
      const out = await translateText(testText, "中文");
      setTestOut(out || "(空)");
    } catch (e) {
      setTestOut(`❌ ${String(e)}`);
    }
    setTesting(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <Languages className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">{t("translate.title")}</span>
        <span className="text-[10px] text-muted-foreground">{t("translate.subtitle")}</span>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground w-24">{t("translate.engine")}:</label>
        <select
          aria-label={t("translate.engine")}
          value={store.engine}
          onChange={(e) => {
            void onEngineChange(e.target.value as TranslateEngine);
          }}
          className="px-2 py-1.5 text-xs bg-background border border-input rounded"
        >
          <option value="google">{t("translate.engineGoogle")}</option>
          <option value="deepl">{t("translate.engineDeepl")}</option>
          <option value="libre">{t("translate.engineLibre")}</option>
          <option value="local">{t("translate.engineLocal")}</option>
        </select>
        <span className="text-[10px] text-muted-foreground">{t("translate.engineHint")}</span>
      </div>

      {store.engine === "deepl" && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground w-24">{t("translate.deeplKey")}:</label>
          <input
            type="password"
            value={store.deeplKey}
            onChange={(e) => {
              void store.setDeeplKey(e.target.value);
            }}
            placeholder="DeepL API Key(免费档 :fx 结尾自动走 api-free)"
            className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
          />
        </div>
      )}
      {store.engine === "libre" && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground w-24">{t("translate.libreUrl")}:</label>
          <input
            value={store.libreUrl}
            onChange={(e) => {
              void store.setLibreUrl(e.target.value);
            }}
            placeholder="http://localhost:5000 或公共实例地址"
            className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
          />
        </div>
      )}

      {store.engine === "local" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label htmlFor="translate-local-url" className="text-xs text-muted-foreground w-24">
              {t("translate.localBaseUrl")}:
            </label>
            <input
              id="translate-local-url"
              value={store.localBaseUrl}
              onChange={(e) => {
                void store.setLocalBaseUrl(e.target.value);
              }}
              placeholder={DEFAULT_LOCAL_BASE_URL}
              className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
            />
          </div>
          <div className="flex items-center gap-2 pl-[6.5rem]">
            <span className="text-[10px] text-muted-foreground">
              {t("translate.localBaseUrlHint")}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="translate-local-key" className="text-xs text-muted-foreground w-24">
              {t("translate.localApiKey")}:
            </label>
            <input
              id="translate-local-key"
              type="password"
              value={store.localApiKey}
              onChange={(e) => {
                void store.setLocalApiKey(e.target.value);
              }}
              placeholder={t("translate.localApiKeyPlaceholder")}
              className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
            />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="translate-local-model" className="text-xs text-muted-foreground w-24">
              {t("translate.localModel")}:
            </label>
            <input
              id="translate-local-model"
              list="translate-local-models"
              value={store.localModel}
              onChange={(e) => {
                void store.setLocalModel(e.target.value);
              }}
              placeholder={t("translate.localModelPlaceholder")}
              className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
            />
            <datalist id="translate-local-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <button
              onClick={() => {
                void fetchModels();
              }}
              disabled={fetchingModels}
              className="px-2 py-1.5 text-xs border border-input rounded hover:bg-muted disabled:opacity-40"
            >
              {fetchingModels ? t("translate.localFetching") : t("translate.localFetchModels")}
            </button>
          </div>
          {modelHint && (
            <div className="pl-[6.5rem] text-[10px] text-muted-foreground whitespace-pre-wrap">
              {modelHint}
            </div>
          )}

          <div className="flex items-center gap-2">
            <label htmlFor="translate-local-prompt" className="text-xs text-muted-foreground w-24">
              {t("translate.localSystemPrompt")}:
            </label>
            <textarea
              id="translate-local-prompt"
              value={store.localSystemPrompt}
              onChange={(e) => {
                void store.setLocalSystemPrompt(e.target.value);
              }}
              rows={2}
              placeholder={t("translate.localSystemPromptPlaceholder")}
              className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
            />
          </div>

          <div className="flex items-center gap-2">
            <label
              htmlFor="translate-local-temperature"
              className="text-xs text-muted-foreground w-24"
            >
              {t("translate.localTemperature")}:
            </label>
            <input
              id="translate-local-temperature"
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={store.localTemperature}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === "") return;
                const n = Number(v);
                if (Number.isFinite(n)) void store.setLocalTemperature(n);
              }}
              className="w-20 px-2 py-1.5 text-xs bg-background border border-input rounded"
            />
            <label htmlFor="translate-local-timeout" className="text-xs text-muted-foreground ml-3">
              {t("translate.localTimeout")}:
            </label>
            <input
              id="translate-local-timeout"
              type="number"
              min="1"
              step="1"
              value={store.localTimeoutSecs}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === "") return;
                const n = Number(v);
                if (Number.isFinite(n) && n > 0) void store.setLocalTimeoutSecs(n);
              }}
              className="w-20 px-2 py-1.5 text-xs bg-background border border-input rounded"
            />
          </div>

          {/* ── 内置运行时（llama.cpp）：用户自备二进制/模型，只管启停 ── */}
          <div className="mt-3 pt-3 border-t border-border space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold">{t("translate.llama.title")}</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${llamaBadge.cls}`}>
                {llamaBadge.text}
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground">{t("translate.llama.subtitle")}</div>

            <div className="flex items-center gap-2">
              <label
                htmlFor="llama-server-path"
                className="text-xs text-muted-foreground w-24 shrink-0"
              >
                {t("translate.llama.serverPath")}:
              </label>
              <input
                id="llama-server-path"
                value={llama.serverPath}
                onChange={(e) => {
                  void llama.setServerPath(e.target.value);
                }}
                placeholder={t("translate.llama.serverPathPlaceholder")}
                className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
              <button
                onClick={() => {
                  void chooseServer();
                }}
                aria-label={t("translate.llama.chooseServer")}
                className="px-2 py-1.5 text-xs border border-input rounded hover:bg-muted"
              >
                {t("translate.llama.choose")}
              </button>
            </div>

            <div className="flex items-center gap-2">
              <label
                htmlFor="llama-model-path"
                className="text-xs text-muted-foreground w-24 shrink-0"
              >
                {t("translate.llama.modelPath")}:
              </label>
              <input
                id="llama-model-path"
                value={llama.modelPath}
                onChange={(e) => {
                  void llama.setModelPath(e.target.value);
                }}
                placeholder={t("translate.llama.modelPathPlaceholder")}
                className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
              <button
                onClick={() => {
                  void chooseModel();
                }}
                aria-label={t("translate.llama.chooseModel")}
                className="px-2 py-1.5 text-xs border border-input rounded hover:bg-muted"
              >
                {t("translate.llama.choose")}
              </button>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <label htmlFor="llama-ctx" className="text-xs text-muted-foreground w-24 shrink-0">
                {t("translate.llama.ctx")}:
              </label>
              <input
                id="llama-ctx"
                type="number"
                min="128"
                step="1"
                value={llama.ctxSize ?? ""}
                onChange={(e) => onOptionalIntChange(e.target.value, llama.setCtxSize)}
                placeholder={t("translate.llama.ctxPlaceholder")}
                className="w-24 px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
              <label htmlFor="llama-ngl" className="text-xs text-muted-foreground ml-2">
                {t("translate.llama.gpuLayers")}:
              </label>
              <input
                id="llama-ngl"
                type="number"
                min="0"
                step="1"
                value={llama.nGpuLayers ?? ""}
                onChange={(e) => onOptionalIntChange(e.target.value, llama.setNGpuLayers)}
                placeholder={t("translate.llama.gpuLayersPlaceholder")}
                className="w-24 px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
              <label htmlFor="llama-port" className="text-xs text-muted-foreground ml-2">
                {t("translate.llama.port")}:
              </label>
              <input
                id="llama-port"
                type="number"
                min="1"
                max="65535"
                step="1"
                value={llama.port ?? ""}
                onChange={(e) => onOptionalIntChange(e.target.value, llama.setPort)}
                placeholder={t("translate.llama.portPlaceholder")}
                className="w-24 px-2 py-1.5 text-xs bg-background border border-input rounded"
              />
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <span className="w-24 shrink-0" />
              <button
                onClick={() => {
                  void llama.start();
                }}
                disabled={llama.starting || pathsMissing}
                className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40"
              >
                {llama.starting ? t("translate.llama.starting") : t("translate.llama.start")}
              </button>
              <button
                onClick={() => {
                  void llama.stop();
                }}
                disabled={llama.starting || !llama.status.running}
                className="px-3 py-1.5 text-xs border border-input rounded hover:bg-muted disabled:opacity-40"
              >
                {t("translate.llama.stop")}
              </button>
              {pathsMissing && (
                <span className="text-[10px] text-muted-foreground">
                  {t("translate.llama.pathsRequired")}
                </span>
              )}
            </div>

            {llama.autoFilledUrl && (
              <div className="pl-[6.5rem] text-[10px] text-emerald-600">
                {t("translate.llama.autoFilled", { url: llama.autoFilledUrl })}
              </div>
            )}
            {!llama.starting && !llama.status.running && llama.status.error && (
              <div className="pl-[6.5rem] text-[10px] text-destructive whitespace-pre-wrap break-all">
                {llama.status.error}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 代理:国内访问 Google/DeepL 必需(与 SearXNG 用同一个本地代理) */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground w-24">{t("translate.proxy")}:</label>
        <input
          value={store.proxyUrl}
          onChange={(e) => {
            void store.setProxyUrl(e.target.value);
          }}
          placeholder="http://127.0.0.1:7890(留空 = 直连)"
          className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
        />
        <span className="text-[10px] text-muted-foreground">{t("translate.proxyHint")}</span>
      </div>

      {/* 测试面板 */}
      <div className="pt-3 border-t border-border space-y-2">
        <span className="text-[11px] text-muted-foreground">{t("translate.testHint")}</span>
        <textarea
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
          rows={3}
          placeholder="Hello, I am Masuyo. Nice to meet you!"
          className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded resize-none"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={() => {
              void runTest();
            }}
            disabled={testing || !testText.trim()}
            className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40"
          >
            {testing ? t("translate.testing") : t("translate.test")}
          </button>
        </div>
        {testOut && (
          <pre className="p-2 text-[11px] bg-muted rounded whitespace-pre-wrap">{testOut}</pre>
        )}
      </div>
    </div>
  );
}
