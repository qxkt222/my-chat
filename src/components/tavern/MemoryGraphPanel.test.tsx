// @vitest-environment jsdom
//
// MemoryGraphPanel 关闭入口回归(真机反馈:图谱面板打开后没有关闭入口)。
//   - 传入 onClose 时标题栏渲染关闭按钮,点击恰好回调一次;
//   - 不传 onClose 时不渲染按钮(向后兼容:其他调用方无需改动)。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryGraphPanel } from "./MemoryGraphPanel";
import { t } from "@/lib/i18n";
import type { RelationGraph } from "@/lib/memory-graph";

afterEach(cleanup);

const emptyGraph: RelationGraph = { nodes: [], edges: [] };

describe("MemoryGraphPanel 关闭按钮", () => {
  it("传入 onClose 时渲染按钮,点击调用一次", () => {
    const onClose = vi.fn();
    render(<MemoryGraphPanel graph={emptyGraph} onClose={onClose} />);

    const btn = screen.getByLabelText(t("graph.close"));
    expect(btn.tagName).toBe("BUTTON");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("不传 onClose 时不渲染关闭按钮", () => {
    render(<MemoryGraphPanel graph={emptyGraph} />);
    expect(screen.queryByLabelText(t("graph.close"))).toBeNull();
  });
});
