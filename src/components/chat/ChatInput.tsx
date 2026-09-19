import { useState, useRef, useCallback, useEffect } from "react";
import {
  Send,
  Square,
  RefreshCw,
  Database,
  Layers,
  X,
  FileText,
  Sparkles,
  Package,
} from "lucide-react";
import { useChatStore } from "@/stores/useChatStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useConversationStore } from "@/stores/useConversationStore";
import { useKnowledgeStore } from "@/stores/useKnowledgeStore";
import { useSkillStore } from "@/stores/useSkillStore";
import { useMemoryStore } from "@/stores/useMemoryStore";
import { pluginAPI } from "@/plugin/PluginHost";
import { SLASH_COMMANDS } from "@/plugin/commands";
import {
  mcpListServers,
  mcpListTools,
  mcpCallTool,
  ragSearch,
  ragRerank,
  type RagResult,
} from "@/lib/tauri";
import type { McpServerDto } from "@/types";
import { useT, t } from "@/lib/i18n";
import { countTokens } from "@/lib/token-counter";
import { AtMentionMenu, type MentionSelection, type AtMentionMenuHandle } from "./AtMentionMenu";
import { setCodeInsertHandler } from "@/lib/code-insert";
import { loadChains, runPromptChain, type PromptChain } from "@/lib/prompt-chain";
import type { Message, Skill, ModelWrapper } from "@/types";

interface Props {
  quoted?: Message | null;
  onClearQuote?: () => void;
}

