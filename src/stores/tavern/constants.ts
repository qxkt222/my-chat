// stores/tavern/constants.ts — 酒馆模式的持久化 key 与阈值（从 useTavernStore.ts 拆出）
//
// 都是 localStorage 的 key 与行为阈值；单独放一处，改阈值时不必在 1600 行里翻。

/** 内置翻译:目标语言 + 自动翻译开关(持久化到 localStorage) */
export const TARGET_KEY = "tavern_translate_target";
export const AUTO_KEY = "tavern_auto_translate";
export const SUMMARIZE_KEY = "tavern_auto_summarize";

/** 自动摘要阈值已统一到 lib/summarize.ts（SUMMARIZE_THRESHOLD，三条链路共用一个数） */

/** 自动滑卡开关 key + 最短长度阈值(酒馆 Auto-Swipe:回复太短自动换一版) */
export const AUTOSWIPE_KEY = "tavern_auto_swipe";
export const AUTOSWIPE_MIN_LEN = 80;
