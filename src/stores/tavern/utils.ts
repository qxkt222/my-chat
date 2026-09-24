// stores/tavern/utils.ts — 从 useTavernStore.ts 拆出的通用小工具
//
// 拆出来的理由：这两个函数与 store 状态无关；它们留在 1600+ 行的 store 文件里，
// 只会让「这个文件到底负责什么」更难看清。

export function uuid(): string {
  return crypto.randomUUID();
}

export function nowISO(): string {
  return new Date().toISOString();
}
