import { useState } from "react";
import { Languages } from "lucide-react";
import { useTranslateStore } from "@/stores/useTranslateStore";
import { useT } from "@/lib/i18n";
import { translateText as invokeTranslate } from "@/lib/tauri";

/** 翻译引擎配置:Google(免key)/ DeepL(需key)/ LibreTranslate(自托管或公共实例) */
export function TranslateManager() {
  const t = useT();
  const store = useTranslateStore();
  const [testText, setTestText] = useState("");
  const [testOut, setTestOut] = useState("");
  const [testing, setTesting] = useState(false);

  const runTest = async () => {
    if (!testText.trim() || testing) return;
    setTesting(true);
    setTestOut("");
    try {
      const out = await invokeTranslate(
        testText,
        "zh-CN",
        store.engine,
        store.deeplKey,
        store.libreUrl,
        store.proxyUrl
      );
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
          value={store.engine}
          onChange={(e) => store.setEngine(e.target.value as "google" | "deepl" | "libre")}
          className="px-2 py-1.5 text-xs bg-background border border-input rounded"
        >
          <option value="google">{t("translate.engineGoogle")}</option>
          <option value="deepl">{t("translate.engineDeepl")}</option>
          <option value="libre">{t("translate.engineLibre")}</option>
        </select>
        <span className="text-[10px] text-muted-foreground">{t("translate.engineHint")}</span>
      </div>

      {store.engine === "deepl" && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground w-24">{t("translate.deeplKey")}:</label>
          <input
            type="password"
            value={store.deeplKey}
            onChange={(e) => store.setDeeplKey(e.target.value)}
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
            onChange={(e) => store.setLibreUrl(e.target.value)}
            placeholder="http://localhost:5000 或公共实例地址"
            className="flex-1 px-2 py-1.5 text-xs bg-background border border-input rounded"
          />
        </div>
      )}

      {/* 代理:国内访问 Google/DeepL 必需(与 SearXNG 同款飞鸟代理) */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground w-24">{t("translate.proxy")}:</label>
        <input
          value={store.proxyUrl}
          onChange={(e) => store.setProxyUrl(e.target.value)}
          placeholder="http://127.0.0.1:16210(留空 = 直连)"
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
            onClick={runTest}
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
