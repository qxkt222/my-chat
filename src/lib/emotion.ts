// lib/emotion.ts — 角色表情图片(酒馆 Character Expressions)
//
// 酒馆表情数据存在角色卡 data.extensions.emotions:
//   { emotions: { "happy": { name: "开心", source: "..." }, "sad": {...} } }
// 我们按情绪关键词(中英)匹配当前回复内容 → 显示对应表情图(存在
// %APPDATA%\com.my-chat\characters\avatars\emotions\{cardId}\{emotionKey}.png);
// 匹配不到回退角色默认头像。

import type { CharacterCard } from "@/types";
import { readFile } from "./tauri";

/** 情绪键 → 触发关键词(中英;默认全部小写匹配) */
const EMOTION_KEYWORDS: Record<string, string[]> = {
  happy: ["开心", "高兴", "愉快", "欢笑", "笑", "happy", "joy", "laugh", "grin", "smile", "cheer"],
  sad: ["难过", "伤心", "悲伤", "哭泣", "哭", "泪", "sad", "cry", "tears", "sob", "weep"],
  angry: ["生气", "愤怒", "恼火", "怒", "angry", "mad", "furious", "rage", "growl", "annoyed"],
  surprised: ["惊讶", "吃惊", "震惊", "surprised", "shock", "startled", "gasp", "wow"],
  shy: ["害羞", "脸红", "羞涩", "shy", "blush", "embarrassed"],
  love: ["喜欢", "爱", "love", "affection", "fond"],
  scared: ["害怕", "恐惧", "惊恐", "scared", "fear", "terrified", "afraid", "tremble"],
  neutral: ["平静", "淡然", "neutral", "calm", "relaxed"],
};

/**
 * 检测一段回复文本命中哪个情绪。
 * 返回情绪键(如 "happy"),无命中或卡无该情绪图返回 null。
 */
export function detectEmotion(content: string, card: CharacterCard): string | null {
  if (!card.extensions?.emotions) return null;
  const emotions = card.extensions.emotions as Record<string, unknown>;
  const keys = Object.keys(emotions);
  if (keys.length === 0) return null;

  const lower = content.toLowerCase();
  for (const key of keys) {
    const kws = EMOTION_KEYWORDS[key] || [];
    // 优先精确情绪名匹配(酒馆 emotions 的 key 本身如 happy/sad)
    const keyMatch = key.toLowerCase();
    if (keyMatch.length > 2 && lower.includes(keyMatch)) return key;
    for (const kw of kws) {
      if (lower.includes(kw)) return key;
    }
  }
  return null;
}

/** 表情图绝对路径(无则 null);表情图存 avatars/emotions/{cardId}/{emotionKey}.png */
export function emotionImagePath(card: CharacterCard, emotionKey: string): string | null {
  if (!card.extensions?.emotions) return null;
  const emotions = card.extensions.emotions as Record<string, unknown>;
  if (!emotions[emotionKey]) return null;
  const dir = card.avatarPath.replace(/[\\/][^\\/]+$/, ""); // avatars 目录
  if (!dir || dir === card.avatarPath) return null;
  return `${dir}/emotions/${card.id}/${emotionKey}.png`;
}

/** 表情图文件是否存在(异步,经 Rust 读文件判断磁盘存在;缺失时回退角色头像,避免破图) */
export async function emotionImageExists(path: string | null): Promise<boolean> {
  if (!path) return false;
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** 卡的情绪键列表 */
export function emotionKeys(card: CharacterCard): string[] {
  if (!card.extensions?.emotions) return [];
  return Object.keys(card.extensions.emotions as Record<string, unknown>);
}
