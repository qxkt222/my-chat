import { create } from "zustand";

/** 单次请求的缓存统计 */
export interface CacheRecord {
  ts: number;
  model: string;
  hit: number;
  miss: number;
}

const KEY = "cache_stats";
const MAX = 100;

interface CacheStatsState {
  records: CacheRecord[];
  /** 记录一次请求的命中/未命中 */
  recordCache: (model: string, hit: number, miss: number) => void;
  clear: () => void;
  /** 平均命中率(0-100;无数据返回 null) */
  avgRate: () => number | null;
}

/** DeepSeek prompt cache 诊断:记录每次请求命中率(验证三段式优化效果) */
export const useCacheStatsStore = create<CacheStatsState>((set, get) => ({
  records: (() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "[]") as CacheRecord[];
    } catch {
      return [];
    }
  })(),

  recordCache: (model, hit, miss) => {
    if (hit + miss <= 0) return;
    const records = [...get().records, { ts: Date.now(), model, hit, miss }].slice(-MAX);
    localStorage.setItem(KEY, JSON.stringify(records));
    set({ records });
  },

  clear: () => {
    localStorage.removeItem(KEY);
    set({ records: [] });
  },

  avgRate: () => {
    const r = get().records;
    if (r.length === 0) return null;
    const hit = r.reduce((s, x) => s + x.hit, 0);
    const miss = r.reduce((s, x) => s + x.miss, 0);
    if (hit + miss === 0) return null;
    return Math.round((hit / (hit + miss)) * 100);
  },
}));
