// @vitest-environment jsdom
//
// ConfirmDialog 的组件测试。选它当首测的理由：它是**替代原生弹窗**的那一层
// （Tauri 的 WebView2 禁用了 window.confirm/prompt/alert），一旦它自己坏了，
// 全应用的「删除确认」「[ask] 提问」「软重置」会一起静默失效 —— 而那种失效
// 是看不见的（按钮点了没反应，不像报错）。

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { askConfirm, askPrompt, ConfirmDialogHost } from "./ConfirmDialog";

// 这个模块有**模块级**的 pending / listeners，测试间必须清干净
afterEach(cleanup);

/** 取弹层里的两个按钮；顺带断言它们真的渲染出来了 */
function buttons(): [HTMLElement, HTMLElement] {
  const all = screen.getAllByRole("button");
  const cancel = all[0];
  const ok = all[1];
  if (!cancel || !ok) throw new Error("确认弹层应渲染出「取消」「确定」两个按钮");
  return [cancel, ok];
}

describe("ConfirmDialog", () => {
  it("askConfirm：点「确定」resolve(true)", async () => {
    render(<ConfirmDialogHost />);

    let p!: Promise<boolean>;
    act(() => {
      p = askConfirm("删掉这条会话？");
    });

    const [, ok] = buttons();
    fireEvent.click(ok);
    await expect(p).resolves.toBe(true);
  });

  it("askConfirm：点「取消」resolve(false)", async () => {
    render(<ConfirmDialogHost />);

    let p!: Promise<boolean>;
    act(() => {
      p = askConfirm("删掉这条会话？");
    });

    const [cancel] = buttons();
    fireEvent.click(cancel);
    await expect(p).resolves.toBe(false);
  });

  it("askPrompt：输入后点「确定」拿到输入值", async () => {
    render(<ConfirmDialogHost />);

    let p!: Promise<string | null>;
    act(() => {
      p = askPrompt("给它起个名字", "默认名");
    });

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "新名字" } });

    const [, ok] = buttons();
    fireEvent.click(ok);
    await expect(p).resolves.toBe("新名字");
  });

  it("Escape 取消：confirm 走 false（与点遮罩一致）", async () => {
    render(<ConfirmDialogHost />);

    let p!: Promise<boolean>;
    act(() => {
      p = askConfirm("？");
    });

    buttons(); // 等弹层真的渲染出来再按键
    fireEvent.keyDown(window, { key: "Escape" });
    await expect(p).resolves.toBe(false);
  });
});
