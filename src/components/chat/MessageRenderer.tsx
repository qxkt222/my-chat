import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useState, useCallback, memo, useMemo } from "react";
import { Check, Copy, MessageSquarePlus } from "lucide-react";
import { useT } from "@/lib/i18n";
import { fireCodeInsert } from "@/lib/code-insert";
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

function CodeBlock({ language, code }: { language: string; code: string }) {
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
        <code className={`language-${language || "text"}`}>{code}</code>
      </pre>
    </div>
  );
}

const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    const codeStr = String(children).replace(/\n$/, "");

    // Inline code
    if (!match && !String(children).includes("\n")) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }

    // Code block
    return <CodeBlock language={match ? (match[1] ?? "") : ""} code={codeStr} />;
  },
  pre({ children }) {
    return <>{children}</>;
  },
};

export default MessageRenderer;
