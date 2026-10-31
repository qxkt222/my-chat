// @vitest-environment jsdom
//
// ChatInput「对话」子模式能力裁剪的回归闸门。
//
// 能力矩阵（用户拍板）：
//   | 能力            | 对话（workSubMode="chat"）        | 工作（"work"） |
//   | 内置 /search    | 可用                              | 可用           |
//   | 知识库 RAG      | 可用                              | 可用           |
//   | 技能            | 仅 lite_enabled === true          | 全部           |
//   | MCP             | 仅 mcpListLiteTools() 白名单      | 全部           |
//   | 项目指令        | 不可用                            | 可用           |
//   | 多模型对比      | 不可用                            | 可用           |
//
// 这组用例从**用户可见入口**与**真实发送 payload** 两头卡：
//   - 只断言「按钮消失」不够——旧状态（先开 RAG 再切子模式）仍可能把上下文带进去；
//   - 只断言能力纯函数也不够——发送路径可能根本没用它。
// 因此这里 mock 掉 tauri，渲染组件、点真实按钮、再检查 sendMessage 的四个实参。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  ragSearch: vi.fn(),
  ragRerank: vi.fn(),
  mcpListServers: vi.fn(),
  mcpListLiteTools: vi.fn(),
  mcpListTools: vi.fn(),
  mcpCallTool: vi.fn(),
  logDiag: vi.fn(),
}));

// 只替换 ChatInput 直接调用的几个 IPC 包装，其余保持真实导出，
// 避免「store 里还 import 了别的 tauri 函数」时 mock 缺导出而报错。
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, ...mocks };
});

import { ChatInput, capabilitiesFor } from "./ChatInput";
import { useAppModeStore } from "@/stores/useAppModeStore";
import { useChatStore } from "@/stores/useChatStore";
import { useConversationStore } from "@/stores/useConversationStore";
import { useKnowledgeStore } from "@/stores/useKnowledgeStore";
import { useMemoryStore } from "@/stores/useMemoryStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useSkillStore } from "@/stores/useSkillStore";
import { t } from "@/lib/i18n";
import type { KnowledgeBase, Message, ModelConfig, ProjectInstruction, Skill } from "@/types";

/** sendMessage 的四元组实参（断言 payload 用） */
type SendArgs = [string, ModelConfig[], string | undefined, string | undefined];

const MODEL: ModelConfig = {
  name: "m1",
  provider: "openai",
  api_url: "http://127.0.0.1:1",
  api_key: "k",
  model: "m1",
};
const MODEL2: ModelConfig = {
  name: "m2",
  provider: "openai",
  api_url: "http://127.0.0.1:1",
  api_key: "k",
  model: "m2",
};
const PROJECT_RULE: ProjectInstruction = {
  id: "p1",
  name: "project",
  instruction: "PROJECT_RULE",
  created_at: "2026-10-23T00:00:00.000Z",
};
const SKILL: Skill = {
  id: "s1",
  name: "SkillA",
  description: "desc",
  systemPrompt: "SKILL_PROMPT",
  model: "",
  temperature: null,
  category: "",
  tags: [],
  created_at: "2026-10-23T00:00:00.000Z",
  updated_at: "2026-10-23T00:00:00.000Z",
  memory_tags: "[]",
  tools_json: "",
};
/** 对话模式可用的技能（lite_enabled=true） */
const SKILL_LITE: Skill = {
  ...SKILL,
  id: "s2",
  name: "SkillLite",
  systemPrompt: "LITE_PROMPT",
  lite_enabled: true,
};
const KB: KnowledgeBase = {
  id: "kb1",
  name: "KnowledgeA",
  description: "kb",
  created_at: "2026-10-23T00:00:00.000Z",
};
const MCP_SERVER = {
  id: "srv-1",
  name: "Srv",
  command: "cmd",
  args: [],
  enabled: true,
  created_at: "2026-10-23T00:00:00.000Z",
};

function setMode(mode: "work" | "tavern", workSubMode: "work" | "chat") {
  // workSubMode 由 useAppModeStore 提供（另一个代理负责）；这里用 setState 注入，
  // 使本文件只依赖公开契约，不依赖 store 内部实现。
  act(() => {
    useAppModeStore.setState({ mode, workSubMode } as never);
  });
}

