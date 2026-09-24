// components/ui/ConfirmDialog.tsx — 原生弹窗替代（Tauri WebView2 禁用 window.confirm/prompt/alert）
//
// 背景：Tauri 2 的 WebView2 默认禁用原生弹窗——confirm() 恒 false、prompt() 恒 null、
// alert() 是 no-op，导致依赖原生弹窗的功能（删除确认/软重置/[ask]/导入等）全部静默失效。
// 这里提供 Promise 式的确认/输入弹层：askConfirm / askPrompt，宿主组件挂载于 AppShell。

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

type DialogState =
  | { mode: "confirm"; message: string; resolve: (v: boolean) => void }
  | { mode: "prompt"; message: string; defaultValue: string; resolve: (v: string | null) => void };

let pending: DialogState | null = null;
const listeners = new Set<() => void>();

function setPending(s: DialogState | null) {
  pending = s;
  listeners.forEach((l) => l());
}

/** 确认框：resolve(true) = 确认，resolve(false) = 取消 */
export function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    setPending({ mode: "confirm", message, resolve });
  });
}

/** 输入框：resolve(输入值)，取消返回 null（对齐 window.prompt 语义） */
export function askPrompt(message: string, defaultValue = ""): Promise<string | null> {
  return new Promise((resolve) => {
    setPending({ mode: "prompt", message, defaultValue, resolve });
  });
}

/** 宿主组件：常驻挂载（AppShell），有 pending 请求时渲染弹层 */
export function ConfirmDialogHost() {
  const t = useT();
  const [, force] = useState(0);
  const [value, setValue] = useState("");

  useEffect(() => {
    const l = () => {
      force((n) => n + 1);
      setValue(pending?.mode === "prompt" ? pending.defaultValue : "");
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const st = pending;

  // Escape 取消(与遮罩点击一致:confirm→false, prompt→null)
  useEffect(() => {
    if (!st) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        const r = st.resolve;
        setPending(null);
        r((st.mode === "confirm" ? false : null) as never);
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [st]);

  if (!st) return null;

  const close = (v: boolean | string | null) => {
    const r = st.resolve;
    setPending(null);
    r(v as never);
  };

  return (
    <div
      className="fixed inset-0 z-[95] bg-black/40 flex items-center justify-center"
      onClick={() => close(st.mode === "confirm" ? false : null)}
    >
      <div
        className="w-[380px] max-w-[90vw] bg-card border border-border rounded-lg shadow-xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm text-foreground mb-3 whitespace-pre-wrap break-words">{st.message}</p>
        {st.mode === "prompt" && (
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") close(value);
            }}
            className="w-full px-2 py-1.5 text-xs bg-background border border-input rounded mb-3 focus:outline-none focus:ring-1 focus:ring-ring"
          />
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={() => close(st.mode === "confirm" ? false : null)}
            className="px-3 py-1.5 text-xs rounded border border-input hover:bg-muted"
          >
            {t("settings.cancel")}
          </button>
          <button
            onClick={() => close(st.mode === "confirm" ? true : value)}
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {t("dialog.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
