import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { streamChat, cancelChat } from "@/lib/tauri";
import { useT } from "@/lib/i18n";

/**
 * AppShell 用条件渲染切工作区（`view === "translation" && <TranslationWorkspace />`），
 * 离开就会卸载组件。把源文本 / 目标语言 / 译文放在模块级缓存里，回来时 useState
 * 从缓存初始化，用户不会丢失刚写的输入或已经生成的译文（同 DrawingWorkspace 的 uiCache 写法）。
 * 卸载时取消在途流，避免切走后仍在后台生成、再回填一个已卸载的组件。
 */
const uiCache = {
  src: "",
  target: "中文",
  out: "",
};

/** 缓存只允许模块作用域写入：组件内直接改模块变量会被 react-hooks/immutability 拦下 */
function rememberUi<K extends keyof typeof uiCache>(key: K, value: (typeof uiCache)[K]): void {
  uiCache[key] = value;
}

/** 翻译工作区：源文本 → 激活模型流式翻译 → 对照显示（独立流，不污染会话） */
export function TranslationWorkspace() {
  const t = useT();
  const models = useSettingsStore((s) => s.models);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const model = models.find((m) => m.name === activeModel);
  const [src, setSrcState] = useState(uiCache.src);
  const [target, setTargetState] = useState(uiCache.target);
  const [out, setOutState] = useState(uiCache.out);
  const [busy, setBusy] = useState(false);
  /** 在途请求 id：卸载清理时用它取消流（T-150） */
  const requestRef = useRef<string | null>(null);

  // 受控 setter：同步模块级缓存，组件卸载后回来仍能恢复
  const setSrc = (v: string) => {
    rememberUi("src", v);
    setSrcState(v);
  };
  const setTarget = (v: string) => {
    rememberUi("target", v);
    setTargetState(v);
  };
  const resetOut = () => {
    rememberUi("out", "");
    setOutState("");
  };
  // 追加译文：即使组件已卸载，也要先写缓存（setState 在卸载后是 no-op）
  const appendOut = (v: string) => {
    rememberUi("out", uiCache.out + v);
    setOutState(uiCache.out);
  };

  useEffect(
    () => () => {
      const id = requestRef.current;
      requestRef.current = null;
      if (id) cancelChat(id);
    },
    []
  );

  const doTranslate = async () => {
    if (!model || !src.trim() || busy) return;
    setBusy(true);
    resetOut();
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    const sys = `你是专业翻译。把用户输入翻译成${target}，只输出译文，不要解释。`;
    try {
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
          onToken: (d) => appendOut(d),
          onDone: () => {
            if (requestRef.current === requestId) requestRef.current = null;
            setBusy(false);
          },
          onError: (e) => {
            appendOut(`${t("trans.fail")}${e}`);
            if (requestRef.current === requestId) requestRef.current = null;
            setBusy(false);
          },
        }
      );
    } catch (e) {
      appendOut(`${t("trans.fail")}${String(e)}`);
      if (requestRef.current === requestId) requestRef.current = null;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full p-4 gap-3 max-w-4xl mx-auto w-full">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{t("trans.title")}</span>
        <select
          aria-label={t("trans.title")}
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
          onClick={() => void doTranslate()}
          disabled={!model || !src.trim() || busy}
          className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40"
        >
          {busy ? t("trans.busy") : t("trans.button")}
        </button>
      </div>
    </div>
  );
}
