// lib/prefs.ts — UI 偏好持久化（localStorage）
//
// 背景（2026-10-23）：设置 → 数据 → 备份目录原先只活在组件 state 里，
// 每次重开设置页 / 重启应用都要重新输入路径。这里把「备份目录」这一个偏好
// 收进一个独立小模块，组件不再直接碰 localStorage。
//
// 两条设计约束，都来自用户的明确要求：
//   1. 一定要能删。写入空 / 纯空白 = **删除 key**，而不是存一个空串。
//      否则错误的旧路径会永远粘着：用户清空输入框后，下次挂载又把旧值读回来，
//      看上去「删不掉」。
//   2. 绝不因为存储不可用而崩。隐私模式 / 配额满 / 非浏览器测试环境下
//      localStorage 的读写都可能抛异常；偏好丢失是可接受的降级，
//      设置页不能因此白屏。

/** 备份目录在 localStorage 里的 key。改动即等于让所有老用户丢配置，勿动。 */
export const BACKUP_DIR_KEY = "my-chat.backupDir";

/** 取 localStorage；不存在或访问就抛（隐私模式）时返回 null。 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 读取已保存的备份目录；没存过 / 存储不可用 → 空串（调用方回落到默认目录）。 */
export function readStoredBackupDir(): string {
  const s = storage();
  if (!s) return "";
  try {
    return s.getItem(BACKUP_DIR_KEY) ?? "";
  } catch {
    // 有意静默：读失败等价于「没存过」
    return "";
  }
}

/**
 * 保存备份目录。
 * 非空 → 存 trim 后的值；空 / 纯空白 → **删除 key**（“清除”语义）。
 * 任何存储异常都被吞掉：偏好写失败不影响当前这次操作。
 */
export function writeStoredBackupDir(value: string): void {
  const s = storage();
  if (!s) return;
  const trimmed = value.trim();
  try {
    if (trimmed) {
      s.setItem(BACKUP_DIR_KEY, trimmed);
    } else {
      s.removeItem(BACKUP_DIR_KEY);
    }
  } catch {
    // 有意静默：配额满 / 隐私模式
  }
}