/** 取第 n 次 sendMessage 调用；未调用直接失败，避免 `!` 与非空断言告警 */
function sentArgs(sendMessage: ReturnType<typeof vi.fn>, n = 0): SendArgs {
  const call = sendMessage.mock.calls[n] as SendArgs | undefined;
  if (!call) throw new Error(`sendMessage 第 ${n} 次调用不存在`);
  return call;
}

function seedConversation() {
  useConversationStore.setState({
    conversations: [
      {
        id: "c1",
        title: "t",
        messages: [],
        created_at: "2026-10-23T00:00:00.000Z",
        updated_at: "2026-10-23T00:00:00.000Z",
      },
    ],
    activeId: "c1",
  } as never);
}

function setup(
  opts: { mode?: "work" | "tavern"; workSubMode?: "work" | "chat"; skills?: Skill[] } = {}
) {
  const sendMessage = vi.fn();
  const addMessage = vi.fn<(convId: string, msg: Message) => Promise<void>>();
  sendMessage.mockResolvedValue(undefined);
  addMessage.mockResolvedValue(undefined);

  useChatStore.setState({ isStreaming: false, sendMessage } as never);
  useSettingsStore.setState({
    models: [MODEL, MODEL2],
    activeModel: MODEL.name,
    globalInstruction: "",
    projectInstructions: [PROJECT_RULE],
    modelWrappers: [],
  } as never);
  useSkillStore.setState({ skills: opts.skills ?? [SKILL], activeSkillId: null } as never);
  useKnowledgeStore.setState({ activeBaseId: "kb1", bases: [KB] } as never);
  useMemoryStore.setState({
    memories: [],
    byTags: () => "MEMORY_TEXT",
  } as never);
  useConversationStore.setState({
    conversations: [],
    activeId: null,
    addMessage,
  } as never);

  setMode(opts.mode ?? "work", opts.workSubMode ?? "work");

  render(<ChatInput />);
  return { sendMessage, addMessage };
}

async function typeAndSend(text = "你好") {
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByTitle(t("chat.sendTitle")));
}

beforeEach(() => {
  localStorage.clear();
  // jsdom 没有实现 Element.scrollTo（@ 菜单挂载时会滚动列表到顶部）
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  mocks.ragSearch.mockReset().mockResolvedValue([]);
  mocks.ragRerank.mockReset().mockResolvedValue([]);
  mocks.mcpListServers.mockReset().mockResolvedValue([MCP_SERVER]);
  mocks.mcpListLiteTools.mockReset().mockResolvedValue([]);
  mocks.mcpListTools
    .mockReset()
    .mockResolvedValue([
      { name: "t1", description: "", input_schema: { type: "object", properties: {} } },
    ]);
  mocks.mcpCallTool.mockReset().mockResolvedValue({ ok: true, content: "called" });
  mocks.logDiag.mockReset();
});

afterEach(cleanup);

describe("capabilitiesFor —— 能力裁剪矩阵", () => {
  const full = {
    skills: true,
    knowledge: true,
    mcp: true,
    projectInstructions: true,
    compare: true,
  };
  // 对话模式：技能/知识库/MCP 都「可用但受限」，项目指令与对比不可用
  const lite = {
    skills: true,
    knowledge: true,
    mcp: true,
    projectInstructions: false,
    compare: false,
  };

  it("工作子模式 = 全能力", () => {
    expect(capabilitiesFor("work", "work")).toEqual(full);
  });

  it("对话子模式 = 技能/知识库/MCP 受限可用，无项目指令与多模型对比", () => {
    expect(capabilitiesFor("work", "chat")).toEqual(lite);
  });

  it("酒馆模式不受工作子模式影响（即使残留 chat 也按全能力）", () => {
    expect(capabilitiesFor("tavern", "chat")).toEqual(full);
    expect(capabilitiesFor("tavern", "work")).toEqual(full);
  });
});

