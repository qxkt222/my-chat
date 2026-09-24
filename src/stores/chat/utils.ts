// stores/chat/utils.ts — 从 useChatStore 抽出的通用工具与常量
//
// 这组东西原本占着 store 文件开头的 12 行，而且与 store 状态毫无关系：
// 一个是 uuid 薄封装、一个是时间戳、三个是 localStorage 的 key 与阈值。

/** 消息 id（crypto.randomUUID 的薄封装，便于将来换 id 策略） */
export function msgId(): string {
  return crypto.randomUUID();
}

/** 统一的时间戳格式（ISO 字符串） */
export function nowISO(): string {
  return new Date().toISOString();
}

/** 工作模式自动记忆(记忆卡):开关 + 阈值(距上次摘要新增消息数) */
export const WORK_SUMMARIZE_KEY = "work_auto_summarize";
export const WORK_SUMMARIZE_THRESHOLD = 15;
/** 临时会话(免记忆):开关——开启时本次会话完全不读写记忆 */
export const WORK_TEMP_MODE_KEY = "work_temp_mode";
