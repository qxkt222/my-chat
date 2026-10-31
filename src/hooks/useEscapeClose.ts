// hooks/useEscapeClose.ts — 弹层 Escape 关闭（层级栈）
//
// 桌面 Tauri 应用中,用户习惯按 Esc 退出弹层/对话框。此前所有弹层(设置/向导/
// 编辑器/确认框)都没有 Esc 关闭支持,导致"点开就退不出去"的体验问题。
// 用法: useEscapeClose(onClose) — 弹层打开时传入回调,关闭时传 undefined。
//
// ⚠️ 层级栈(T-102):旧实现对每个弹层各挂一个 window keydown,且不阻断传播,
//    一次 Esc 会把「向导 + 设置」两层一起关掉,还会继续冒泡触发全局
//    "停止生成"快捷键。现在所有弹层按挂载顺序进栈,只有栈顶消费 Esc
//    (preventDefault + stopImmediatePropagation),其余弹层与全局快捷键都不响应。
//
// 捕获阶段(window capture)是必须的:真实键盘事件的 target 是焦点元素,
// capture 阶段先于 App 注册的 bubble 全局快捷键执行;stopImmediatePropagation
// 由此挡住「停止生成」。测试里 fireEvent.keyDown(window) 在 target 阶段同样有效。

import { useEffect, useRef } from "react";

type EscapeLayer = () => void;

/** 模块级层级栈:后挂载的弹层在上层,只有栈顶响应 Esc */
const escapeLayers: EscapeLayer[] = [];

/**
 * 监听 Escape 键触发 onClose。
 * @param onClose 关闭回调(弹层打开时传入;关闭后传 undefined 避免误触发)
 * @param deps 附加依赖(默认 [])
 */
export function useEscapeClose(onClose: (() => void) | undefined, deps: unknown[] = []): void {
  // 回调可能每次渲染都是新引用;用 ref 承接,避免 effect 重挂把本层重新压到栈顶。
  // 在 effect 里写 ref(而非渲染期):react-hooks/refs 禁止渲染期访问 ref.current。
  const callbackRef = useRef(onClose);
  useEffect(() => {
    callbackRef.current = onClose;
  });
  const active = onClose !== undefined;

  useEffect(() => {
    if (!active) return;
    const layer: EscapeLayer = () => {
      callbackRef.current?.();
    };
    escapeLayers.push(layer);

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // 仅最上层消费:下层弹层不得同时关闭
      if (escapeLayers[escapeLayers.length - 1] !== layer) return;
      e.preventDefault();
      // 阻断同一事件上的其它监听(全局"停止生成"等)
      e.stopImmediatePropagation();
      layer();
    }

    // capture:先于 App 的 bubble 全局快捷键
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      const i = escapeLayers.lastIndexOf(layer);
      if (i >= 0) escapeLayers.splice(i, 1);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ...deps]);
}
