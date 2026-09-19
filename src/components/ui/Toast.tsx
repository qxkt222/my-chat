// components/ui/Toast.tsx — Toast notification system（规范 5.10：右下堆叠，白底，左侧 3px 色条）

import { useState, useEffect, useCallback } from "react";
import { X } from "lucide-react";

interface ToastMessage {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}

let toastListeners: ((toast: ToastMessage) => void)[] = [];
let toastId = 0;

export function showToast(type: ToastMessage["type"], message: string) {
  const toast: ToastMessage = { id: String(++toastId), type, message };
  toastListeners.forEach((fn) => fn(toast));
}

const BAR_COLORS: Record<ToastMessage["type"], string> = {
  success: "#27AE60",
  error: "#E74C3C",
  info: "#1A6FB5",
};

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((toast: ToastMessage) => {
    setToasts((prev) => [...prev, toast]);
    // 自动消失（6s）
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toast.id)), 6000);
  }, []);

  useEffect(() => {
    toastListeners.push(addToast);
    return () => {
      toastListeners = toastListeners.filter((l) => l !== addToast);
    };
  }, [addToast]);

  const remove = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <div className="fixed bottom-10 right-3 z-[100] flex flex-col gap-2 items-end">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="relative flex items-center gap-2 pl-4 pr-3 py-2.5 bg-white text-[#2C3E50] rounded-md shadow-md max-w-[350px] text-sm animate-fade-in overflow-hidden"
        >
          {/* 左侧 3px 色条 */}
          <span
            className="absolute left-0 top-0 bottom-0 w-[3px]"
            style={{ background: BAR_COLORS[t.type] }}
          />
          <span className="flex-1 text-xs">{t.message}</span>
          <button
            onClick={() => remove(t.id)}
            className="p-0.5 rounded hover:bg-[#E8ECF0] shrink-0 text-[#8899A6]"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
