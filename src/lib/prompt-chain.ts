// lib/prompt-chain.ts — prompt 链(多步工作流)
//
// 外部参考:AI Toolbox 的 prompt chain(最多 10 步、每步等前一轮回复、占位符填充)。
// 实现:每条链 = 有序模板步骤;运行链时第一步的 {{input}} 用玩家输入填充,
// 后续步骤的 {{input}} 用上一步的 AI 回复填充(发送链路用 useChatStore.sendMessage,
// 它返回的 Promise 在所有流完成时 resolve → 可顺序 await 串联)。

export interface PromptChain {
  id: string;
  name: string;
  description: string;
  /** 有序模板步骤,支持 {{input}} 占位符 */
  steps: string[];
}

const CHAIN_KEY = "prompt_chains";

/** 内置链:翻译 → 润色 → 排版(多步工作流示例) */
const BUILTIN_CHAINS: PromptChain[] = [
  {
    id: "translate-polish-format",
    name: "翻译→润色→排版",
    description: "先翻译成中文,再润色,最后按 markdown 排版",
    steps: [
      "把下面的内容翻译成通顺的中文,只输出译文:\n\n{{input}}",
      "润色上面的译文,使其更自然、更专业,只输出润色后的文本:\n\n{{input}}",
      "把润色后的文本用 markdown 排版(加标题/列表/代码块),只输出排版结果:\n\n{{input}}",
    ],
  },
  {
    id: "outline-draft-polish",
    name: "提纲→成稿→精修",
    description: "先列提纲,再扩写成稿,最后精修",
    steps: [
      "为下面的主题列一个结构化提纲(只输出提纲):\n\n{{input}}",
      "根据上面的提纲扩写一篇完整文章(只输出文章):\n\n{{input}}",
      "精修上面这篇文章,纠正逻辑/语法,提升可读性(只输出最终版):\n\n{{input}}",
    ],
  },
];

/** 加载全部链(内置 + 自定义,localStorage) */
export function loadChains(): PromptChain[] {
  try {
    const custom = JSON.parse(localStorage.getItem(CHAIN_KEY) || "[]") as PromptChain[];
    return [...BUILTIN_CHAINS, ...custom.filter((c) => c && c.id && c.steps?.length > 0)];
  } catch {
    return BUILTIN_CHAINS;
  }
}

/** 保存自定义链(内置链不可改,合并去重) */
export function saveChains(custom: PromptChain[]): void {
  localStorage.setItem(CHAIN_KEY, JSON.stringify(custom));
}

/**
 * 运行一条链:顺序执行每个步骤,{{input}} 逐步替换为上一步输出。
 * sendMessage 的 Promise 在所有流完成时 resolve → 可 await 串联。
 * 返回最终输出;任一步失败即中止。
 */
export async function runPromptChain(
  chain: PromptChain,
  initialInput: string,
  send: (content: string) => Promise<void>,
  getLastAssistantContent: () => string
): Promise<string> {
  let acc = initialInput;
  for (let i = 0; i < chain.steps.length; i++) {
    const step = chain.steps[i];
    if (!step || !step.trim()) continue;
    const content = step.split("{{input}}").join(acc);
    await send(content);
    // 上一步输出 = 该会话最后一条 assistant 消息
    const last = getLastAssistantContent();
    if (last) acc = last;
  }
  return acc;
}
