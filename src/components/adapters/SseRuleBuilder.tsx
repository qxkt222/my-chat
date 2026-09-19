import { useState } from "react";
import { Eye, Code2 } from "lucide-react";

interface Props {
  dataPrefix: string;
  doneMarker: string;
  contentPath: string;
  onPrefixChange: (v: string) => void;
  onDoneChange: (v: string) => void;
  onPathChange: (v: string) => void;
}

const COMMON_FORMATS = [
  {
    name: "OpenAI / Compatible",
    prefix: "data: ",
    done: "[DONE]",
    path: "$.choices[0].delta.content",
  },
  {
    name: "Plain JSON Lines",
    prefix: "",
    done: "",
    path: "$.text",
  },
  {
    name: "Custom SSE",
    prefix: "data: ",
    done: "DONE",
    path: "$.result.text",
  },
];

export function SseRuleBuilder({
  dataPrefix,
  doneMarker,
  contentPath,
  onPrefixChange,
  onDoneChange,
  onPathChange,
}: Props) {
  const [showTest, setShowTest] = useState(false);
  const [testLine, setTestLine] = useState(
    'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}'
  );
  const [testResult, setTestResult] = useState("");

  const applyPreset = (preset: (typeof COMMON_FORMATS)[0]) => {
    onPrefixChange(preset.prefix);
    onDoneChange(preset.done);
    onPathChange(preset.path);
  };

  const runTest = () => {
    let line = testLine;

    // Strip prefix
    if (dataPrefix && line.startsWith(dataPrefix)) {
      line = line.slice(dataPrefix.length);
    }

    // Check done
    if (doneMarker && line.includes(doneMarker)) {
      setTestResult("✓ Done marker detected");
      return;
    }

    // Try JSON parse + path extraction
    try {
      const json = JSON.parse(line);
      const parts = contentPath
        .replace(/^\$\.?/, "")
        .split(".")
        .map((p) => {
          const m = p.match(/^(\w+)\[(\d+)\]$/);
          const key = m?.[1] ?? "";
          return m
            ? ([key, parseInt(m[2] ?? "0", 10)] as [string, number])
            : ([p, null] as [string, null]);
        });

      let current: unknown = json;
      for (const [key, idx] of parts) {
        if (idx !== null) {
          current = (current as Record<string, unknown>)?.[key];
          current = (current as unknown[])?.[idx];
        } else {
          current = (current as Record<string, unknown>)?.[key];
        }
        if (current === undefined || current === null) {
          setTestResult("✗ Path not found in JSON");
          return;
        }
      }
      setTestResult(`✓ Extracted: "${String(current)}"`);
    } catch {
      setTestResult("✗ Invalid JSON");
    }
  };

  return (
    <div className="space-y-3">
      {/* Presets */}
      <div className="space-y-1">
        <span className="text-[10px] text-muted-foreground">Quick presets:</span>
        <div className="flex gap-1 flex-wrap">
          {COMMON_FORMATS.map((f) => (
            <button
              key={f.name}
              onClick={() => applyPreset(f)}
              className="px-2 py-0.5 text-[10px] border border-border rounded hover:bg-primary/10 hover:text-primary transition-colors"
            >
              {f.name}
            </button>
          ))}
        </div>
      </div>

      {/* Rules */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Data prefix</label>
          <input
            type="text"
            value={dataPrefix}
            onChange={(e) => onPrefixChange(e.target.value)}
            placeholder="data: "
            className="w-full px-2 py-1 text-xs font-mono bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Done marker</label>
          <input
            type="text"
            value={doneMarker}
            onChange={(e) => onDoneChange(e.target.value)}
            placeholder="[DONE]"
            className="w-full px-2 py-1 text-xs font-mono bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">JSONPath</label>
          <input
            type="text"
            value={contentPath}
            onChange={(e) => onPathChange(e.target.value)}
            placeholder="$.choices[0].delta.content"
            className="w-full px-2 py-1 text-xs font-mono bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {/* Live test */}
      <div>
        <button
          onClick={() => setShowTest(!showTest)}
          className="flex items-center gap-1 text-[10px] text-primary hover:underline"
        >
          <Code2 className="w-3 h-3" />
          {showTest ? "Hide" : "Show"} live test
        </button>
        {showTest && (
          <div className="mt-2 space-y-2 p-3 bg-muted/30 border border-border rounded-md">
            <div className="flex gap-2">
              <input
                type="text"
                value={testLine}
                onChange={(e) => setTestLine(e.target.value)}
                className="flex-1 px-2 py-1 text-xs font-mono bg-background border border-border rounded"
              />
              <button
                onClick={runTest}
                className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 flex items-center gap-1"
              >
                <Eye className="w-3 h-3" /> Test
              </button>
            </div>
            {testResult && (
              <div
                className={`text-xs font-mono ${
                  testResult.startsWith("✓") ? "text-green-500" : "text-destructive"
                }`}
              >
                {testResult}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
