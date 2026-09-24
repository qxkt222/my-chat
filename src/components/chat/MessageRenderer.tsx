import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useState, useCallback, memo, useMemo } from "react";
import type { ReactNode } from "react";
import { Check, Copy, MessageSquarePlus } from "lucide-react";
import { useT } from "@/lib/i18n";
import { fireCodeInsert } from "@/lib/code-insert";
import { logDiag } from "@/lib/tauri";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Components } from "react-markdown";

interface Props {
  content: string;
}

/**
 * Markdown 渲染器。流式期间 content 每个 token 都在变，这里用 useMemo 缓存
 * 解析结果（同一 content 不重复跑 react-markdown + rehype-highlight），
 * 并用 memo 保证无关气泡不因父组件重渲染而重新解析。
 */
export const MessageRenderer = memo(function MessageRenderer({ content }: Props) {
  const rendered = useMemo(
    () => (
      <div className="markdown-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={markdownComponents}
        >
          {content}
        </ReactMarkdown>
      </div>
    ),
    [content]
  );
  return rendered;
});

/**
 * 从 React 节点树里抽出纯文本。
 *
 * 为什么需要它：`rehype-highlight` 会把代码块内容换成 `<span class="hljs-*">` 元素，
 * 于是 `components.code` 收到的 `children` 是**元素数组而不是字符串**。
 * 旧代码直接 `String(children)`，结果每个代码块都渲染成
 * `[object Object], a = ,[object Object],;` —— 这个 bug 是本轮新加的组件冒烟
 * 测试抓出来的（此前 47 个组件零自动化测试，谁也没看见）。
 *
 * 抽出的纯文本用于「复制」与「插入输入框」；渲染依旧用原 `children` 以保住高亮。
 */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return (node as ReactNode[]).map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    const el = node as { props?: { children?: ReactNode } };
    return extractText(el.props?.children);
  }
  return "";
}

function CodeBlock({
  language,
  code,
  highlighted,
}: {
  language: string;
  code: string;
  highlighted: ReactNode;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  const handleInsert = useCallback(() => {
    fireCodeInsert(code);
  }, [code]);

  return (
    <div className="relative group my-2">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted rounded-t-md border border-border border-b-0">
        <span className="text-xs text-muted-foreground">{language || "text"}</span>
        <span className="flex items-center gap-0.5">
          {/* 一键插入到输入框(引用该代码块继续加工) */}
          <button
            onClick={handleInsert}
            className="p-1 rounded hover:bg-muted-foreground/20 text-muted-foreground transition-colors"
            title={t("chat.insertCode")}
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleCopy}
            className="p-1 rounded hover:bg-muted-foreground/20 text-muted-foreground transition-colors"
            title={t("chat.copy")}
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-green-500" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </span>
      </div>
      <pre className="rounded-b-md border border-border border-t-0 !mt-0 !mb-0">
        {/* 渲染 rehype-highlight 生成的节点（保住 hljs-* 类与着色），
            而不是纯文本字符串 —— 用纯文本会把语法高亮整个丢掉 */}
        <code className={`language-${language || "text"}`}>{highlighted}</code>
      </pre>
    </div>
  );
}

const markdownComponents: Components = {
  // Tauri 的 webview 里点 <a> 会把**应用界面本身**导航走（没有返回按钮，
  // 只能重启），所以这里拦下默认导航，交给系统浏览器打开。
  a({ href, children }) {
    return (
      <a
        href={href}
        className="text-primary underline underline-offset-2 hover:no-underline"
        onClick={(e) => {
          e.preventDefault();
          if (!href) return;
          openUrl(href).catch((err: unknown) => {
            logDiag(`openUrl failed: ${String(err)} href=${href}`);
          });
        }}
      >
        {children}
      </a>
    );
  },
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    // ⚠️ 不能 String(children)：高亮后 children 是元素数组，字符串化会得到
    //    "[object Object], a = ,…"（真 bug，组件测试抓到的）
    const codeStr = extractText(children).replace(/\n$/, "");

    // Inline code
    if (!match && !codeStr.includes("\n")) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }

    // Code block：纯文本给「复制 / 插入输入框」，原 children 给渲染（保高亮）
    return (
      <CodeBlock language={match ? (match[1] ?? "") : ""} code={codeStr} highlighted={children} />
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
};

export default MessageRenderer;
