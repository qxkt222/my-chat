// @vitest-environment jsdom
//
// i18n 插值回归（T-137/T-138）：
//   - 替换值里的 $& / $' / $` / $$ 不能被 String.replace 当成替换模式；
//   - useT 必须随 locale 订阅刷新（t 仅用于非 React 场景）。

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { t, useT } from "./index";
import { useAppConfigStore } from "@/stores/useAppConfigStore";

beforeEach(() => {
  useAppConfigStore.setState({ locale: "zh" });
});

describe("i18n 插值", () => {
  it("t(): 替换值含 $& / $' / $` / $$ 时按字面显示", () => {
    const title = "A$&B$'C$`D$$E";
    const out = t("sidebar.confirmDelete", { title });
    expect(out).toContain(title);
    expect(out).not.toContain("{title}");
    // 旧实现会把这几个模式吃掉：$& → {title}，$` → 前缀
    expect(out).not.toContain("A{title}B");
  });

  it("useT(): 同样按字面插值，不解析 $ 模式", () => {
    const { result } = renderHook(() => useT());
    const out = result.current("sidebar.confirmDelete", { title: "A$&B" });
    expect(out).toContain("A$&B");
  });

  it("useT() 随 locale 切换返回新文案（T-138 的 hook 侧契约）", () => {
    const { result } = renderHook(() => useT());
    expect(result.current("error.title")).toBe("出错了");

    act(() => {
      useAppConfigStore.getState().setLocale("en");
    });

    expect(result.current("error.title")).toBe("Something went wrong");
  });
});
