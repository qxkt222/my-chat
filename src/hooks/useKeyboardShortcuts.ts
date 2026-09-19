import { useEffect } from "react";

export interface Shortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: (e: KeyboardEvent) => void;
  description: string;
}

/**
 * 全局快捷键注册。修饰符精确匹配：未要求的修饰键若被按下则不算命中
 * （否则 Ctrl+K 时会误触发所有无 ctrl 的快捷键）。
 */
export function useKeyboardShortcuts(scDefs: Shortcut[]) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      for (const sc of scDefs) {
        const keyMatch = e.key.toLowerCase() === sc.key.toLowerCase();
        const ctrl = e.ctrlKey || e.metaKey;
        const shift = e.shiftKey;
        const alt = e.altKey;
        const ctrlMatch = sc.ctrl ? ctrl : !ctrl;
        const shiftMatch = sc.shift ? shift : !shift;
        const altMatch = sc.alt ? alt : !alt;
        if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
          e.preventDefault();
          sc.handler(e);
          return;
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [scDefs]);
}
