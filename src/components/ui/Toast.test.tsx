// @vitest-environment jsdom
//
// Toast 的组件测试。选它当首测的理由：它是**用户唯一能看到的成功/失败反馈通道**，
// 而这套代码里有多处「操作失败但界面装作成功」的旧毛病（见审查报告 §4 #10）——
// 先把这个通道本身锁住，后续才敢把那些静默失败改成真的提示。

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { ToastContainer, showToast } from "./Toast";

afterEach(cleanup);

describe("Toast", () => {
  it("showToast 后容器渲染出消息", () => {
    render(<ToastContainer />);
    act(() => {
      showToast("success", "保存成功");
    });
    expect(screen.getByText("保存成功")).toBeTruthy();
  });

  it("三种类型都能各自入栈", () => {
    render(<ToastContainer />);
    act(() => {
      showToast("success", "a");
      showToast("error", "b");
      showToast("info", "c");
    });
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
    expect(screen.getByText("c")).toBeTruthy();
  });

  it("点 X 只移除那一条", () => {
    render(<ToastContainer />);
    act(() => {
      showToast("error", "要留下的");
      showToast("info", "要移除的");
    });

    const closeButtons = screen.getAllByRole("button");
    const second = closeButtons[1];
    if (!second) throw new Error("应有两条 toast，各带一个关闭按钮");
    fireEvent.click(second);

    expect(screen.queryByText("要移除的")).toBeNull();
    expect(screen.getByText("要留下的")).toBeTruthy();
  });
});
