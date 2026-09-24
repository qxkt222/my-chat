// hooks/useEscapeClose.ts — 弹层 Escape 关闭
//
// 桌面 Tauri 应用中,用户习惯按 Esc 退出弹层/对话框。此前所有弹层(设置/向导/
// 编辑器/确认框)都没有 Esc 关闭支持,导致"点开就退不出去"的体验问题。
// 用法: const { close } = useEscapeClose(onClose); 或 useEscapeClose(onClose)
// 自动在组件挂载期间监听 keydown Escape。

import { useEffect } from "react";

/**
 * 监听 Escape 键触发 onClose。
 * @param onClose 关闭回调(弹层打开时传入;关闭后传 undefined 避免误触发)
 * @param deps 附加依赖(默认 [onClose])
 */
export function useEscapeClose(onClose: (() => void) | undefined, deps: unknown[] = []): void {
  useEffect(() => {
    if (!onClose) return;
    const cb = onClose;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cb();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, ...deps]);
}
