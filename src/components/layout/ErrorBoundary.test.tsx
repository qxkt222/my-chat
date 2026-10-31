// @vitest-environment jsdom
//
// T-138 回归：ErrorBoundary 的兜底文案必须随语言切换刷新。
// 旧实现用裸 t()，它读 getState 不订阅 locale —— 切到英文后错误页仍是中文。

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";
import { useAppConfigStore } from "@/stores/useAppConfigStore";

function Boom(): never {
  throw new Error("boom");
}

beforeEach(() => {
  useAppConfigStore.setState({ locale: "zh" });
  // React 会把被边界捕获的错误打到 console.error，测试里静音
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ErrorBoundary 文案随 locale 刷新", () => {
  it("切到英文后错误页标题与按钮文案都变英文", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByText("出错了")).toBeTruthy();
    expect(screen.getByText("重新加载")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();

    act(() => {
      useAppConfigStore.getState().setLocale("en");
    });

    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("Reload")).toBeTruthy();
    // 错误详情不随语言丢
    expect(screen.getByText("boom")).toBeTruthy();
  });
});