describe("对话子模式：UI 入口", () => {
  it("技能 / 知识库入口保留；多模型对比 / 包装器隐藏", () => {
    setup({ mode: "work", workSubMode: "chat" });
    expect(screen.getByTitle(t("chat.skillPick"))).toBeTruthy();
    expect(screen.getByTitle(t("chat.ragOff"))).toBeTruthy();
    expect(screen.queryByTitle(t("chat.compareTitle"))).toBeNull();
    expect(screen.queryByTitle(t("chat.wrapper"))).toBeNull();
    // 基础发送入口仍在
    expect(screen.getByTitle(t("chat.sendTitle"))).toBeTruthy();
  });

  it("工作子模式仍显示全部入口", () => {
    setup({ mode: "work", workSubMode: "work" });
    expect(screen.getByTitle(t("chat.skillPick"))).toBeTruthy();
    expect(screen.getByTitle(t("chat.ragOff"))).toBeTruthy();
    expect(screen.getByTitle(t("chat.compareTitle"))).toBeTruthy();
    expect(screen.getByTitle(t("chat.wrapper"))).toBeTruthy();
  });

  it("酒馆模式（残留 chat 子模式）仍显示全部入口", () => {
    setup({ mode: "tavern", workSubMode: "chat" });
    expect(screen.getByTitle(t("chat.skillPick"))).toBeTruthy();
    expect(screen.getByTitle(t("chat.ragOff"))).toBeTruthy();
    expect(screen.getByTitle(t("chat.compareTitle"))).toBeTruthy();
  });
});

describe("对话子模式：技能过滤", () => {
  it("技能选择器只列 lite_enabled=true 的技能", () => {
    setup({ mode: "work", workSubMode: "chat", skills: [SKILL, SKILL_LITE] });
    fireEvent.click(screen.getByTitle(t("chat.skillPick")));

    expect(screen.getByText("SkillLite")).toBeTruthy();
    expect(screen.queryByText("SkillA")).toBeNull();
  });

  it("工作模式技能选择器仍列出全部技能", () => {
    setup({ mode: "work", workSubMode: "work", skills: [SKILL, SKILL_LITE] });
    fireEvent.click(screen.getByTitle(t("chat.skillPick")));

    expect(screen.getByText("SkillA")).toBeTruthy();
    expect(screen.getByText("SkillLite")).toBeTruthy();
  });

  it("选中的 lite 技能会注入系统提示词", async () => {
    const { sendMessage } = setup({
      mode: "work",
      workSubMode: "chat",
      skills: [SKILL, SKILL_LITE],
    });
    fireEvent.click(screen.getByTitle(t("chat.skillPick")));
    fireEvent.click(screen.getByText("SkillLite"));

    await typeAndSend("hi");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const [, , systemPrompt] = sentArgs(sendMessage);
    expect(systemPrompt).toContain("LITE_PROMPT");
    expect(systemPrompt).not.toContain("PROJECT_RULE");
  });

  it("从工作模式切到对话后，残留的非 lite 技能不发送（预览也隐藏）", async () => {
    const { sendMessage } = setup({ mode: "work", workSubMode: "work", skills: [SKILL] });
    fireEvent.click(screen.getByTitle(t("chat.skillPick")));
    fireEvent.click(screen.getByText("SkillA"));
    expect(screen.getByText(t("chat.skillPreview", { name: "SkillA" }))).toBeTruthy();

    setMode("work", "chat");
    expect(screen.queryByText(t("chat.skillPreview", { name: "SkillA" }))).toBeNull();

    await typeAndSend("hi");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const [, , systemPrompt] = sentArgs(sendMessage);
    expect(systemPrompt ?? "").not.toContain("SKILL_PROMPT");
  });
});

describe("对话子模式：@ 菜单", () => {
  it("只列 lite 技能；知识库分组恢复显示", () => {
    setup({ mode: "work", workSubMode: "chat", skills: [SKILL, SKILL_LITE] });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@" } });

    expect(screen.getByText("SkillLite")).toBeTruthy();
    expect(screen.queryByText("SkillA")).toBeNull();
    expect(screen.getByText("KnowledgeA")).toBeTruthy();
  });

  it("工作模式下列出全部技能与知识库", () => {
    setup({ mode: "work", workSubMode: "work", skills: [SKILL, SKILL_LITE] });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@" } });

    expect(screen.getByText("SkillA")).toBeTruthy();
    expect(screen.getByText("SkillLite")).toBeTruthy();
    expect(screen.getByText("KnowledgeA")).toBeTruthy();
  });
});

