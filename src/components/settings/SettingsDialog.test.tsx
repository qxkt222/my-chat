// @vitest-environment jsdom
//
// SettingsDialog 的「能不能退出」测试。
//
// 为什么专门测这个（2026-09-25 开发者报错）：
//   原话 ——「点进提示词预设等选项之后退出选项会消失，导致不管怎么按都无法退出返还到原来界面」。
//   这是一个**逃生通道**问题：弹窗只要有一条退路断了，用户就被关在里面，
//   而这类失效在界面上没有报错，只能靠结构化断言钉住。
//
// 本文件钉三件事：
//   1. 三条退路（底部「取消」/ 右上角 X / Esc）必须都在，且真的能关；
//   2. 预设展开后，展开区自己必须有一个可点的「收起」按钮（内置预设没有「保存」，
//      所以那个 X 是它唯一的退路，绝不能被条件分支漏渲染）；
//   3. 列表很长时（例如导入了大预设包）仍能展开并收起。
//
// ⚠️ 口径声明（重要）：jsdom 不做真实排版，元素高度恒为 0。
//    所以这里断言的是**结构可达性**（按钮存在、在 DOM 内、可点、点了真收起），
//    **不是像素位置**。像素位置由 flex/overflow 布局约束保证，本文件不声称证明它。

import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { SettingsDialog } from "./SettingsDialog";
import { useCharacterStore } from "@/stores/useCharacterStore";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { useTavernStore } from "@/stores/useTavernStore";
import { ToastContainer } from "@/components/ui/Toast";
import type { PromptPreset } from "@/types";

afterEach(cleanup);

