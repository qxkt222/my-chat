// lib/budget-warning.test.ts — 预算接近上限时主动提醒(阈值 + 节流)
//
// 期望值全部按需求手算,不复算实现:
//   预算 1000:849(<85%) 不提醒;850(=85%) 提醒;1000(=100%) 仍走 85 档;
//   1001(>100%) 才走超限档。
//   冷却 5 分钟:299_999ms 内同档不重复;300_000ms 整可再提醒。
//   85 档提醒后,跨过 95%(950)可立即再提醒一次;跨过 100%(1200)直接超限档。
import { describe, it, expect, vi, beforeEach } from "vitest";

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ showToast }));
vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));

import {
  shouldWarn,
  maybeWarnBudget,
  resetBudgetWarningForTests,
  BUDGET_WARN_COOLDOWN_MS,
} from "./budget-warning";

const T0 = 1_000_000;

describe("shouldWarn 阈值", () => {
  it("预算非法(budget<=0)不提醒", () => {
    expect(shouldWarn(500, 0, undefined, T0)).toBe(null);
    expect(shouldWarn(500, -100, undefined, T0)).toBe(null);
  });

  it("低于 85% 不提醒", () => {
    expect(shouldWarn(0, 1000, undefined, T0)).toBe(null);
    expect(shouldWarn(849, 1000, undefined, T0)).toBe(null);
  });

  it("恰好 85% 开始提醒(warn 档)", () => {
    expect(shouldWarn(850, 1000, undefined, T0)).toBe("warn");
  });

  it("95% 与 100% 都仍是 warn 档(只有 >100% 才是 over)", () => {
    expect(shouldWarn(950, 1000, undefined, T0)).toBe("warn");
    expect(shouldWarn(1000, 1000, undefined, T0)).toBe("warn");
  });

  it("超过 100% 返回 over 档", () => {
    expect(shouldWarn(1001, 1000, undefined, T0)).toBe("over");
    expect(shouldWarn(3000, 1000, undefined, T0)).toBe("over");
  });
});

describe("shouldWarn 节流", () => {
  it("85 档提醒后 5 分钟内不重复", () => {
    const state = { lastAt: T0, level: 1 as const };
    expect(shouldWarn(900, 1000, state, T0 + 299_999)).toBe(null);
    expect(BUDGET_WARN_COOLDOWN_MS).toBe(300_000);
  });

  it("冷却满 5 分钟后可再次提醒", () => {
    const state = { lastAt: T0, level: 1 as const };
    expect(shouldWarn(900, 1000, state, T0 + 300_000)).toBe("warn");
  });

  it("85 档提醒后,跨过 95% 阈值可立即再提醒一次", () => {
    const state = { lastAt: T0, level: 1 as const };
    expect(shouldWarn(949, 1000, state, T0 + 1_000)).toBe(null);
    expect(shouldWarn(950, 1000, state, T0 + 1_000)).toBe("warn");
  });

  it("未跨新阈值时,降到更低档也不在冷却内重复", () => {
    const state = { lastAt: T0, level: 2 as const };
    expect(shouldWarn(860, 1000, state, T0 + 1_000)).toBe(null);
  });

  it("超限档同会话 5 分钟内只提醒一次,满 5 分钟可再提醒", () => {
    const state = { lastAt: T0, level: 3 as const };
    expect(shouldWarn(1200, 1000, state, T0 + 299_999)).toBe(null);
    expect(shouldWarn(1200, 1000, state, T0 + 300_000)).toBe("over");
  });

  it("从 85 档直接跨到超限档可立即提醒(over)", () => {
    const state = { lastAt: T0, level: 1 as const };
    expect(shouldWarn(1200, 1000, state, T0 + 1_000)).toBe("over");
  });
});

describe("maybeWarnBudget 接入(Toast + 每会话节流)", () => {
  beforeEach(() => {
    resetBudgetWarningForTests();
    showToast.mockClear();
  });

  it("同一会话冷却内只弹一次,不同会话各自独立", () => {
    maybeWarnBudget("conv-a", 900, 1000, T0);
    maybeWarnBudget("conv-a", 910, 1000, T0 + 1_000);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith("info", "chat.budgetNear");

    maybeWarnBudget("conv-b", 900, 1000, T0 + 1_000);
    expect(showToast).toHaveBeenCalledTimes(2);
  });

  it("超限档用 error Toast,不同文案 key", () => {
    maybeWarnBudget("conv-a", 1200, 1000, T0);
    expect(showToast).toHaveBeenCalledWith("error", "chat.budgetOver");
  });

  it("budget <= 0 不弹也不记录", () => {
    maybeWarnBudget("conv-a", 900, 0, T0);
    expect(showToast).not.toHaveBeenCalled();
    // 预算恢复后仍应在首次进入 85% 档时提醒(说明上面没占用状态)
    maybeWarnBudget("conv-a", 900, 1000, T0);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("resetBudgetWarningForTests 清空节流状态", () => {
    maybeWarnBudget("conv-a", 900, 1000, T0);
    maybeWarnBudget("conv-a", 900, 1000, T0 + 1_000);
    expect(showToast).toHaveBeenCalledTimes(1);
    resetBudgetWarningForTests();
    maybeWarnBudget("conv-a", 900, 1000, T0 + 2_000);
    expect(showToast).toHaveBeenCalledTimes(2);
  });
});