describe("对话子模式：发送 payload", () => {
  it("知识库 RAG 恢复可用：检索结果照常注入", async () => {
    const { sendMessage } = setup({ mode: "work", workSubMode: "chat" });
    mocks.ragSearch.mockResolvedValue([
      { chunk_id: "c1", content: "KB_CONTENT", score: 0.9, kb_name: "kb", file_name: "a.md" },
    ]);

    fireEvent.click(screen.getByTitle(t("chat.ragOff")));
    await typeAndSend("问题");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const [, targetModels, systemPrompt, knowledgeContext] = sentArgs(sendMessage);
    expect(mocks.ragSearch).toHaveBeenCalledTimes(1);
    expect(knowledgeContext).toContain("KB_CONTENT");
    // 项目指令仍不注入，目标模型只保留当前模型
    expect(systemPrompt ?? "").not.toContain("PROJECT_RULE");
    expect(targetModels.map((x) => x.name)).toEqual([MODEL.name]);
  });

  it("从工作模式挂起的对比模型/知识库开关切到对话后：对比不带，知识库照常检索", async () => {
    const { sendMessage } = setup({ mode: "work", workSubMode: "work" });
    mocks.ragSearch.mockResolvedValue([
      { chunk_id: "c1", content: "KB_CONTENT", score: 0.9, kb_name: "kb", file_name: "a.md" },
    ]);

    fireEvent.click(screen.getByTitle(t("chat.ragOff")));
    fireEvent.click(screen.getByTitle(t("chat.compareTitle")));
    fireEvent.click(screen.getByText(/m2/));

    setMode("work", "chat");
    expect(screen.getByText(t("chat.ragMode"))).toBeTruthy();

    await typeAndSend("你好");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const [, targetModels, systemPrompt, knowledgeContext] = sentArgs(sendMessage);
    expect(targetModels.map((x) => x.name)).toEqual([MODEL.name]);
    expect(systemPrompt ?? "").not.toContain("PROJECT_RULE");
    expect(knowledgeContext).toContain("KB_CONTENT");
  });
});

describe("对话子模式：/mcp 白名单", () => {
  it("白名单命中时执行真实 MCP 调用（用 server.id 匹配）", async () => {
    const { addMessage } = setup({ mode: "work", workSubMode: "chat" });
    seedConversation();
    mocks.mcpListLiteTools.mockResolvedValue([["srv-1", "t1"]]);

    await typeAndSend("/mcp Srv t1");
    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));

    expect(mocks.mcpListLiteTools).toHaveBeenCalled();
    expect(mocks.mcpCallTool).toHaveBeenCalledWith("srv-1", "t1", {}, "chat");
    const assistantCall = addMessage.mock.calls[1];
    if (!assistantCall) throw new Error("助手消息未写入会话");
    expect(assistantCall[1].content).toContain("called");
  });

  it("白名单为空时每一步都被拒绝并给出明确提示，且不发起 MCP 调用", async () => {
    const { addMessage } = setup({ mode: "work", workSubMode: "chat" });
    seedConversation();
    mocks.mcpListLiteTools.mockResolvedValue([]);

    await typeAndSend("/mcp Srv t1");
    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));

    expect(mocks.mcpCallTool).not.toHaveBeenCalled();
    expect(mocks.mcpListTools).not.toHaveBeenCalled();
    const assistantCall = addMessage.mock.calls[1];
    if (!assistantCall) throw new Error("助手消息未写入会话");
    expect(assistantCall[1].content).toContain(
      t("chat.mcpLiteDenied", { s: MCP_SERVER.name, t: "t1" })
    );
  });

  it("server.id 与显示名不同也不能被名字蒙混过关", async () => {
    const { addMessage } = setup({ mode: "work", workSubMode: "chat" });
    seedConversation();
    // 白名单里写的是显示名 → 不应命中（契约以 server.id 为准）
    mocks.mcpListLiteTools.mockResolvedValue([["Srv", "t1"]]);

    await typeAndSend("/mcp Srv t1");
    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));
    expect(mocks.mcpCallTool).not.toHaveBeenCalled();
  });
});

