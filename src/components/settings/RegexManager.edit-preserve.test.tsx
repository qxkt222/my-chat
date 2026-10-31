// @vitest-environment jsdom
//
// T-099 — 编辑正则规则必须保留 flags / enabled。
//
// 旧实现保存时固定写 enabled:true、且不带 flags:
//   编辑一条带 `i` 的**已禁用**规则 → 被静默启用,大小写匹配行为也变了。
// 本测试构造 flags="i"、enabled=false、placement=[2] 的规则,编辑 pattern 后
// 断言这三个字段原样保留。

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

const mock = vi.hoisted(() => ({
  saveSetting: vi.fn(async (_key: string, _value: string) => undefined),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    dbSaveSetting: mock.saveSetting,
    logDiag: vi.fn(),
  };
});

import { RegexManager } from "./RegexManager";
import { useSettingsStore } from "@/stores/useSettingsStore";
import type { RegexRule } from "@/lib/regex-format";

const RULE: RegexRule = {
  id: "user-keep",
  name: "带i规则",
  pattern: "abc",
  replacement: "x",
  enabled: false,
  flags: "i",
  placement: [2],
};

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ regexRules: [{ ...RULE }] });
});

afterEach(cleanup);

describe("T-099 编辑保留 flags/enabled", () => {
  it("编辑带 i 的禁用规则后，flags/enabled/placement 不变", async () => {
    render(<RegexManager />);

    const nameEl = screen.getByText("带i规则");
    const row = nameEl.parentElement as HTMLElement;
    // 行内按钮顺序：查看/编辑(Eye) → 删除(Trash)
    fireEvent.click(within(row).getAllByRole("button")[0] as HTMLElement);

    const pattern = screen.getByPlaceholderText("正则 pattern") as HTMLInputElement;
    fireEvent.change(pattern, { target: { value: "abcd" } });
    fireEvent.click(screen.getByText("保存", { selector: "button" }));

    await waitFor(() => expect(mock.saveSetting).toHaveBeenCalled());
    const saved = useSettingsStore.getState().regexRules.find((r) => r.id === "user-keep");
    expect(saved?.pattern).toBe("abcd");
    expect(saved?.flags).toBe("i");
    expect(saved?.enabled).toBe(false);
    expect(saved?.placement).toEqual([2]);
  });
});
