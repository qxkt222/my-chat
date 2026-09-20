// @vitest-environment jsdom
//
// MessageRenderer 的第一个组件测试。选它当首测的理由：
//   1. 它在**每一条 AI 回复**上跑，是渲染层最热的一段；
//   2. 它刚因为「点外链把应用导航走」被改过（见审查报告 P1-5 / L8），
//      这里那条用例就是那次修复的回归闸门 —— 去掉 a 组件的定制它就会红。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MessageRenderer } from "./MessageRenderer";

// vitest 未开 globals，testing-library 不会自动清理 —— 显式来
afterEach(cleanup);

// openUrl 必须被 mock：真实现会去调 Tauri IPC，jsdom 里没有那层。
const { openUrlMock } = vi.hoisted(() => ({
  openUrlMock: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

describe("MessageRenderer", () => {
  beforeEach(() => {
    openUrlMock.mockClear();
  });

  it("渲染 markdown 正文与行内代码", () => {
    render(<MessageRenderer content={"普通文本 with `inline` code"} />);
    expect(screen.getByText(/普通文本/)).toBeTruthy();
    // 行内代码走 <code> 分支，不该被当成代码块包上语言标签栏
    expect(screen.getByText("inline")).toBeTruthy();
  });

  it("围栏代码块渲染出语言标签，且内容不是 [object Object]（高亮节点被保留）", () => {
    const { container } = render(<MessageRenderer content={"```ts\nconst a = 1;\n```"} />);
    expect(screen.getByText("ts")).toBeTruthy();

    const code = container.querySelector("code.language-ts");
    if (!code) throw new Error("应渲染出 code.language-ts");

    // ⚠️ 回归闸门：旧实现用 String(children)，高亮后 children 是元素数组，
    //    内容会变成 "[object Object], a = ,[object Object],;"。
    expect(code.textContent).toContain("const a = 1;");
    expect(code.textContent).not.toContain("[object Object]");

    // 另一面：高亮本身不能被丢掉（CodeBlock 以前只渲染纯文本字符串）
    expect(code.querySelector(".hljs-keyword")).toBeTruthy();
  });

  // ⚠️ L8 回归闸门：Tauri 的 webview 里点 <a> 会把应用界面本身导航走，
  //    所以 MessageRenderer 必须拦下默认导航、改调 openUrl。
  //    把 markdownComponents 里的 a 组件删掉，这条立刻红。
  it("点外链拦下默认导航并交给系统浏览器", () => {
    render(<MessageRenderer content={"[示例链接](https://example.com/x)"} />);
    const link = screen.getByText("示例链接");
    fireEvent.click(link);

    expect(openUrlMock).toHaveBeenCalledTimes(1);
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com/x");
  });
});