describe("对话子模式：技能绑定的 MCP 工具受白名单约束", () => {
  const skillWithTool: Skill = { ...SKILL_LITE, tools_json: JSON.stringify(["srv-1/t1"]) };

  it("白名单为空：不调用工具，把拒绝原因写进上下文", async () => {
    const { sendMessage } = setup({
      mode: "work",
      workSubMode: "chat",
      skills: [skillWithTool],
    });
    fireEvent.click(screen.getByTitle(t("chat.skillPick")));
    fireEvent.click(screen.getByText("SkillLite"));
    mocks.mcpListLiteTools.mockResolvedValue([]);

    await typeAndSend("hi");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const [, , systemPrompt] = sentArgs(sendMessage);
    expect(mocks.mcpCallTool).not.toHaveBeenCalled();
    expect(systemPrompt ?? "").toContain(t("chat.mcpLiteDenied", { s: MCP_SERVER.name, t: "t1" }));
  });

  it("白名单命中：工具结果注入上下文", async () => {
    const { sendMessage } = setup({
      mode: "work",
      workSubMode: "chat",
      skills: [skillWithTool],
    });
    fireEvent.click(screen.getByTitle(t("chat.skillPick")));
    fireEvent.click(screen.getByText("SkillLite"));
    mocks.mcpListLiteTools.mockResolvedValue([["srv-1", "t1"]]);

    await typeAndSend("hi");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const [, , systemPrompt] = sentArgs(sendMessage);
    expect(mocks.mcpCallTool).toHaveBeenCalledWith("srv-1", "t1", {}, "chat");
    expect(systemPrompt).toContain("called");
  });
});

describe("工作子模式：全能力行为不变", () => {
  it("项目指令 + 知识库检索 + 多模型对比都照旧生效", async () => {
    const { sendMessage } = setup({ mode: "work", workSubMode: "work" });
    mocks.ragSearch.mockResolvedValue([
      { chunk_id: "c1", content: "KB_CONTENT", score: 0.9, kb_name: "kb", file_name: "a.md" },
    ]);

    fireEvent.click(screen.getByTitle(t("chat.ragOff")));
    fireEvent.click(screen.getByTitle(t("chat.compareTitle")));
    fireEvent.click(screen.getByText(/m2/));

    await typeAndSend("问题");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const [, targetModels, systemPrompt, knowledgeContext] = sentArgs(sendMessage);
    expect(targetModels.map((x: ModelConfig) => x.name)).toEqual(["m1", "m2"]);
    expect(systemPrompt).toContain("PROJECT_RULE");
    expect(mocks.ragSearch).toHaveBeenCalledTimes(1);
    expect(knowledgeContext).toContain("KB_CONTENT");
  });

  it("技能提示词覆盖项目指令（技能仍可在工作模式选用）", async () => {
    const { sendMessage } = setup({ mode: "work", workSubMode: "work" });
    fireEvent.click(screen.getByTitle(t("chat.skillPick")));
    fireEvent.click(screen.getByText("SkillA"));

    await typeAndSend("hi");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const [, , systemPrompt] = sentArgs(sendMessage);
    // 技能提示词优先；记忆标签文本按现有行为追加在后
    expect(systemPrompt).toContain("SKILL_PROMPT");
    expect(systemPrompt).not.toContain("PROJECT_RULE");
  });

  it("/mcp 不受白名单约束（不查询 lite 白名单）", async () => {
    const { addMessage } = setup({ mode: "work", workSubMode: "work" });
    seedConversation();

    await typeAndSend("/mcp Srv t1");
    await waitFor(() => expect(addMessage).toHaveBeenCalledTimes(2));
    expect(mocks.mcpListLiteTools).not.toHaveBeenCalled();
    expect(mocks.mcpCallTool).toHaveBeenCalledWith("srv-1", "t1", {}, "work");
  });
});

describe("酒馆模式：逻辑完全不动", () => {
  it("即使 workSubMode 残留 chat，注入与按钮仍按全能力", async () => {
    const { sendMessage } = setup({ mode: "tavern", workSubMode: "chat" });
    expect(screen.getByTitle(t("chat.skillPick"))).toBeTruthy();

    await typeAndSend("酒馆");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const [, targetModels, systemPrompt] = sentArgs(sendMessage);
    expect(systemPrompt).toContain("PROJECT_RULE");
    expect(targetModels).toHaveLength(1);
  });
});

describe("上下文压缩中：输入入口收口（T-019）", () => {
  it("当前会话压缩中：输入框禁用，点击发送不会发起请求", () => {
    const { sendMessage } = setup();
    act(() => {
      seedConversation();
      useChatStore.setState({ compressingConvIds: ["c1"] } as never);
    });

    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);

    fireEvent.change(box, { target: { value: "压缩期间发送" } });
    fireEvent.click(screen.getByTitle(t("chat.sendTitle")));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
