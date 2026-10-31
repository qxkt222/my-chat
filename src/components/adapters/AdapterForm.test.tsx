// @vitest-environment jsdom
// components/adapters/AdapterForm.test.tsx — 自定义 Headers 的 JSON 校验契约
//
// T-135:旧实现 JSON.parse 失败时静默回退成默认 Content-Type，用户输入丢失且
// 无任何提示。现在：解析失败阻止保存、提示行号、保留原文；合法 JSON 原样生效。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { AdapterForm } from "./AdapterForm";

afterEach(() => cleanup());

function setup() {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(
    <AdapterForm initial={{ mode: "medium", name: "T" }} onSave={onSave} onCancel={onCancel} />
  );
  const textarea = screen.getByLabelText("Custom Headers (JSON)") as HTMLTextAreaElement;
  const save = screen.getByRole("button", { name: /Save Template/i });
  return { onSave, textarea, save };
}

describe("AdapterForm Custom Headers JSON", () => {
  it("非法 JSON：拒绝保存、提示行号、保留原文", () => {
    const { onSave, textarea, save } = setup();
    const bad = '{\n  "Content-Type": "application/json",\n  bad\n}';

    fireEvent.change(textarea, { target: { value: bad } });
    fireEvent.click(save);

    expect(onSave).not.toHaveBeenCalled();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Invalid headers JSON/);
    expect(alert.textContent).toMatch(/line 3/);
    // 输入框内容原样保留，用户不用重打
    expect(textarea.value).toBe(bad);
  });

  it("合法 JSON 但不是对象：同样拒绝保存并提示", () => {
    const { onSave, textarea, save } = setup();

    fireEvent.change(textarea, { target: { value: '["not","an","object"]' } });
    fireEvent.click(save);

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/must be a JSON object/);
  });

  it("合法 JSON 对象：保存生效且错误提示消失", () => {
    const { onSave, textarea, save } = setup();

    // 先制造一次错误，再改成合法值 —— 提示应随输入清除
    fireEvent.change(textarea, { target: { value: "{bad" } });
    fireEvent.click(save);
    expect(screen.getByRole("alert")).toBeTruthy();

    fireEvent.change(textarea, { target: { value: '{"Authorization":"Bearer x"}' } });
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ request_headers: { Authorization: "Bearer x" } })
    );
  });
});
