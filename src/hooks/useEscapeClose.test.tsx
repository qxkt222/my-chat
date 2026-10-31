// @vitest-environment jsdom
//
// T-102 — Esc 层级栈。
//
// 旧实现每个弹层各挂一个 window keydown(且不阻断传播):
//   SettingsDialog 开着时再打开 ModelWizard,一次 Esc 会同时关掉两层,
//   事件继续冒泡还会触发 App 的「停止生成」全局快捷键。
//
// 契约:
//   1. 只有栈顶(最后挂载/激活)的弹层消费 Esc;
//   2. 事件被 stopImmediatePropagation 阻断,全局 bubble 监听收不到;
//   3. 弹层关闭后,下一次 Esc 交给下一层。

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useEscapeClose } from "./useEscapeClose";

afterEach(cleanup);

function Layer({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose);
  return null;
}

describe("useEscapeClose 层级栈", () => {
  it("一次 Esc 只关最上层,第二次才轮到下层", () => {
    const closed: string[] = [];
    const { rerender } = render(
      <>
        <Layer onClose={() => closed.push("outer")} />
        <Layer onClose={() => closed.push("inner")} />
      </>
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(closed).toEqual(["inner"]);

    // 上层关闭（卸载）后，下层接管
    rerender(<Layer onClose={() => closed.push("outer")} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closed).toEqual(["inner", "outer"]);
  });

  it("弹层消费 Esc 时阻断全局「停止生成」bubble 监听", () => {
    const globalStop = vi.fn();
    window.addEventListener("keydown", globalStop);
    const onClose = vi.fn();
    render(<Layer onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(globalStop).not.toHaveBeenCalled();
    window.removeEventListener("keydown", globalStop);
  });

  it("非 Escape 键不触发关闭", () => {
    const onClose = vi.fn();
    render(<Layer onClose={onClose} />);
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
