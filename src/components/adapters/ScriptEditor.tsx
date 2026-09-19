import { useState } from "react";
import { Play, RotateCcw } from "lucide-react";

interface Props {
  title: string;
  script: string;
  onChange: (script: string) => void;
  placeholder?: string;
}

const SCRIPT_EXAMPLES: Record<string, string> = {
  beforeRequest: `// Pre-request script
// Modify ctx before sending to API
// Available: ctx.headers, ctx.body, ctx.url

ctx.headers["X-Custom-Header"] = "value";
ctx.body.temperature = 0.8;
`,
  parseChunk: `// SSE chunk parser
// Parse each SSE line and return { content, done }
// Available: line (string), buffer (string)

const json = JSON.parse(line);
return {
  content: json.choices?.[0]?.delta?.content || "",
  done: json.choices?.[0]?.finish_reason !== null
};
`,
};

export function ScriptEditor({ title, script, onChange, placeholder }: Props) {
  const [log, setLog] = useState<string[]>([]);

  const runTest = () => {
    setLog([]);
    try {
      const fn = new Function(
        "line",
        "buffer",
        "ctx",
        script + "\nreturn typeof parse === 'function' ? parse(line, buffer) : null;"
      );
      const result = fn('{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}', "", {
        headers: {},
        body: {},
      });
      if (result) {
        setLog((l) => [...l, `✓ Output: ${JSON.stringify(result)}`]);
      } else {
        setLog((l) => [
          ...l,
          "⚠ No parse() function found. Define function parse(line, buffer) { ... }",
        ]);
      }
    } catch (e) {
      setLog((l) => [...l, `✗ Error: ${String(e)}`]);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">{title}</span>
        <div className="flex gap-1">
          <button
            onClick={runTest}
            className="px-2 py-0.5 text-[10px] bg-primary/10 text-primary rounded hover:bg-primary/20 flex items-center gap-1"
          >
            <Play className="w-3 h-3" /> Test
          </button>
          <button
            onClick={() => setLog([])}
            className="px-2 py-0.5 text-[10px] border border-border rounded hover:bg-muted text-muted-foreground flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" /> Clear
          </button>
        </div>
      </div>

      <textarea
        value={script}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        spellCheck={false}
        className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder={placeholder || "// Write your script here..."}
      />

      {/* Log output */}
      {log.length > 0 && (
        <div className="p-2 bg-muted/50 border border-border rounded-md max-h-24 overflow-y-auto">
          {log.map((line, i) => (
            <div key={i} className="text-[10px] font-mono text-muted-foreground">
              {line}
            </div>
          ))}
        </div>
      )}

      {/* Quick insert */}
      <div className="flex gap-1 flex-wrap">
        <span className="text-[10px] text-muted-foreground mr-1">Quick:</span>
        {Object.entries(SCRIPT_EXAMPLES).map(([key, code]) => (
          <button
            key={key}
            onClick={() => onChange(code)}
            className="px-2 py-0.5 text-[10px] border border-border rounded hover:bg-muted text-muted-foreground"
          >
            {key === "beforeRequest" ? "Pre-request" : "SSE Parser"}
          </button>
        ))}
      </div>
    </div>
  );
}

export { SCRIPT_EXAMPLES };
