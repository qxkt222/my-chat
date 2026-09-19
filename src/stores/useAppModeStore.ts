import { create } from "zustand";

/** 双模式:工作(干活/普通聊天)/ 酒馆(独立创作空间)——会话完全隔离 */
export type AppMode = "work" | "tavern";
/** 酒馆子模式:角色扮演(默认)/ 推演(故事推演,独立会话) */
export type TavernSubMode = "rp" | "simulate";

const MODE_KEY = "app_mode";
const SUB_MODE_KEY = "tavern_sub_mode";

interface AppModeState {
  mode: AppMode;
  /** 酒馆内的子模式:角色扮演 / 推演(持久化,记住上次选择) */
  tavernSubMode: TavernSubMode;
  setMode: (m: AppMode) => void;
  setTavernSubMode: (m: TavernSubMode) => void;
}

/** 顶层模式切换:工作模式 = 现有完整应用;酒馆模式 = 创作空间(角色扮演 / 故事推演) */
export const useAppModeStore = create<AppModeState>((set) => ({
  mode: (localStorage.getItem(MODE_KEY) as AppMode) || "work",
  tavernSubMode: (localStorage.getItem(SUB_MODE_KEY) as TavernSubMode) || "rp",
  setMode: (m) => {
    localStorage.setItem(MODE_KEY, m);
    set({ mode: m });
  },
  setTavernSubMode: (m) => {
    localStorage.setItem(SUB_MODE_KEY, m);
    set({ tavernSubMode: m });
  },
}));
