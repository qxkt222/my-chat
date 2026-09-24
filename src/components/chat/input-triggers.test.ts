// components/chat/input-triggers.test.ts — 输入触发判定的回归测试

import { describe, it, expect } from "vitest";
import { detectChainTrigger, detectMentionQuery } from "./input-triggers";

describe("detectChainTrigger", () => {
  it("空格后的行尾 .. 触发，并去掉触发词", () => {
    expect(detectChainTrigger("帮我翻译一下 ..")).toEqual({
      triggered: true,
      stripped: "帮我翻译一下",
    });
  });

  it("整段只有 .. 也触发（空输入起手）", () => {
    expect(detectChainTrigger("..")).toEqual({ triggered: true, stripped: "" });
  });

  it("句中或无空格的 .. 不触发", () => {
    expect(detectChainTrigger("上面..下面")).toEqual({ triggered: false, stripped: "上面..下面" });
    expect(detectChainTrigger("a..b")).toEqual({ triggered: false, stripped: "a..b" });
    expect(detectChainTrigger("正常一句话")).toEqual({ triggered: false, stripped: "正常一句话" });
  });
});

describe("detectMentionQuery", () => {
  it("行尾 @ 后面的内容作为搜索词", () => {
    expect(detectMentionQuery("你好 @ab")).toBe("ab");
  });

  it("刚敲下 @（后面空）返回空串——菜单要弹全部候选，不是关掉", () => {
    expect(detectMentionQuery("你好 @")).toBe("");
  });

  it("没有 @ 返回 null（与空串语义不同）", () => {
    expect(detectMentionQuery("普通输入")).toBeNull();
    expect(detectMentionQuery("@ 后面有空格的 has空间")).toBeNull();
  });
});
