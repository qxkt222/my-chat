// lib/budget-warning.ts — 接近上下文预算上限时主动提醒
//
// 需求:「快要超预算的时候再跟我说吧。」
//   · 未到阈值不打扰(不删历史、不弹窗);
//   · 达到 85% 提醒一次;同一会话同档位 5 分钟内不重复;
//   · 85% 档提醒过后,再跨过 95% 阈值可立即再提醒一次(升级提醒);
//   · 超过 100% 走「超限」档,文案明确「历史已保留、未裁剪」。
//
// 本模块只做判定 + 节流 + 弹 Toast,不参与裁剪、不阻塞发送、不抛错。
// 阈值常量只在本文件定义,三条发送链路统一调用 maybeWarnBudget()。

import { showToast } from "@/components/ui/Toast";
import { t } from "@/lib/i18n";

/** 首次提醒阈值:达到即提醒(85%) */
export const BUDGET_WARN_RATIO = 0.85;
/** 升级提醒阈值:85% 档已提醒后,跨过 95% 可立即再提醒一次 */
export const BUDGET_ESCALATE_RATIO = 0.95;
/** 同一会话同档位的最短提醒间隔(5 分钟) */
export const BUDGET_WARN_COOLDOWN_MS = 5 * 60 * 1000;

export type BudgetWarningLevel = "warn" | "over";

/** 已提醒档位:1 = 85% 档,2 = 95% 档,3 = 超限档 */
export type BudgetWarningRank = 1 | 2 | 3;

export interface BudgetWarningState {
  /** 上次提醒时间戳(ms) */
  lastAt: number;
  /** 已提醒过的最高档位 */
  level: BudgetWarningRank;
}

/** 当前占比对应档位;0 = 无需提醒 */
function rankFor(used: number, budget: number): 0 | BudgetWarningRank {
  if (!(budget > 0) || !Number.isFinite(used)) return 0;
  const ratio = used / budget;
  if (ratio > 1) return 3; // 超限
  if (ratio >= BUDGET_ESCALATE_RATIO) return 2; // 95% 升级档
  if (ratio >= BUDGET_WARN_RATIO) return 1; // 85% 首档
  return 0;
}

/**
 * 纯判定:是否该提醒、提醒哪一档。
 * @param used   已用 token(shrinkMessages 结果的 total)
 * @param budget 预算上限(shrinkMessages 结果的 budget)
 * @param state  该会话上一次提醒的状态(无则从未提醒)
 * @param now    当前时间(测试注入)
 * @returns "warn" | "over" | null
 */
export function shouldWarn(
  used: number,
  budget: number,
  state: BudgetWarningState | undefined,
  now: number = Date.now()
): BudgetWarningLevel | null {
  const rank = rankFor(used, budget);
  if (rank === 0) return null;

  if (state) {
    // 跨过更高阈值 → 允许立即提醒(85 → 95 或 85 → 超限)
    const crossedHigher = rank > state.level;
    const cooledDown = now - state.lastAt >= BUDGET_WARN_COOLDOWN_MS;
    if (!crossedHigher && !cooledDown) return null;
  }

  return rank === 3 ? "over" : "warn";
}

/** 每会话节流状态(会话 id → 上次提醒时间/档位) */
const warningStates = new Map<string, BudgetWarningState>();

/**
 * 发送链路统一入口:拿到 shrinkMessages 的 total/budget 后调用。
 * 绝不抛错、绝不阻塞发送。
 */
export function maybeWarnBudget(
  convId: string,
  used: number,
  budget: number,
  now: number = Date.now()
): void {
  try {
    if (!convId) return;
    const state = warningStates.get(convId);
    const level = shouldWarn(used, budget, state, now);
    if (!level) return;

    const rank = rankFor(used, budget) as BudgetWarningRank;
    warningStates.set(convId, {
      lastAt: now,
      level: Math.max(state?.level ?? 0, rank) as BudgetWarningRank,
    });

    if (level === "over") {
      showToast("error", t("chat.budgetOver", { used, budget }));
    } else {
      const pct = Math.round((used / budget) * 100);
      showToast("info", t("chat.budgetNear", { pct, used, budget }));
    }
  } catch {
    // 提醒只是锦上添花:任何异常都不能影响发送
  }
}

/** 仅测试用:清空节流状态 */
export function resetBudgetWarningForTests(): void {
  warningStates.clear();
}
