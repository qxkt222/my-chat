import { create } from "zustand";

export type ViewMode = "chat" | "translation" | "drawing";

interface ViewState {
  view: ViewMode;
  setView: (v: ViewMode) => void;
}

/** 主工作区视图切换：对话 / 翻译工作区 / 绘图工作区 */
export const useViewStore = create<ViewState>((set) => ({
  view: "chat",
  setView: (v) => set({ view: v }),
}));
