// lib/prefs.test.ts — UI 偏好持久化（目前只有备份目录）
//
// 钉住的核心事实（用户需求：备份路径要记住，且必须能删掉）：
//   1. 没存过 → 返回空串（界面回落到默认目录），不返回 null/undefined；
//   2. 存过 → 原样返回（不在读路径上 trim，避免读到写之前就存在的脏值被悄悄改写）；
//   3. localStorage 不可用（隐私模式 / 非浏览器环境）→ 读不抛、返回空串：
//      偏好丢失是可接受的降级，不能让设置页白屏；
//   4. 写入非空值 → 存 trim 后的值；
//   5. **写入空/空白 → 删除 key**，而不是存空串。这是用户点名的「删除键」：
//      只存空串的话，错误的旧路径会一直粘着，用户改不掉。

import { describe, it, expect, afterEach, vi } from "vitest";
import { BACKUP_DIR_KEY, readStoredBackupDir, writeStoredBackupDir } from "./prefs";

/** 最小 localStorage 桩：够 prefs 用，且能记录 removeItem 调用 */
function makeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: vi.fn((k: string) => (map.has(k) ? (map.get(k) as string) : null)),
    setItem: vi.fn((k: string, v: string) => {
      map.set(k, v);
    }),
    removeItem: vi.fn((k: string) => {
      map.delete(k);
    }),
  };
}

const original = globalThis.localStorage;

afterEach(() => {
  if (original === undefined) {
    // @ts-expect-error 测试环境清理
    delete globalThis.localStorage;
  } else {
    globalThis.localStorage = original;
  }
});

describe("readStoredBackupDir", () => {
  it("没有存过 → 空串", () => {
    globalThis.localStorage = makeStorage() as unknown as Storage;
    expect(readStoredBackupDir()).toBe("");
  });

  it("存过 → 原样返回（包括前后空格）", () => {
    globalThis.localStorage = makeStorage({
      [BACKUP_DIR_KEY]: "  D:/backups  ",
    }) as unknown as Storage;
    expect(readStoredBackupDir()).toBe("  D:/backups  ");
  });

  it("localStorage 读取抛异常（隐私模式）→ 不崩，返回空串", () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    } as unknown as Storage;
    expect(() => readStoredBackupDir()).not.toThrow();
    expect(readStoredBackupDir()).toBe("");
  });

  it("localStorage 根本不存在（Node / 禁用）→ 不崩，返回空串", () => {
    // @ts-expect-error 模拟没有 localStorage 的环境
    delete globalThis.localStorage;
    expect(() => readStoredBackupDir()).not.toThrow();
    expect(readStoredBackupDir()).toBe("");
  });

  it("key 用 my-chat.backupDir（改 key 等于让所有老用户丢配置）", () => {
    expect(BACKUP_DIR_KEY).toBe("my-chat.backupDir");
  });
});

describe("writeStoredBackupDir", () => {
  it("非空 → 存 trim 后的值", () => {
    const s = makeStorage();
    globalThis.localStorage = s as unknown as Storage;
    writeStoredBackupDir("  D:/backups  ");
    expect(s.setItem).toHaveBeenCalledWith(BACKUP_DIR_KEY, "D:/backups");
    expect(s.map.get(BACKUP_DIR_KEY)).toBe("D:/backups");
  });

  it("空串 → 删除 key（不是存空串）", () => {
    const s = makeStorage({ [BACKUP_DIR_KEY]: "D:/old" });
    globalThis.localStorage = s as unknown as Storage;
    writeStoredBackupDir("");
    expect(s.removeItem).toHaveBeenCalledWith(BACKUP_DIR_KEY);
    expect(s.map.has(BACKUP_DIR_KEY)).toBe(false);
  });

  it("纯空白 → 删除 key", () => {
    const s = makeStorage({ [BACKUP_DIR_KEY]: "D:/old" });
    globalThis.localStorage = s as unknown as Storage;
    writeStoredBackupDir("   \t  ");
    expect(s.map.has(BACKUP_DIR_KEY)).toBe(false);
  });

  it("写入抛异常（配额 / 隐私模式）→ 不崩", () => {
    globalThis.localStorage = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    } as unknown as Storage;
    expect(() => writeStoredBackupDir("D:/backups")).not.toThrow();
    expect(() => writeStoredBackupDir("")).not.toThrow();
  });

  it("写入后再读，能读回 trim 后的值（往返一致）", () => {
    globalThis.localStorage = makeStorage() as unknown as Storage;
    writeStoredBackupDir("  D:/backups  ");
    expect(readStoredBackupDir()).toBe("D:/backups");
  });
});