function mkPreset(id: string, name: string, isPreset: boolean, template: string): PromptPreset {
  return {
    id,
    name,
    is_preset: isPreset,
    description: isPreset ? "内置只读" : "可编辑",
    template,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

/** 造一张字段完整的角色卡（缺字段会在渲染期炸，别用残缺对象凑数） */
function mkCard(id: string, presetId?: string) {
  return {
    id,
    name: "测试角色",
    description: "",
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "",
    character_version: "",
    avatarPath: "",
    presetId,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

/** 造一个把某张卡设为当前的活动酒馆会话 */
function mkConv(id: string, cardId: string) {
  return {
    id,
    character_id: cardId,
    title: "会话",
    messages: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

/** 点「预设」标签打开面板
 *  注意：标签文本是 i18n 的 settings.presets = "预设"，
 *  而 "提示词预设" 是 PresetManager 面板内部的**标题**，不是标签名。 */
function openPresetsTab() {
  useAppModeStore.setState({ mode: "tavern", tavernSubMode: "rp" });
  const onClose = vi.fn();
  render(<SettingsDialog open onClose={onClose} />);
  fireEvent.click(screen.getByText("预设", { selector: "button" }));
  return onClose;
}

beforeEach(() => {
  useCharacterStore.setState({
    presets: [
      mkPreset("builtin-1", "内置预设A", true, "模板内容 A"),
      mkPreset("custom-1", "自定义预设B", false, "模板内容 B"),
    ],
  });
});

/** 预设项上的「查看/编辑条目」按钮（title 来自 i18n preset.view，注意带斜杠后缀） */
const VIEW_TITLE = "查看/编辑条目";

describe("预设「启用」按钮（2026-09-25 开发者反馈：预设没有单独启用按钮）", () => {
  it("每一行都渲染出「启用」按钮", () => {
    openPresetsTab();
    const btns = screen.getAllByText("启用", { selector: "button" });
    expect(btns.length).toBe(2); // 内置预设A + 自定义预设B
  });

  it("点「启用」把 presetId 写回当前酒馆会话的角色卡", async () => {
    useCharacterStore.setState({ characters: [mkCard("card-1") as never] });
    useTavernStore.setState({
      conversations: [mkConv("conv-1", "card-1") as never],
      activeId: "conv-1",
    });

    openPresetsTab();
    const row = screen.getByText("内置预设A").closest("div.border") as HTMLElement;
    fireEvent.click(within(row).getByText("启用", { selector: "button" }));

    await waitFor(() => {
      const saved = useCharacterStore.getState().characters.find((c) => c.id === "card-1");
      expect(saved?.presetId).toBe("builtin-1");
    });
  });

  it("当前生效的那条显示「已启用」而不是「启用」", () => {
    useCharacterStore.setState({ characters: [mkCard("card-1", "builtin-1") as never] });
    useTavernStore.setState({
      conversations: [mkConv("conv-1", "card-1") as never],
      activeId: "conv-1",
    });

    openPresetsTab();
    const row = screen.getByText("内置预设A").closest("div.border") as HTMLElement;
    expect(within(row).getByText("已启用")).toBeTruthy();
    // 另一条仍是「启用」
    const other = screen.getByText("自定义预设B").closest("div.border") as HTMLElement;
    expect(within(other).getByText("启用", { selector: "button" })).toBeTruthy();
  });

  it("没有当前角色时点「启用」给出可读提示，而不是静默失败", () => {
    useCharacterStore.setState({ characters: [] });
    useTavernStore.setState({ conversations: [], activeId: null });
    useAppModeStore.setState({ mode: "tavern", tavernSubMode: "rp" });
    // Toast 由 ToastContainer 渲染，测试里得自己挂上，否则提示无处可去
    render(<ToastContainer />);
    const onClose = vi.fn();
    render(<SettingsDialog open onClose={onClose} />);
    fireEvent.click(screen.getByText("预设", { selector: "button" }));
    const btns = screen.getAllByText("启用", { selector: "button" });
    fireEvent.click(btns[0] as HTMLElement);
    expect(screen.getByText(/请先在酒馆里选中一个角色/)).toBeTruthy();
  });

  it("页顶「返回」切回设置的上一层 tab，且**不关闭弹窗**", () => {
    // 这是对第一版实现的纠正：第一版把「返回」接到了 onClose，
    // 点它是「整个设置弹窗关掉」。开发者原话：
    //   「我点了是退出弹窗反而不是回到当初的设置那一筐」。
    // 所以本测试把两件事都钉住：① 回到上一层（角色 tab 可见）② onClose 一次都没调。
    const onClose = openPresetsTab();

    // 已在预设面板
    expect(screen.getByText("导入预设", { selector: "button" })).toBeTruthy();

    fireEvent.click(screen.getByText("返回", { selector: "button" }));

    // ① 回到上一层：预设面板消失，角色页的标志性按钮出现
    expect(screen.queryByText("导入预设", { selector: "button" })).toBeNull();
    expect(screen.getByText("新建人设", { selector: "button" })).toBeTruthy();
    // ② 弹窗仍在
    expect(screen.getByText("酒馆设置")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SettingsDialog 逃生通道", () => {
  it("底部「取消」存在且能关掉弹窗", () => {
    const onClose = openPresetsTab();
    const cancel = screen.getByText("取消", { selector: "button" });
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("右上角 X 存在且能关掉弹窗", () => {
    const onClose = openPresetsTab();
    // X 是头部里唯一的无文本按钮（lucide 图标），用 header 定位
    const header = screen.getByText("酒馆设置").parentElement as HTMLElement;
    const xBtn = within(header).getAllByRole("button").at(-1) as HTMLElement;
    fireEvent.click(xBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc 能关掉弹窗", () => {
    const onClose = openPresetsTab();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("内置预设展开后，展开区必须有一个可点的收起按钮（它的唯一退路）", () => {
    openPresetsTab();

    const row = screen.getByText("内置预设A").closest("div.border") as HTMLElement;
    expect(row).toBeTruthy();
    fireEvent.click(within(row).getByTitle(VIEW_TITLE));

    expect(screen.getByDisplayValue("模板内容 A")).toBeTruthy();

    const cancels = within(row).getAllByText("取消", { selector: "button" });
    expect(cancels.length).toBeGreaterThan(0);
    fireEvent.click(cancels[0] as HTMLElement);

    expect(screen.queryByDisplayValue("模板内容 A")).toBeNull();
  });

  it("自定义预设展开后有「保存」与「取消」两个按钮", () => {
    openPresetsTab();
    const row = screen.getByText("自定义预设B").closest("div.border") as HTMLElement;
    fireEvent.click(within(row).getByTitle(VIEW_TITLE));
    expect(within(row).getAllByText("保存", { selector: "button" }).length).toBeGreaterThan(0);
    expect(within(row).getAllByText("取消", { selector: "button" }).length).toBeGreaterThan(0);
  });

  it("列表很长时（60 条）仍能展开并收起 —— 防展开区渲染到列表另一端", () => {
    const many: PromptPreset[] = Array.from({ length: 60 }, (_, i) =>
      mkPreset(`p-${i}`, `预设${i}`, true, `模板${i}`)
    );
    useCharacterStore.setState({ presets: many });
    openPresetsTab();

    const row = screen.getByText("预设59").closest("div.border") as HTMLElement;
    fireEvent.click(within(row).getByTitle(VIEW_TITLE));
    expect(screen.getByDisplayValue("模板59")).toBeTruthy();

    const cancels = within(row).getAllByText("取消", { selector: "button" });
    expect(cancels.length).toBeGreaterThan(0);
    fireEvent.click(cancels[0] as HTMLElement);
    expect(screen.queryByDisplayValue("模板59")).toBeNull();
  });
});
