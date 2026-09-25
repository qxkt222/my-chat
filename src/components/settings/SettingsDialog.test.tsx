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

/** 取某条预设所在的行（新版把行放进「包」分区里了，不再是原来的 div.border）
 *  取的是「行 + 展开的编辑区」共同的外层容器：名称文字 → 上层 flex items-center（行头）
 *  → 再上一层（包住编辑区的行容器）。 */
function presetRow(name: string): HTMLElement {
  const head = screen.getByText(name).closest("div.flex.items-center") as HTMLElement | null;
  const outer = head?.parentElement ?? null;
  if (!outer) throw new Error("找不到预设行: " + name);
  return outer;
}

describe("全局条目名册：逐条开关（2026-09-25 改造）", () => {
  it("每条都渲染出开关", () => {
    openPresetsTab();
    // 两条都未启用 → 两个「启用」
    expect(screen.getAllByText("启用", { selector: "button" }).length).toBeGreaterThanOrEqual(2);
  });

  it("点「启用」把它**全局**开启（写回 store.presets[].enabled），**不碰角色卡**", async () => {
    // 故意放一张绑了别的预设的角色卡：全局开关不该动它
    useCharacterStore.setState({
      characters: [mkCard("card-1", "preset-classic-char") as never],
    });
    useTavernStore.setState({
      conversations: [mkConv("conv-1", "card-1") as never],
      activeId: "conv-1",
    });

    openPresetsTab();
    fireEvent.click(within(presetRow("内置预设A")).getByText("启用", { selector: "button" }));

    await waitFor(() => {
      const p = useCharacterStore.getState().presets.find((x) => x.id === "builtin-1");
      expect(p?.enabled).toBe(true);
    });
    // 角色卡上的 presetId 必须原样不动 —— 「与角色的状态无关」
    const card = useCharacterStore.getState().characters.find((c) => c.id === "card-1");
    expect(card?.presetId).toBe("preset-classic-char");
  });

  it("已启用的显示「已启用」，再点一下能关掉（可开可关）", async () => {
    useCharacterStore.setState({
      presets: [
        mkPreset("builtin-1", "内置预设A", true, "模板内容 A"),
        mkPreset("custom-1", "自定义预设B", false, "模板内容 B"),
      ],
    });
    openPresetsTab();
    const row = presetRow("内置预设A");

    fireEvent.click(within(row).getByText("启用", { selector: "button" }));
    await waitFor(() => expect(within(row).getByText("已启用")).toBeTruthy());

    fireEvent.click(within(row).getByText("已启用", { selector: "button" }));
    await waitFor(() =>
      expect(useCharacterStore.getState().presets.find((x) => x.id === "builtin-1")?.enabled).toBe(
        false
      )
    );
  });

  it("页顶汇总行显示已启用条数与字数（超预算只提醒不拦）", () => {
    openPresetsTab();
    expect(screen.getByText(/已启用\s*\d+\s*条/)).toBeTruthy();
  });

  it("页顶「返回」切回设置的上一层 tab，且**不关闭弹窗**", () => {
    // 这是对第一版实现的纠正：第一版把「返回」接到了 onClose，
    // 点它是「整个设置弹窗关掉」。开发者原话：
    //   「我点了是退出弹窗反而不是回到当初的设置那一筐」。
    const onClose = openPresetsTab();

    expect(screen.getByText("导入预设", { selector: "button" })).toBeTruthy();

    fireEvent.click(screen.getByText("返回", { selector: "button" }));

    expect(screen.queryByText("导入预设", { selector: "button" })).toBeNull();
    expect(screen.getByText("新建人设", { selector: "button" })).toBeTruthy();
    expect(screen.getByText("酒馆设置")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("三个面板都有常驻返回（2026-09-25 开发者反馈）", () => {
  // 原话：「就单单样式这个功能我用后就发现由于导入了很多东西导致上面那些排序
  // 被一起挤走了，就想在不改动（弹窗大小）情况下加入返回功能，就像预设那样处理」。
  // 这里钉住「返回按钮存在 + 点了切回上一层 + 不关弹窗」。
  // 「一直看得见」属于排版问题，由真浏览器探针（src/probe/sticky-probe）负责 ——
  // jsdom 元素高度恒为 0、position:sticky 不生效，不在这里假装能测。

  /** 当前选中的 tab（选中态带 border-primary；返回后应变成「角色」） */
  function activeTab(): string {
    const btns = Array.from(document.querySelectorAll("button"));
    const hit = btns.find((b) => b.className.includes("border-primary"));
    return (hit?.textContent ?? "").trim();
  }

  const cases = ["预设", "世界书", "样式"] as const;

  for (const label of cases) {
    it(`「${label}」面板：返回按钮存在、切回上一层、弹窗不关`, () => {
      useAppModeStore.setState({ mode: "tavern", tavernSubMode: "rp" });
      const onClose = vi.fn();
      render(<SettingsDialog open onClose={onClose} />);
      fireEvent.click(screen.getByText(label, { selector: "button" }));
      expect(activeTab()).toBe(label); // 已进入该面板

      fireEvent.click(screen.getByText("返回", { selector: "button" }));

      // 回到上一层（初始 tab = 角色），而不是关掉弹窗
      expect(activeTab()).toBe("角色");
      expect(screen.getByText("酒馆设置")).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
    });
  }
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

    const row = presetRow("内置预设A");
    fireEvent.click(within(row).getByTitle(VIEW_TITLE));

    expect(screen.getByDisplayValue("模板内容 A")).toBeTruthy();

    // 展开区里的按钮是「收起」；底部那个「取消」是关整个弹窗的，两者不混用
    const rowWithEditor = (screen.getByDisplayValue("模板内容 A") as HTMLElement).closest(
      "div"
    ) as HTMLElement;
    const collapse = rowWithEditor.querySelector("button:last-of-type") as HTMLElement;
    expect(collapse).toBeTruthy();
    fireEvent.click(collapse);

    expect(screen.queryByDisplayValue("模板内容 A")).toBeNull();
  });

  it("自定义预设展开后有「保存」与「收起」两个按钮", () => {
    openPresetsTab();
    fireEvent.click(within(presetRow("自定义预设B")).getByTitle(VIEW_TITLE));
    const row = presetRow("自定义预设B");
    expect(within(row).getByDisplayValue("模板内容 B")).toBeTruthy();
    expect(screen.getAllByText("保存", { selector: "button" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("收起", { selector: "button" }).length).toBeGreaterThan(0);
  });

  it("列表很长时（60 条）仍能展开并收起 —— 防展开区渲染到列表另一端", () => {
    const many: PromptPreset[] = Array.from({ length: 60 }, (_, i) =>
      mkPreset(`p-${i}`, `预设${i}`, true, `模板${i}`)
    );
    useCharacterStore.setState({ presets: many });
    openPresetsTab();

    fireEvent.click(within(presetRow("预设59")).getByTitle(VIEW_TITLE));
    expect(screen.getByDisplayValue("模板59")).toBeTruthy();

    const collapse = screen.getAllByText("收起", { selector: "button" })[0] as HTMLElement;
    fireEvent.click(collapse);
    expect(screen.queryByDisplayValue("模板59")).toBeNull();
  });
});