export function ChatInput({ quoted, onClearQuote }: Props) {
  const [input, setInput] = useState("");
  const [ragEnabled, setRagEnabled] = useState(false);
  const [compareModels, setCompareModels] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  // Pending skill: its systemPrompt is injected on send, and it may pin a model
  const [skill, setSkill] = useState<Skill | null>(null);
  const [showSkills, setShowSkills] = useState(false);
  // `@` 提及:触发时的搜索词 + 高亮(键盘导航受控)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  // @ 旧会话上下文(选择会话后追加进 systemPrompt,@ 引用自动压缩)
  const [convMentions, setConvMentions] = useState<{ id: string; name: string }[]>([]);
  // prompt 链:`..` 触发多步工作流选择器
  const [chainPick, setChainPick] = useState<PromptChain[] | null>(null);
  const [chainRunning, setChainRunning] = useState(false);
  // 工具调用阶段化状态(工具阶段状态):长工具调用时在输入区上方显示当前阶段
  const [toolStatus, setToolStatus] = useState<{
    server: string;
    tool: string;
    stage: string;
  } | null>(null);
  // RAG 来源卡(引用回链+摘录):发送时记录本次检索来源
  const [lastSources, setLastSources] = useState<RagResult[]>([]);
  // rerank 开关 + 检索模式(双模式分流:bm25/vector/hybrid)
  const [ragRerankEnabled, setRagRerankEnabled] = useState(false);
  const [ragMode, setRagMode] = useState<"bm25" | "vector" | "hybrid">("hybrid");
  // 模型包装器:选中的预设(模型+知识库+指令),发送时应用
  const [wrapperPick, setWrapperPick] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionRef = useRef<AtMentionMenuHandle>(null);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const cancelGeneration = useChatStore((s) => s.cancelGeneration);
  const regenerate = useChatStore((s) => s.regenerate);
  const t = useT();
  const models = useSettingsStore((s) => s.models);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const modelWrappers = useSettingsStore((s) => s.modelWrappers);
  const skills = useSkillStore((s) => s.skills);
  const activeBaseId = useKnowledgeStore((s) => s.activeBaseId);
  const setActiveKb = useKnowledgeStore((s) => s.setActive);

  const model = models.find((m) => m.name === activeModel);
  // Compare models = checked extra models (excluding the primary active one)
  const compareList = models.filter(
    (m) => m.name !== activeModel && compareModels.includes(m.name)
  );
  const ph = model ? `Message ${model.name}... (Enter to send)` : t("chat.noModel");

  // 代码块「插入到输入框」:MessageRenderer 通过模块级 handler 回调(保持渲染器纯组件)
  useEffect(() => {
    setCodeInsertHandler((code) => {
      setInput((p) => (p ? `${p}\n\n\`\`\`\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``));
      textareaRef.current?.focus();
    });
    return () => setCodeInsertHandler(null);
  }, []);

  const toggleCompare = (name: string) => {
    setCompareModels((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );
  };

  const handleSend = useCallback(async () => {
    const content = input.trim();
    if (!content || isStreaming) return;

    const convStore = useConversationStore.getState();

    // Slash command (plugin dispatch) — no model required
    if (content.startsWith("/")) {
      const [cmdRawRaw, ...rest] = content.slice(1).split(/\s+/);
      const cmdRaw = cmdRawRaw ?? "";
      const args = rest.join(" ");
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";

      let convId = convStore.activeId;
      if (!convId) {
        const conv = await convStore.create();
        convId = conv.id;
      }

      const userMsg = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content,
        timestamp: new Date().toISOString(),
      };
      await convStore.addMessage(convId, userMsg);

      let result: string | null = null;

      // 工具调用阶段化状态(工具阶段状态):初始化→调用中→读取结果→完成,
      // 在输入区上方显示当前阶段,避免长工具调用看起来像卡死
      const setStage = (stage: string) =>
        setToolStatus({ server: cmdRaw, tool: stage.split(" ")[0] || cmdRaw, stage });

      // MCP tool chain: /mcp <server> <tool> [argsJson] :: <tool2> [argsJson] :: ...
      // Each step runs in order; "{prev}" in args references the previous output.
      if (cmdRaw.toLowerCase() === "mcp" && args) {
        try {
          setStage(t("tool.initialize"));
          const servers = await mcpListServers();
          const steps = args
            .split("::")
            .map((s) => s.trim())
            .filter(Boolean);
          if (steps.length === 0) {
            result = t("chat.mcpUsage");
          } else {
            const outputs: string[] = [];
            let prev = "";
            let firstServer = true;
            let chainServer: McpServerDto | null = null;
            for (const step of steps) {
              const [toolName, ...argParts] = step.split(/\s+/);
              const argText = argParts.join(" ").trim();
              const toolNameSafe = toolName ?? "";
              // First step carries "server", later steps reuse it
              let server: McpServerDto | null = chainServer;
              if (firstServer) {
                const [srv, toolRaw, ...rest] = step.split(/\s+/);
                server = servers.find((s) => s.name.toLowerCase() === srv?.toLowerCase()) || null;
                if (!server) {
                  result = t("chat.mcpNotFound", {
                    s: srv ?? "",
                    list: servers.map((x) => x.name).join("、") || t("chat.mcpNone"),
                  });
                  break;
                }
                chainServer = server;
                // Re-derive tool name & args since the first token was the server
                const toolFirst = toolRaw ?? "";
                const argFirst = rest.join(" ").trim();
                if (!server) break;
                setStage(`${t("tool.calling")} ${server.name}/${toolFirst}`);
                outputs.push(await runMcpStep(server, toolFirst, argFirst, prev));
              } else if (server) {
                setStage(`${t("tool.calling")} ${server.name}/${toolNameSafe}`);
                outputs.push(await runMcpStep(server, toolNameSafe, argText, prev));
              }
              prev = outputs[outputs.length - 1] ?? "";
              firstServer = false;
            }
            setStage(t("tool.reading"));
            result = outputs.join("\n\n---\n\n");
          }
        } catch (e) {
          result = `${t("chat.mcpCallFailed")}${e}`;
        } finally {
          setToolStatus(null);
        }
      } else if (cmdRaw.toLowerCase() === "mcp") {
        result = t("chat.mcpUsage");
      }

      if (result === null) {
        setStage(t("tool.calling"));
        try {
          result = await pluginAPI.executeCommand(cmdRaw.toLowerCase(), args);
        } finally {
          setToolStatus(null);
        }
      }

      if (result != null) {
        const asmMsg = {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          content: result,
          timestamp: new Date().toISOString(),
        };
        await convStore.addMessage(convId, asmMsg);
      } else {
        await convStore.addMessage(convId, {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          content: t("chat.unknownCmd", {
            cmd: cmdRaw,
            list: SLASH_COMMANDS.map((c) => "/" + c.cmd).join("、"),
          }),
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    if (!model) return;

    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    // Build RAG context if enabled(结构化检索:候选片段 + rerank 重排 + 来源卡)
    let knowledgeContext: string | undefined;
    let sources: RagResult[] = [];
    if (ragEnabled && activeBaseId) {
      try {
        // 1) 结构化检索(hybrid = BM25 + 向量 + RRF;mode 切换走双模式分流)
        sources = await ragSearch(content, { kbId: activeBaseId, topK: 5, mode: ragMode });
        // 2) LLM rerank:候选 top-5 交给当前模型按相关性重排(费 token,可选)
        if (ragRerankEnabled && sources.length > 1) {
          try {
            const order = await ragRerank(
              content,
              sources.map((s) => s.content),
              { api_url: model.api_url, api_key: model.api_key, model: model.model }
            );
            if (order.length > 0) {
              const byOrder = order
                .map((i) => sources[i])
                .filter((s): s is RagResult => !!s)
                .concat(sources.filter((_, i) => !order.includes(i)));
              sources = byOrder.slice(0, 5);
            }
          } catch {
            /* rerank 失败静默,用原始顺序 */
          }
        }
        // 3) 拼上下文(片段内容,来源信息在发送后以来源卡展示)
        knowledgeContext = sources
          .map((s) => s.content)
          .join("\n\n---\n\n")
          .slice(0, 9000);
      } catch {}
    }
    setLastSources(sources);

    // Prepend quoted message (Chatbox Message Quoting) as markdown blockquote
    let finalContent = content;
    if (quoted?.content) {
      const quoteText = quoted.content.replace(/\n/g, "\n> ").slice(0, 600);
      const who = quoted.model
        ? `${quoted.model}`
        : quoted.role === "user"
          ? t("chat.quoteUser")
          : t("chat.quoteAI");
      finalContent = `> **${t("chat.quoteBy", { who })}**：\n> ${quoteText}\n\n${content}`;
    }
    onClearQuote?.();

    // 三层指令作用域(全局 < 项目/知识库 < 会话):合并后作为 systemPrompt 基础
    const activeConv = convStore.getActive();
    const settingsState = useSettingsStore.getState();
    let systemPrompt = skill?.systemPrompt || activeConv?.system_prompt || undefined;
    // 会话级系统提示词优先,否则按作用域合并:全局指令 + 命中当前知识库的项目指令
    if (!systemPrompt) {
      const scoped: string[] = [];
      if (settingsState.globalInstruction.trim()) {
        scoped.push(settingsState.globalInstruction.trim());
      }
      const proj = settingsState.projectInstructions.filter(
        (p) => !p.kbId || p.kbId === activeBaseId
      );
      for (const p of proj) {
        if (p.instruction.trim()) scoped.push(p.instruction.trim());
      }
      if (scoped.length > 0) systemPrompt = scoped.join("\n\n");
    }

    // Agent 记忆：技能绑定的记忆标签 → 注入长期记忆（稳定前缀，缓存友好）
    if (skill) {
      const memText = useMemoryStore
        .getState()
        .byTags(JSON.parse(skill.memory_tags || "[]") as string[]);
      if (memText) {
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memText}` : memText;
      }
    }

    // Agent 工具：技能绑定的 MCP 工具（tools_json = ["server/tool", ...]）→ 真实调用，
    // 结果注入 systemPrompt（此前 tools_json 从不执行，绑定工具是死字段）
    if (skill?.tools_json) {
      try {
        const toolRefs = JSON.parse(skill.tools_json) as string[];
        const servers = await mcpListServers();
        const outputs: string[] = [];
        let prev = "";
        for (const ref of toolRefs) {
          const [serverName, toolName] = ref.split("/");
          const server = servers.find(
            (s) => s.name === (serverName || "").trim() || s.id === (serverName || "").trim()
          );
          if (!server || !toolName) continue;
          try {
            const out = await runMcpStep(server, toolName.trim(), "", prev);
            outputs.push(`【工具 ${server.name}/${toolName.trim()}】\n${out}`);
            prev = out;
          } catch (e) {
            outputs.push(`【工具 ${server.name}/${toolName.trim()}】调用失败: ${e}`);
          }
        }
        if (outputs.length > 0) {
          const toolCtx = outputs.join("\n\n");
          systemPrompt = systemPrompt
            ? `${systemPrompt}\n\n【工具调用结果】\n${toolCtx}`
            : `【工具调用结果】\n${toolCtx}`;
        }
      } catch {
        /* tools_json 解析失败静默,不影响发送 */
      }
    }

    // @ 旧会话上下文(自动压缩):选择会话后,发送时拉取其最近消息作为上下文
    if (convMentions.length > 0) {
      const convs = convStore.conversations;
      const parts: string[] = [];
      for (const m of convMentions) {
        const c = convs.find((x) => x.id === m.id);
        if (!c) continue;
        // 自动压缩:最多取最近 8 条,每条截断 300 字(超出上下文上限不硬塞)
        const snippet = c.messages
          .slice(-8)
          .map((mm) => `${mm.role === "user" ? "用户" : "AI"}：${mm.content.slice(0, 300)}`)
          .join("\n");
        parts.push(`【引用会话 ${m.name}】\n${snippet}`);
      }
      if (parts.length > 0) {
        const refText = parts.join("\n\n");
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${refText}` : refText;
      }
    }

    // 角色扮演会话:三段式在 useChatStore.sendMessage 内组装(DeepSeek 缓存核心——
    // stableSystem 前缀恒定、世界书/摘要尾部),这里只保留基础提示词(技能/记忆/会话 prompt)
    void activeConv?.character_id;

    let targetModels = [
      model,
      ...compareList.map((m) => ({
        name: m.name,
        api_url: m.api_url,
        api_key: m.api_key,
        model: m.model,
      })),
    ];
    // A skill can pin a specific model; otherwise send to active + compare models
    if (skill?.model) {
      const pinned = models.find((m) => m.name === skill.model);
      if (pinned)
        targetModels = [
          {
            name: pinned.name,
            api_url: pinned.api_url,
            api_key: pinned.api_key,
            model: pinned.model,
          },
        ];
    }
    // F2: 技能可覆写温度（如「严谨代码」用低温）——发送时注入目标模型配置
    if (skill?.temperature != null) {
      targetModels = targetModels.map((m) => ({ ...m, temperature: skill.temperature as number }));
    }

    await sendMessage(finalContent, targetModels, systemPrompt, knowledgeContext);
    setSkill(null); // skills apply to a single message
    setConvMentions([]); // @ 会话引用单次生效
  }, [
    input,
    isStreaming,
    model,
    sendMessage,
    ragEnabled,
    activeBaseId,
    compareList,
    quoted,
    onClearQuote,
    skill,
    convMentions,
    ragRerankEnabled,
    ragMode,
    models,
    t,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // @ 菜单键盘导航:↑↓ 移动,Enter 选中,Esc 关闭
      if (mentionQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionHighlight((h) => h + 1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionHighlight((h) => Math.max(0, h - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionQuery(null);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          // 菜单打开时 Enter = 确认高亮项
          mentionRef.current?.selectHighlighted();
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, mentionQuery]
  );

  /** @ 菜单选中:技能/命令注入 systemPrompt;知识库切换 activeBaseId;会话加入引用 */
  const handleMentionSelect = useCallback(
    (sel: MentionSelection) => {
      if (sel.kind === "skill") {
        const s = skills.find((x) => x.id === sel.id);
        if (s) setSkill(s);
      } else if (sel.kind === "command") {
        // /命令 直接填入输入框
        setInput((p) => p.replace(/@\S*$/, "") + `/${sel.id} `);
      } else if (sel.kind === "knowledge") {
        setActiveKb(sel.id);
        setRagEnabled(true);
      } else if (sel.kind === "conversation") {
        // @ 旧会话引用:发送时自动压缩注入上下文
        setConvMentions((p) =>
          p.some((x) => x.id === sel.id) ? p : [...p, { id: sel.id, name: sel.name }]
        );
      }
      // 选中后移除 @ 触发词(保留其他输入)
      setInput((p) => p.replace(/@\S*\s*$/, " "));
      setMentionQuery(null);
      setMentionHighlight(0);
      textareaRef.current?.focus();
    },
    [skills, setActiveKb]
  );

  /** 输入变化:检测 @ 触发菜单(取 @ 后的单词作搜索词)+ `..` 触发 prompt 链 */
  const handleInputChange = useCallback((v: string) => {
    // `..` 触发 prompt 链选择器(移除触发词,避免输入框残留)
    if (/\s\.\.\s*$/.test(v) || v.trim() === "..") {
      setInput(v.replace(/\s*\.\.\s*$/, ""));
      setChainPick(loadChains());
      setMentionQuery(null);
      return;
    }
    setInput(v);
    const m = /@([^\s@]*)$/.exec(v);
    if (m) {
      setMentionQuery(m[1] || "");
      setMentionHighlight(0);
    } else {
      setMentionQuery(null);
    }
  }, []);

  /** 模型包装器选中:切模型 + 切知识库 + 注入指令(下一轮发送生效) */
  const applyWrapper = useCallback(
    (w: ModelWrapper) => {
      useSettingsStore.getState().setActiveModel(w.modelName);
      if (w.kbId) {
        setActiveKb(w.kbId);
        setRagEnabled(true);
      }
      setWrapperPick(false);
      textareaRef.current?.focus();
    },
    [setActiveKb]
  );
  const handleRunChain = useCallback(
    async (chain: PromptChain) => {
      if (!input.trim() || !model) return;
      const initial = input.trim();
      setInput("");
      setChainPick(null);
      setChainRunning(true);
      try {
        const lastContent = () => {
          const c = useConversationStore.getState().getActive();
          const asm = [...(c?.messages || [])].reverse().find((m) => m.role === "assistant");
          return asm?.content || "";
        };
        await runPromptChain(
          chain,
          initial,
          (content) => sendMessage(content, [model], undefined, undefined),
          lastContent
        );
      } catch (e) {
        console.error("Prompt chain error:", e);
      } finally {
        setChainRunning(false);
      }
    },
    [input, model, sendMessage]
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);

  return (
    <div className="border-t border-border p-3">
      <div className="max-w-3xl mx-auto flex gap-2 items-end">
        <div className="flex-1 relative">
          {/* Pending skill preview (injects system prompt on send) */}
          {skill && (
            <div className="mb-1.5 flex items-center gap-2 px-2 py-1.5 rounded-md border border-primary/30 bg-primary/5 text-xs">
              <Sparkles className="w-3 h-3 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-primary mb-0.5">
                  {t("chat.skillPreview", { name: skill.name })}
                  {skill.model ? ` · ${skill.model}` : ""}
                </div>
                <div className="text-muted-foreground truncate">
                  {skill.description || t("chat.skillNoDesc")}
                </div>
              </div>
              <button
                onClick={() => setSkill(null)}
                className="p-0.5 rounded hover:bg-muted text-muted-foreground shrink-0"
                title={t("settings.cancel")}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {/* Quoted message preview (Chatbox style) */}
          {quoted?.content && (
            <div className="mb-1.5 flex items-start gap-2 px-2 py-1.5 rounded-md border border-primary/30 bg-primary/5 text-xs">
              <span className="text-primary shrink-0 mt-0.5">❝</span>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-primary mb-0.5">
                  {t("chat.quoteBy", {
                    who:
                      quoted.model ||
                      (quoted.role === "user" ? t("chat.quoteUser") : t("chat.quoteAI")),
                  })}
                </div>
                <div className="text-muted-foreground line-clamp-2 whitespace-pre-wrap break-words">
                  {quoted.content.slice(0, 200)}
                  {quoted.content.length > 200 ? "…" : ""}
                </div>
              </div>
              <button
                onClick={onClearQuote}
                className="p-0.5 rounded hover:bg-muted text-muted-foreground shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {/* `@` 提及菜单(打字流内触发,技能/命令/知识库/最近会话) */}
          {mentionQuery !== null && (
            <AtMentionMenu
              ref={mentionRef}
              trigger={mentionQuery}
              highlight={mentionHighlight}
              onHighlightChange={setMentionHighlight}
              onSelect={handleMentionSelect}
            />
          )}
          {/* prompt 链选择器(`..` 触发,多步工作流) */}
          {chainPick && (
            <div className="absolute bottom-full mb-1 w-72 rounded-md border border-border bg-card shadow-lg z-20">
              <div className="px-2.5 py-1.5 text-[10px] text-muted-foreground border-b border-border">
                {t("chat.chainTitle")}
              </div>
              {chainPick.map((c) => (
                <button
                  key={c.id}
                  onClick={() => void handleRunChain(c)}
                  disabled={chainRunning || !input.trim()}
                  className="w-full px-2.5 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-40"
                >
                  <div className="font-medium text-foreground">{c.name}</div>
                  <div className="text-[10px] text-muted-foreground truncate">{c.description}</div>
                  <div className="text-[9px] text-primary mt-0.5">{c.steps.length} 步</div>
                </button>
              ))}
            </div>
          )}
          {/* 模型包装器选择(模型+知识库+指令 打包预设) */}
          {wrapperPick && (
            <div className="absolute bottom-full mb-1 w-64 rounded-md border border-border bg-card shadow-lg z-20">
              <div className="px-2.5 py-1.5 text-[10px] text-muted-foreground border-b border-border">
                {t("chat.wrapperTitle")}
              </div>
              {modelWrappers.length === 0 && (
                <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
                  {t("chat.wrapperEmpty")}
                </div>
              )}
              {modelWrappers.map((w) => (
                <button
                  key={w.id}
                  onClick={() => applyWrapper(w)}
                  className="w-full px-2.5 py-1.5 text-left text-xs hover:bg-muted"
                >
                  <div className="font-medium text-foreground">{w.name}</div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {w.description || w.modelName}
                  </div>
                </button>
              ))}
            </div>
          )}
          {/* RAG 来源卡(引用回链+摘录:点击可查原文文件) */}
          {lastSources.length > 0 && (
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-md border border-primary/20 bg-primary/5">
              <span className="text-[10px] text-primary shrink-0">{t("chat.sources")}</span>
              {lastSources.map((s, i) => (
                <span
                  key={s.chunk_id}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-card border border-border text-muted-foreground max-w-[180px] truncate"
                  title={`${s.file_name} — ${s.content.slice(0, 120)}`}
                >
                  {i + 1}. {s.file_name}
                </span>
              ))}
              <button
                onClick={() => setLastSources([])}
                className="p-0.5 rounded hover:bg-muted text-muted-foreground shrink-0"
                title={t("settings.cancel")}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          {/* 工具调用阶段化状态:初始化→调用中→读取结果→完成 */}
          {toolStatus && (
            <div className="mb-1.5 flex items-center gap-2 px-2 py-1.5 rounded-md border border-primary/30 bg-primary/5 text-xs">
              <span className="inline-block w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0" />
              <span className="text-primary">{toolStatus.stage}</span>
              <span className="text-[10px] text-muted-foreground truncate">
                {toolStatus.server}/{toolStatus.tool}
              </span>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder={ph}
            rows={1}
            disabled={!model || isStreaming}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
        </div>

        <div className="flex gap-1 shrink-0">
          {isStreaming ? (
            <button
              onClick={() => cancelGeneration()}
              className="p-2 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
              title="Stop (Esc)"
            >
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <>
              <button
                onClick={() => setShowCompare(!showCompare)}
                disabled={models.length < 2}
                className={`p-2 rounded-md border transition-colors disabled:opacity-30 ${
                  compareModels.length > 0
                    ? "bg-primary/20 border-primary text-primary"
                    : "border-input bg-background text-muted-foreground hover:text-foreground"
                }`}
                title={
                  compareModels.length > 0
                    ? t("chat.compareCount", { n: 1 + compareList.length })
                    : t("chat.compareTitle")
                }
              >
                <Layers className="w-4 h-4" />
              </button>
              <button
                onClick={() => setRagEnabled(!ragEnabled)}
                disabled={!activeBaseId}
                className={`p-2 rounded-md border transition-colors disabled:opacity-30 ${
                  ragEnabled
                    ? "bg-primary/20 border-primary text-primary"
                    : "border-input bg-background text-muted-foreground hover:text-foreground"
                }`}
                title={
                  activeBaseId
                    ? ragEnabled
                      ? t("chat.ragOn")
                      : t("chat.ragOff")
                    : t("chat.ragNoKB")
                }
              >
                <Database className="w-4 h-4" />
              </button>
              <button
                onClick={() => setShowSkills(!showSkills)}
                disabled={skills.length === 0}
                className={`p-2 rounded-md border transition-colors disabled:opacity-30 ${
                  skill
                    ? "bg-primary/20 border-primary text-primary"
                    : "border-input bg-background text-muted-foreground hover:text-foreground"
                }`}
                title={skill ? t("chat.skillPick") : t("chat.skillPick")}
              >
                <Sparkles className="w-4 h-4" />
              </button>
              <button
                onClick={() => setWrapperPick(!wrapperPick)}
                disabled={modelWrappers.length === 0}
                className={`p-2 rounded-md border transition-colors disabled:opacity-30 ${
                  wrapperPick
                    ? "bg-primary/20 border-primary text-primary"
                    : "border-input bg-background text-muted-foreground hover:text-foreground"
                }`}
                title={t("chat.wrapper")}
              >
                <Package className="w-4 h-4" />
              </button>
              <button
                onClick={() => useChatStore.getState().compressContext()}
                disabled={!model}
                className="p-2 rounded-md border border-input bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                title={t("chat.compress")}
              >
                <FileText className="w-4 h-4" />
              </button>
              <button
                onClick={regenerate}
                disabled={!model}
                className="p-2 rounded-md border border-input bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                title="Regenerate"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              <button
                onClick={handleSend}
                disabled={!input.trim() || !model}
                className="p-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                title="Send (Enter)"
              >
                <Send className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Slash command hints */}
      {input.startsWith("/") && (
        <div className="max-w-3xl mx-auto mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t("chat.commands")}</span>
          {SLASH_COMMANDS.map((c) => (
            <button
              key={c.cmd}
              onClick={() => {
                setInput("/" + c.cmd + " ");
                textareaRef.current?.focus();
              }}
              className="px-2 py-0.5 rounded border border-input bg-background text-muted-foreground hover:text-foreground hover:border-primary/50"
              title={c.description}
            >
              /{c.cmd}
            </button>
          ))}
        </div>
      )}

      {/* Input token estimation (Chatbox style) */}
      {!input.startsWith("/") && input.trim() && (
        <div className="max-w-3xl mx-auto mt-1 text-right text-[10px] text-muted-foreground">
          ~{countTokens(input)} tokens
        </div>
      )}

      {/* RAG 检索选项(双模式分流 + rerank 重排) */}
      {ragEnabled && activeBaseId && (
        <div className="max-w-3xl mx-auto mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t("chat.ragMode")}</span>
          {(["hybrid", "bm25", "vector"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setRagMode(m)}
              className={`px-2 py-0.5 rounded border transition-colors ${
                ragMode === m
                  ? "bg-primary/20 border-primary text-primary"
                  : "border-input bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              {m === "hybrid" ? t("chat.ragModeHybrid") : m === "bm25" ? "BM25" : "向量"}
            </button>
          ))}
          <label
            className="flex items-center gap-1 text-[11px] text-muted-foreground cursor-pointer"
            title={t("chat.ragRerankHint")}
          >
            <input
              type="checkbox"
              checked={ragRerankEnabled}
              onChange={(e) => setRagRerankEnabled(e.target.checked)}
              className="accent-[#1A6FB5]"
            />
            {t("chat.ragRerank")}
          </label>
        </div>
      )}

      {/* Compare (一问多答) model picker */}
      {showCompare && models.length > 1 && (
        <div className="max-w-3xl mx-auto mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t("chat.compare")}</span>
          <span className="px-2 py-0.5 rounded bg-primary/20 border border-primary text-primary">
            {model?.name || activeModel}
            {t("chat.primary")}
          </span>
          {models
            .filter((m) => m.name !== activeModel)
            .map((m) => {
              const on = compareModels.includes(m.name);
              return (
                <button
                  key={m.name}
                  onClick={() => toggleCompare(m.name)}
                  className={`px-2 py-0.5 rounded border transition-colors ${
                    on
                      ? "bg-primary/20 border-primary text-primary"
                      : "border-input bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {on ? "☑" : "☐"} {m.name}
                </button>
              );
            })}
          {compareModels.length > 0 && (
            <span className="text-muted-foreground ml-1">
              {t("chat.compareCount", { n: 1 + compareList.length })}
            </span>
          )}
        </div>
      )}

      {/* Skill picker */}
      {showSkills && skills.length > 0 && (
        <div className="max-w-3xl mx-auto mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t("chat.skillsLabel")}</span>
          {skills.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setSkill(s);
                setShowSkills(false);
              }}
              className={`px-2 py-0.5 rounded border transition-colors ${
                skill?.id === s.id
                  ? "bg-primary/20 border-primary text-primary"
                  : "border-input bg-background text-muted-foreground hover:text-foreground"
              }`}
              title={s.description || s.systemPrompt}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One MCP tool-call step: resolve tool, substitute {prev}, call it. */
async function runMcpStep(
  server: McpServerDto,
  toolName: string,
  argText: string,
  prev: string
): Promise<string> {
  const tools = await mcpListTools(server.id);
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    return t("chat.mcpNoTools", {
      s: server.name,
      t: toolName,
      list: tools.map((t) => t.name).join("、") || t("chat.mcpNone"),
    });
  }
  let argsObj: Record<string, unknown> = {};
  if (argText) {
    let tpl = argText;
    if (tpl.includes("{prev}")) tpl = tpl.split("{prev}").join(prev);
    try {
      argsObj = JSON.parse(tpl);
    } catch {
      argsObj = { query: tpl };
    }
  }
  const r = await mcpCallTool(server.id, tool.name, argsObj);
  return r.content || t("chat.mcpEmptyResult");
}
